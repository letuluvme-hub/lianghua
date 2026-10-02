import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBSCRIPTION_METADATA, storageMode, assertSubscriptionOperation,
  getSubscriptionStorageStatus, readSubscription, writeSubscription, deleteSubscription,
  listSubscriptionRecords, acquireDelivery, prepareDelivery, isDeliveryCurrent,
  completeDelivery, releaseDelivery, readLegacySubscriptionPage,
  beginSubscriptionImport, stageSubscriptionImportPage, promoteSubscriptionImportPage,
  getSubscriptionImportStatus, verifySubscriptionImport,
} from '../subscription-store.js';
import { createD1, createKV } from './helpers/d1-sqlite.mjs';

const daily = (email = 'a@example.test', extras = {}) => ({ email, stocks: ['AAPL'], period: 20, sendTime: '16:00', multipliers: [1, 2, 3], timezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00Z', lastSentDate: null, ...extras });
const alert = (email = 'a@example.test', extras = {}) => ({ email, stocks: ['AAPL'], period: 20, multiplier: 2, condition: 'outside', timezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00Z', lastAlertKeys: [], lastAlertAt: null, ...extras });
const patch = { lastSentDate: '2026-10-01' };
function environment(t, options = {}) {
  const DB = createD1({ ready: true, ...options }); t.after(() => DB.close());
  return { DB, SUBSCRIPTIONS: createKV(), SUBSCRIPTION_STORAGE_MODE: 'd1' };
}
async function prepared(env, kind = 'daily', record = null, state = patch) {
  record ??= await writeSubscription(env, kind, kind === 'daily' ? daily() : alert());
  const claim = await acquireDelivery(env, kind, record);
  assert.ok(claim); assert.equal(await prepareDelivery(env, kind, record, claim, state), true);
  return { record, claim };
}
function code(expected) { return (error) => error.code === expected && error.status === 503 && !error.message.includes('SELECT'); }

test('storage modes default legacy, reject unknown and pause only handover mutations/dispatch', async () => {
  assert.equal(storageMode({}), 'legacy'); assert.throws(() => storageMode({ SUBSCRIPTION_STORAGE_MODE: 'typo' }), code('SUBSCRIPTION_INVALID_MODE'));
  const env = { SUBSCRIPTIONS: createKV([['sub:a@example.test', daily()]]), SUBSCRIPTION_STORAGE_MODE: 'handover' };
  assert.equal(assertSubscriptionOperation(env, 'read'), 'handover');
  assert.deepEqual(await readSubscription(env, 'daily', 'a@example.test'), daily());
  assert.deepEqual(await listSubscriptionRecords(env, 'daily'), [daily()]);
  for (const operation of ['write', 'mutation', 'delete', 'dispatch']) assert.throws(() => assertSubscriptionOperation(env, operation), code('SUBSCRIPTION_HANDOVER'));
  await assert.rejects(writeSubscription(env, 'daily', daily()), code('SUBSCRIPTION_HANDOVER'));
  await assert.rejects(deleteSubscription(env, 'daily', daily().email), code('SUBSCRIPTION_HANDOVER'));
  assert.equal(env.SUBSCRIPTIONS.calls.some((call) => call.type === 'put' || call.type === 'delete'), false);
});

test('explicit readiness, missing schema/binding and D1 outage fail closed without KV fallback or DDL', async (t) => {
  const env = environment(t, { ready: false });
  assert.equal((await getSubscriptionStorageStatus(env)).ready, false);
  for (const operation of [() => readSubscription(env, 'daily', daily().email), () => writeSubscription(env, 'daily', daily()), () => deleteSubscription(env, 'daily', daily().email), () => listSubscriptionRecords(env, 'daily')]) await assert.rejects(operation(), code('SUBSCRIPTION_NOT_READY'));
  await assert.rejects(readSubscription({ ...env, DB: null }, 'daily', daily().email), code('SUBSCRIPTION_DB_MISSING'));
  const missing = createD1({ migrate: false }); t.after(() => missing.close());
  await assert.rejects(readSubscription({ ...env, DB: missing }, 'daily', daily().email), code('SUBSCRIPTION_DB_UNAVAILABLE'));
  assert.equal(missing.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  env.DB.failSQL = /SELECT/;
  await assert.rejects(readSubscription(env, 'daily', daily().email), code('SUBSCRIPTION_DB_UNAVAILABLE'));
  assert.equal(env.SUBSCRIPTIONS.calls.length, 0);
});

test('authoritative config upsert preserves delivery state and exposes only original JSON shape', async (t) => {
  const env = environment(t);
  const { record, claim } = await prepared(env);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), true);
  const saved = await writeSubscription(env, 'daily', daily(undefined, { stocks: ['NVDA'], period: 30, lastSentDate: '1900-01-01' }));
  assert.equal(saved.lastSentDate, '2026-10-01'); assert.deepEqual(saved.stocks, ['NVDA']);
  assert.equal(saved[SUBSCRIPTION_METADATA].configVersion, 2); assert.equal(saved[SUBSCRIPTION_METADATA].stateVersion, 1);
  assert.equal(JSON.stringify(saved).includes('configVersion'), false);
  assert.equal(Object.getOwnPropertyDescriptor(saved, SUBSCRIPTION_METADATA).enumerable, false);
  assert.deepEqual(await readSubscription(env, 'daily', saved.email), saved);
  assert.equal(await readSubscription(env, 'alert', saved.email), null);
  assert.equal(env.SUBSCRIPTIONS.calls.length, 0);
});

test('competing claims CAS once and a changed config invalidates stale pre-send work', async (t) => {
  const env = environment(t); const record = await writeSubscription(env, 'daily', daily());
  const claims = await Promise.all([acquireDelivery(env, 'daily', record), acquireDelivery(env, 'daily', record)]);
  assert.equal(claims.filter(Boolean).length, 1); const claim = claims.find(Boolean);
  const edited = await writeSubscription(env, 'daily', daily(undefined, { stocks: ['MSFT'] }));
  assert.equal(await prepareDelivery(env, 'daily', record, claim, patch), false);
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), false);
  assert.equal(await releaseDelivery(env, 'daily', record, claim), true);
  assert.ok(await acquireDelivery(env, 'daily', edited));
});

test('configuration edit during accepted delivery is preserved by state-only completion', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), true);
  await writeSubscription(env, 'daily', daily(undefined, { stocks: ['MSFT'], period: 75 }));
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), false);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), true);
  const current = await readSubscription(env, 'daily', record.email);
  assert.deepEqual(current.stocks, ['MSFT']); assert.equal(current.period, 75); assert.equal(current.lastSentDate, patch.lastSentDate);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), false);
});

test('physical unsubscribe plus recreate uses new generation; stale sends never resurrect or alter new row', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  assert.equal(await deleteSubscription(env, 'daily', record.email), true);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM subscriptions').get().n, 0);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), false);
  assert.equal(await readSubscription(env, 'daily', record.email), null);
  const recreated = await writeSubscription(env, 'daily', daily(undefined, { lastSentDate: '1900-01-01' }));
  assert.notEqual(recreated[SUBSCRIPTION_METADATA].generation, record[SUBSCRIPTION_METADATA].generation);
  assert.equal(recreated.lastSentDate, null);
  const replacement = await acquireDelivery(env, 'daily', recreated); assert.ok(replacement);
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), false);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), false);
  assert.equal(await releaseDelivery(env, 'daily', record, claim, { unsent: true }), false);
  assert.equal(await prepareDelivery(env, 'daily', recreated, replacement, patch), true);
});

test('expired unprepared claims are reclaimable; old owner cannot release replacement lease', async (t) => {
  const env = environment(t); const record = await writeSubscription(env, 'daily', daily());
  const old = await acquireDelivery(env, 'daily', record);
  env.DB.sqlite.exec('UPDATE subscriptions SET lease_until=0');
  const replacement = await acquireDelivery(env, 'daily', record);
  assert.ok(replacement); assert.notEqual(old.owner, replacement.owner); assert.notEqual(old.attemptId, replacement.attemptId);
  assert.equal(await releaseDelivery(env, 'daily', record, old), false);
  assert.equal(await prepareDelivery(env, 'daily', record, old, patch), false);
  assert.equal(await releaseDelivery(env, 'daily', record, replacement), true);
});

test('ambiguous prepared attempt fails closed after lease expiry and persists its stable intent', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  const row = env.DB.sqlite.prepare('SELECT * FROM subscriptions').get();
  assert.equal(row.attempt_id, claim.attemptId); assert.equal(row.prepared_state_json, JSON.stringify(patch));
  assert.equal(claim.idempotencyKey, `subscription-${claim.attemptId}`);
  assert.equal(await releaseDelivery(env, 'daily', record, claim), false);
  env.DB.sqlite.exec('UPDATE subscriptions SET lease_until=0');
  assert.equal(await acquireDelivery(env, 'daily', record), null);
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), false);
  // Late provider success can commit despite expiry; no replacement was allowed.
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), true);
});

test('prepared-but-never-sent path can explicitly release; mismatched state cannot complete', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  assert.equal(await completeDelivery(env, 'daily', record, claim, { lastSentDate: '2026-10-02' }), false);
  assert.equal(await releaseDelivery(env, 'daily', record, claim, { unsent: true }), true);
  assert.ok(await acquireDelivery(env, 'daily', record));
});

test('alert state completion is separate CAS; configuration cannot replace it', async (t) => {
  const env = environment(t); const state = { alertKeys: ['first', 'first', 'second'], lastAlertAt: '2026-10-01T00:00:00Z' };
  const { record, claim } = await prepared(env, 'alert', null, state);
  await writeSubscription(env, 'alert', alert(undefined, { multiplier: 3, lastAlertKeys: ['bogus'] }));
  assert.equal(await completeDelivery(env, 'alert', record, claim, state), true);
  const current = await readSubscription(env, 'alert', record.email);
  assert.equal(current.multiplier, 3); assert.deepEqual(current.lastAlertKeys, ['first', 'second']);
  const next = await prepared(env, 'alert', current, state);
  env.DB.sqlite.exec('UPDATE subscriptions SET state_version=state_version+1');
  assert.equal(await completeDelivery(env, 'alert', current, next.claim, state), false);
  assert.equal(await isDeliveryCurrent(env, 'alert', current, next.claim), false);
});

test('every authoritative SQL query starts on primary, including last send guard', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  assert.equal(await isDeliveryCurrent(env, 'daily', record, claim), true);
  const queries = env.DB.calls.filter((call) => call.sql);
  assert.equal(new Set(queries.map((call) => call.session)).size, queries.length);
  assert.ok(queries.every((call) => call.session));
  const fallback = environment(t, { sessions: false });
  const saved = await writeSubscription(fallback, 'daily', daily());
  assert.equal((await readSubscription(fallback, 'daily', saved.email)).email, saved.email);
});

test('D1 listing uses complete bounded keyset pagination and only subscription records', async (t) => {
  const env = environment(t);
  for (let n = 0; n < 205; n += 1) await writeSubscription(env, 'daily', daily(`a${String(n).padStart(3, '0')}@example.test`));
  await writeSubscription(env, 'alert', alert());
  const records = await listSubscriptionRecords(env, 'daily');
  assert.equal(records.length, 205); assert.equal(new Set(records.map((record) => record.email)).size, 205);
  const pages = env.DB.calls.filter((call) => call.sql?.includes('ORDER BY email LIMIT'));
  assert.equal(pages.length, 3); assert.ok(pages.every((page) => page.args[2] === 100));
  assert.equal(env.SUBSCRIPTIONS.calls.length, 0);
});

test('legacy bounded complete pagination skips malformed values; opaque empty pages and loops handled', async () => {
  const entries = Array.from({ length: 205 }, (_, n) => [`sub:a${n}@example.test`, daily(`a${n}@example.test`)]);
  entries.push(['sub:bad@example.test', '{oops'], ['watch:a@example.test', '{}']);
  const env = { SUBSCRIPTIONS: createKV(entries, { pageSize: 17 }) };
  assert.equal((await listSubscriptionRecords(env, 'daily')).length, 205);
  assert.equal(env.SUBSCRIPTIONS.calls.filter((call) => call.type === 'list').length, 13);
  const saved = daily(); await writeSubscription(env, 'daily', saved); const claim = await acquireDelivery(env, 'daily', saved);
  assert.equal(await prepareDelivery(env, 'daily', saved, claim, patch), true);
  assert.equal(await isDeliveryCurrent(env, 'daily', saved, claim), true);
  assert.equal(await completeDelivery(env, 'daily', saved, claim, patch), true);
  assert.equal((await readSubscription(env, 'daily', saved.email)).lastSentDate, patch.lastSentDate);
  assert.equal(await deleteSubscription(env, 'daily', saved.email), true);
  const empty = { SUBSCRIPTIONS: { list: async ({ cursor }) => cursor ? { keys: [], list_complete: true } : { keys: [], list_complete: false, cursor: 'opaque' } } };
  assert.deepEqual(await listSubscriptionRecords(empty, 'daily'), []);
  const loop = { SUBSCRIPTIONS: { list: async () => ({ keys: [], list_complete: false, cursor: 'same' }) } };
  await assert.rejects(listSubscriptionRecords(loop, 'daily'), code('SUBSCRIPTION_INVALID_KV_CURSOR'));
});

test('bounded resumable staging import requires handover, verifies state and blocks premature ready flag', async (t) => {
  const env = environment(t, { ready: false });
  await assert.rejects(beginSubscriptionImport(env), code('SUBSCRIPTION_IMPORT_REQUIRES_HANDOVER'));
  env.SUBSCRIPTION_STORAGE_MODE = 'handover';
  env.SUBSCRIPTIONS = createKV([
    ['sub:a@example.test', daily(undefined, { lastSentDate: '2026-09-30' })],
    ['sub:b@example.test', daily('b@example.test')],
    ['alert:a@example.test', alert(undefined, { lastAlertKeys: ['existing'], lastAlertAt: '2026-09-30T00:00:00Z' })],
  ], { pageSize: 1 });
  const importId = 'test-import'; await beginSubscriptionImport(env, { importId });
  await beginSubscriptionImport(env, { importId }); // safe resume
  await assert.rejects(beginSubscriptionImport(env, { importId: 'another-import' }), code('SUBSCRIPTION_IMPORT_CONFLICT'));
  await assert.rejects(promoteSubscriptionImportPage(env, { importId }), code('SUBSCRIPTION_IMPORT_INCOMPLETE'));
  for (const kind of ['daily', 'alert']) {
    let cursor = '';
    do {
      const page = await readLegacySubscriptionPage(env, kind, cursor, 100);
      const args = { importId, kind, expectedCursor: cursor, ...page };
      await stageSubscriptionImportPage(env, args);
      await assert.rejects(stageSubscriptionImportPage(env, args), code('SUBSCRIPTION_IMPORT_CURSOR_CONFLICT'));
      cursor = page.cursor;
    } while (cursor);
  }
  assert.throws(() => env.DB.sqlite.exec('UPDATE subscription_storage_control SET ready=1'), /Verified complete import/);
  let result;
  do { result = await promoteSubscriptionImportPage(env, { importId, limit: 1 }); } while (!result.complete);
  assert.deepEqual(await verifySubscriptionImport(env, importId), { verified: true, count: 3, daily: 2, alert: 1 });
  assert.equal((await getSubscriptionImportStatus(env, importId)).status, 'verified');
  assert.equal((await getSubscriptionStorageStatus(env)).ready, false);
  // Explicit operator steps, deliberately unavailable through runtime APIs.
  env.DB.sqlite.exec("DELETE FROM subscription_import_staging; UPDATE subscription_import_runs SET status='activated'; UPDATE subscription_storage_control SET ready=1");
  env.SUBSCRIPTION_STORAGE_MODE = 'd1';
  assert.equal((await readSubscription(env, 'daily', daily().email)).lastSentDate, '2026-09-30');
  assert.deepEqual((await readSubscription(env, 'alert', alert().email)).lastAlertKeys, ['existing']);
  assert.equal(await deleteSubscription(env, 'daily', daily().email), true);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM subscription_import_staging WHERE email='a@example.test'").get().n, 0);
});

test('import validation catches incompatible keys, corruption and changed target before activation', async (t) => {
  const env = environment(t, { ready: false }); env.SUBSCRIPTION_STORAGE_MODE = 'handover';
  const importId = 'validation'; await beginSubscriptionImport(env, { importId });
  await assert.rejects(stageSubscriptionImportPage(env, { importId, kind: 'daily', records: [{ key: 'sub:other@example.test', record: daily() }], complete: true }), /differ/);
  await stageSubscriptionImportPage(env, { importId, kind: 'daily', records: [{ key: 'sub:a@example.test', record: daily() }], complete: true });
  await stageSubscriptionImportPage(env, { importId, kind: 'alert', records: [], complete: true });
  await promoteSubscriptionImportPage(env, { importId });
  env.DB.sqlite.exec("UPDATE subscriptions SET last_sent_date='1900-01-01'");
  await assert.rejects(verifySubscriptionImport(env, importId), code('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED'));
  assert.equal((await getSubscriptionStorageStatus(env)).ready, false);
});

test('daily due-time filter uses the expression index and still covers every matching page', async (t) => {
  const env = environment(t);
  for (let n = 0; n < 203; n += 1) await writeSubscription(env, 'daily', daily(`a${String(n).padStart(3, '0')}@example.test`, { sendTime: n % 2 ? '08:30' : '16:00' }));
  const records = await listSubscriptionRecords(env, 'daily', { sendTime: '16:00' });
  assert.equal(records.length, 102); assert.ok(records.every((record) => record.sendTime === '16:00'));
  const plan = env.DB.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM subscriptions WHERE kind='daily' AND email>'' AND json_extract(config_json,'$.sendTime')='16:00' ORDER BY email LIMIT 100").all();
  assert.ok(plan.some((row) => row.detail.includes('subscriptions_daily_send_time')));
  const legacy = { SUBSCRIPTIONS: createKV([['sub:a@example.test', daily()], ['sub:b@example.test', daily('b@example.test', { sendTime: '08:30' })]], { pageSize: 1 }) };
  assert.equal((await listSubscriptionRecords(legacy, 'daily', { sendTime: '16:00' })).length, 1);
  assert.equal(legacy.SUBSCRIPTIONS.calls.filter((call) => call.type === 'list').length, 2);
  await assert.rejects(listSubscriptionRecords(env, 'alert', { sendTime: '16:00' }), /Invalid daily/);
});

test('provider-accepted/DB-commit outage leaves sending attempt blocked with no KV state write', async (t) => {
  const env = environment(t); const { record, claim } = await prepared(env);
  env.DB.failSQL = /^UPDATE subscriptions/;
  await assert.rejects(completeDelivery(env, 'daily', record, claim, patch), code('SUBSCRIPTION_DB_UNAVAILABLE'));
  assert.equal(env.SUBSCRIPTIONS.calls.length, 0);
  env.DB.failSQL = null;
  assert.equal(env.DB.sqlite.prepare('SELECT delivery_phase FROM subscriptions').get().delivery_phase, 'sending');
  assert.equal(await acquireDelivery(env, 'daily', record), null);
  assert.equal(await completeDelivery(env, 'daily', record, claim, patch), true);
});

test('legacy malformed and unbounded provider pages reject rather than truncate or over-fetch', async () => {
  const tooLarge = { SUBSCRIPTIONS: { list: async () => ({ keys: Array.from({ length: 1001 }, () => ({ name: 'sub:a@example.test' })), list_complete: true }), get: async () => assert.fail('must not fetch oversized page') } };
  await assert.rejects(listSubscriptionRecords(tooLarge, 'daily'), code('SUBSCRIPTION_INVALID_KV_PAGE'));
  const badCursor = { SUBSCRIPTIONS: { list: async () => ({ keys: [], list_complete: false, cursor: 12 }) } };
  await assert.rejects(listSubscriptionRecords(badCursor, 'daily'), code('SUBSCRIPTION_INVALID_KV_CURSOR'));
});

test('runtime legacy pagination retains 1000-key pages while migration pages remain at most 100', async () => {
  const entries = Array.from({ length: 1005 }, (_, n) => [`sub:a${n}@example.test`, daily(`a${n}@example.test`)]);
  const env = { SUBSCRIPTIONS: createKV(entries, { pageSize: 1000 }) };
  assert.equal((await listSubscriptionRecords(env, 'daily')).length, 1005);
  assert.deepEqual(env.SUBSCRIPTIONS.calls.filter((call) => call.type === 'list').map((call) => call.limit), [1000, 1000]);
  assert.equal((await readLegacySubscriptionPage(env, 'daily')).records.length, 100);
  await assert.rejects(readLegacySubscriptionPage(env, 'daily', '', 1000), /Invalid subscription page limit/);
});

test('readiness requires the verified matching complete import even after premature staging purge', async (t) => {
  const env = environment(t, { ready: false }); env.SUBSCRIPTION_STORAGE_MODE = 'handover';
  const rejectReady = () => assert.throws(() => env.DB.sqlite.exec('UPDATE subscription_storage_control SET ready=1'), /Verified complete import/);
  const temporarySQL = async (sql, check) => {
    env.DB.sqlite.exec('SAVEPOINT adversarial');
    try { env.DB.sqlite.exec(sql); await check(); }
    finally { env.DB.sqlite.exec('ROLLBACK TO adversarial; RELEASE adversarial'); }
  };
  rejectReady(); // no import
  const importId = 'sealed-cutover'; await beginSubscriptionImport(env, { importId });
  rejectReady(); // empty but not completed
  await stageSubscriptionImportPage(env, { importId, kind: 'daily', records: [
    { key: 'sub:a@example.test', record: daily() },
    { key: 'sub:b@example.test', record: daily('b@example.test') },
  ], complete: true });
  await temporarySQL('DELETE FROM subscription_import_staging', rejectReady); // alert stream incomplete
  await stageSubscriptionImportPage(env, { importId, kind: 'alert', records: [{ key: 'alert:a@example.test', record: alert() }], complete: true });
  const partial = await promoteSubscriptionImportPage(env, { importId, limit: 1 });
  assert.equal(partial.complete, false);
  await temporarySQL('DELETE FROM subscription_import_staging', rejectReady); // partly promoted
  let promotion;
  do { promotion = await promoteSubscriptionImportPage(env, { importId, limit: 1 }); } while (!promotion.complete);
  await temporarySQL('DELETE FROM subscription_import_staging', rejectReady); // fully promoted, never verified
  await temporarySQL("DELETE FROM subscription_import_staging WHERE kind='alert'", async () => {
    await assert.rejects(verifySubscriptionImport(env, importId), code('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED'));
    rejectReady();
  });
  const result = await verifySubscriptionImport(env, importId);
  assert.deepEqual(result, { verified: true, count: 3, daily: 2, alert: 1 });
  const sealed = await getSubscriptionImportStatus(env, importId);
  assert.equal(sealed.status, 'verified'); assert.equal(sealed.daily_count, 2); assert.equal(sealed.alert_count, 1);
  assert.equal(sealed.verified_daily_count, 2); assert.equal(sealed.verified_alert_count, 1); assert.ok(sealed.verified_at);
  for (const field of ['promote_email', 'promote_kind', 'daily_cursor', 'alert_cursor']) assert.equal(sealed[field], '');
  for (const field of ['promote_email', 'daily_cursor', 'alert_cursor']) {
    await temporarySQL(`DELETE FROM subscription_import_staging; UPDATE subscription_import_runs SET ${field}='a@example.test'`, rejectReady);
  }
  await temporarySQL("DELETE FROM subscription_import_staging WHERE kind='alert'", rejectReady); // partially purged
  await temporarySQL("DELETE FROM subscription_import_staging; INSERT INTO subscription_import_runs(import_id,promote_email) VALUES ('abandoned-import','a@example.test')", rejectReady);
  await temporarySQL("DELETE FROM subscription_import_staging; DELETE FROM subscriptions WHERE kind='alert'", rejectReady); // wrong target count
  await temporarySQL("DELETE FROM subscription_import_staging; UPDATE subscription_storage_control SET import_id='different-run'", rejectReady);
  env.DB.sqlite.exec('DELETE FROM subscription_import_staging; UPDATE subscription_storage_control SET ready=1');
  assert.equal((await getSubscriptionStorageStatus(env)).ready, true);
  assert.equal((await getSubscriptionImportStatus(env, importId)).status, 'verified'); // status is safe after cutover
});

test('a genuinely empty import requires both completed streams, promotion and verification', async (t) => {
  const env = environment(t, { ready: false }); env.SUBSCRIPTION_STORAGE_MODE = 'handover';
  const importId = 'empty-cutover'; await beginSubscriptionImport(env, { importId });
  for (const kind of ['daily', 'alert']) await stageSubscriptionImportPage(env, { importId, kind, records: [], complete: true });
  await promoteSubscriptionImportPage(env, { importId });
  assert.throws(() => env.DB.sqlite.exec('UPDATE subscription_storage_control SET ready=1'), /Verified complete import/);
  assert.deepEqual(await verifySubscriptionImport(env, importId), { verified: true, count: 0, daily: 0, alert: 0 });
  env.DB.sqlite.exec('UPDATE subscription_storage_control SET ready=1');
  assert.equal((await getSubscriptionStorageStatus(env)).ready, true);
});

test('a source purged before promotion cannot be sealed as a falsely empty import', async (t) => {
  const env = environment(t, { ready: false }); env.SUBSCRIPTION_STORAGE_MODE = 'handover';
  const importId = 'purged-source'; await beginSubscriptionImport(env, { importId });
  await stageSubscriptionImportPage(env, { importId, kind: 'daily', records: [{ key: 'sub:a@example.test', record: daily() }], complete: true });
  await stageSubscriptionImportPage(env, { importId, kind: 'alert', records: [], complete: true });
  env.DB.sqlite.exec('DELETE FROM subscription_import_staging');
  await promoteSubscriptionImportPage(env, { importId });
  await assert.rejects(verifySubscriptionImport(env, importId), code('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED'));
  assert.throws(() => env.DB.sqlite.exec('UPDATE subscription_storage_control SET ready=1'), /Verified complete import/);
});
