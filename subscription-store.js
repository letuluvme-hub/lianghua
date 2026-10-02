// Subscription configuration is authoritative in exactly one store at a time.
// Modes: legacy (default), handover (KV reads; mutations/dispatch paused), d1.
// D1 operations fail closed; they never fall back to KV or create tables.
// A mail request and D1 commit cannot be atomic. A prepared send is deliberately
// never auto-reclaimed: after a crash/uncertain provider response an operator must
// reconcile the attempt before delivery resumes. The stable key can be passed to
// the mail provider, but its finite idempotency window is NOT a correctness guard.
export const SUBSCRIPTION_METADATA = Symbol('subscriptionMetadata');
export const SUBSCRIPTION_PAGE_SIZE = 100;
const LEGACY_LIST_PAGE_SIZE = 1000;
export const DELIVERY_LEASE_MS = 10 * 60 * 1000;
const MAX_PAGES = 1000;
const MAX_RECORDS = 10000;
const NOW_MS = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)";
const READY = 'EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND schema_version=1 AND ready=1)';
const FROZEN = 'EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND schema_version=1 AND ready=0)';
const CLEAR_CLAIM = 'lease_owner=NULL, lease_until=NULL, attempt_id=NULL, delivery_phase=NULL, prepared_state_json=NULL';

export class SubscriptionStorageError extends Error {
  constructor(code, cause) {
    super(code === 'SUBSCRIPTION_HANDOVER' ? 'Subscription changes and delivery are temporarily paused.' : 'Subscription storage is temporarily unavailable.');
    this.name = 'SubscriptionStorageError';
    this.code = code;
    this.status = 503;
    this.statusCode = 503;
    if (cause) this.cause = cause;
  }
}
function fail(code, cause) { return new SubscriptionStorageError(code, cause); }
export function storageMode(env) {
  const mode = env.SUBSCRIPTION_STORAGE_MODE ?? 'legacy';
  if (!['legacy', 'handover', 'd1'].includes(mode)) throw fail('SUBSCRIPTION_INVALID_MODE');
  return mode;
}
export function assertSubscriptionOperation(env, operation) {
  const mode = storageMode(env);
  if (mode === 'handover' && !['read', 'list'].includes(operation)) throw fail('SUBSCRIPTION_HANDOVER');
  return mode;
}
function kindPrefix(kind) {
  if (!['daily', 'alert'].includes(kind)) throw new TypeError('Unknown subscription kind');
  return kind === 'daily' ? 'sub:' : 'alert:';
}
function address(email) {
  if (typeof email !== 'string' || !email.trim() || email.trim().toLowerCase() !== email) throw new TypeError('A normalized subscription email is required');
  return email;
}
function safeParse(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function configRecord(kind, record) {
  kindPrefix(kind); address(record?.email);
  if (!Array.isArray(record.stocks)) throw new TypeError('Subscription stocks must be an array');
  const config = { ...record };
  delete config.lastSentDate; delete config.lastAlertKeys; delete config.lastAlertAt;
  return config;
}
function statePatch(kind, patch) {
  if (kind === 'daily') {
    if (typeof patch?.lastSentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(patch.lastSentDate)) throw new TypeError('A delivery date is required');
    return { lastSentDate: patch.lastSentDate };
  }
  kindPrefix(kind);
  if (!Array.isArray(patch?.alertKeys) || patch.alertKeys.some((key) => typeof key !== 'string') || typeof patch.lastAlertAt !== 'string') throw new TypeError('Alert delivery state is required');
  return { alertKeys: [...new Set(patch.alertKeys)].slice(-300), lastAlertAt: patch.lastAlertAt };
}
function primary(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') throw fail('SUBSCRIPTION_DB_MISSING');
  // Never reuse a session whose first query was the readiness read: the final
  // send guard itself must hit primary. Non-session binding queries also use primary.
  return typeof env.DB.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB;
}
async function query(env, sql, args = []) {
  try {
    const result = await primary(env).prepare(sql).bind(...args).all();
    if (result?.success === false || !Array.isArray(result?.results)) throw new Error('Invalid D1 result');
    return result;
  } catch (error) {
    if (error instanceof SubscriptionStorageError) throw error;
    throw fail('SUBSCRIPTION_DB_UNAVAILABLE', error);
  }
}
async function one(env, sql, args = []) { return (await query(env, sql, args)).results[0] ?? null; }
export async function getSubscriptionStorageStatus(env) {
  const row = await one(env, 'SELECT schema_version, ready, import_id, updated_at FROM subscription_storage_control WHERE singleton=1');
  if (!row || row.schema_version !== 1) throw fail('SUBSCRIPTION_SCHEMA_NOT_READY');
  return { mode: storageMode(env), ready: row.ready === 1, schemaVersion: row.schema_version, importId: row.import_id, updatedAt: row.updated_at };
}
async function ready(env) {
  if (!(await getSubscriptionStorageStatus(env)).ready) throw fail('SUBSCRIPTION_NOT_READY');
}
function unpack(row) {
  if (!row) return null;
  const config = safeParse(row.config_json);
  const keys = safeParse(row.last_alert_keys_json);
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(keys) || keys.some((key) => typeof key !== 'string') || !Array.isArray(config.stocks)) throw fail('SUBSCRIPTION_CORRUPT_RECORD');
  const record = { ...config, email: row.email };
  if (row.kind === 'daily') record.lastSentDate = row.last_sent_date;
  else { record.lastAlertKeys = keys; record.lastAlertAt = row.last_alert_at; }
  Object.defineProperty(record, SUBSCRIPTION_METADATA, { value: Object.freeze({ mode: 'd1', kind: row.kind, email: row.email, generation: row.generation, configVersion: row.config_version, stateVersion: row.state_version }), enumerable: false });
  return record;
}
function metadata(kind, record) {
  const meta = record?.[SUBSCRIPTION_METADATA];
  return meta?.mode === 'd1' && meta.kind === kind && meta.email === record.email ? meta : null;
}
function matchesClaim(kind, record, claim) {
  const meta = metadata(kind, record);
  return meta && claim?.mode === 'd1' && claim.kind === kind && claim.email === record.email && claim.generation === meta.generation && claim.configVersion === meta.configVersion && claim.stateVersion === meta.stateVersion && typeof claim.owner === 'string' && typeof claim.attemptId === 'string' ? meta : null;
}
export async function readSubscription(env, kind, email) {
  const prefix = kindPrefix(kind); address(email);
  if (assertSubscriptionOperation(env, 'read') !== 'd1') return safeParse(await env.SUBSCRIPTIONS.get(prefix + email));
  await ready(env);
  return unpack(await one(env, `SELECT * FROM subscriptions WHERE kind=? AND email=? AND ${READY}`, [kind, email]));
}
export async function writeSubscription(env, kind, record) {
  const config = configRecord(kind, record);
  if (assertSubscriptionOperation(env, 'write') !== 'd1') {
    await env.SUBSCRIPTIONS.put(kindPrefix(kind) + record.email, JSON.stringify(record));
    return record;
  }
  await ready(env);
  const row = await one(env, `INSERT INTO subscriptions (kind,email,generation,config_json)
    SELECT ?,?,?,? WHERE ${READY}
    ON CONFLICT(kind,email) DO UPDATE SET config_json=excluded.config_json, config_version=subscriptions.config_version+1
    RETURNING *`, [kind, record.email, crypto.randomUUID(), JSON.stringify(config)]);
  if (!row) throw fail('SUBSCRIPTION_NOT_READY');
  return unpack(row);
}
export async function deleteSubscription(env, kind, email) {
  const prefix = kindPrefix(kind); address(email);
  if (assertSubscriptionOperation(env, 'delete') !== 'd1') {
    const existed = Boolean(await env.SUBSCRIPTIONS.get(prefix + email));
    await env.SUBSCRIPTIONS.delete(prefix + email);
    return existed;
  }
  await ready(env);
  return Boolean(await one(env, `DELETE FROM subscriptions WHERE kind=? AND email=? AND ${READY} RETURNING email`, [kind, email]));
}
async function readKVSubscriptionPage(env, kind, cursor, limit) {
  const prefix = kindPrefix(kind);
  if (!Number.isInteger(limit) || limit < 1 || limit > LEGACY_LIST_PAGE_SIZE) throw new TypeError('Invalid subscription page limit');
  const page = await env.SUBSCRIPTIONS.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
  if (!page || !Array.isArray(page.keys) || page.keys.length > limit || typeof page.list_complete !== 'boolean') throw fail('SUBSCRIPTION_INVALID_KV_PAGE');
  if (!page.list_complete && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === cursor)) throw fail('SUBSCRIPTION_INVALID_KV_CURSOR');
  const records = [];
  // Bounded concurrency rather than a 100-way get burst.
  for (let start = 0; start < page.keys.length; start += 10) {
    const entries = await Promise.all(page.keys.slice(start, start + 10).map(async (key) => {
      if (!key?.name?.startsWith(prefix)) throw fail('SUBSCRIPTION_INVALID_KV_KEY');
      return { key: key.name, record: safeParse(await env.SUBSCRIPTIONS.get(key.name)) };
    }));
    records.push(...entries);
  }
  return { records, cursor: page.list_complete ? '' : page.cursor, complete: page.list_complete };
}
export async function readLegacySubscriptionPage(env, kind, cursor = '', limit = SUBSCRIPTION_PAGE_SIZE) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SUBSCRIPTION_PAGE_SIZE) throw new TypeError('Invalid subscription page limit');
  return readKVSubscriptionPage(env, kind, cursor, limit);
}
export async function listSubscriptionRecords(env, kind, { sendTime } = {}) {
  kindPrefix(kind);
  if (sendTime !== undefined && (kind !== 'daily' || typeof sendTime !== 'string' || !/^\d{2}:\d{2}$/.test(sendTime))) throw new TypeError('Invalid daily send-time filter');
  const mode = assertSubscriptionOperation(env, 'list');
  const records = [];
  if (mode !== 'd1') {
    let cursor = ''; const seenCursors = new Set(); const seenKeys = new Set();
    for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
      const page = await readKVSubscriptionPage(env, kind, cursor, LEGACY_LIST_PAGE_SIZE);
      for (const entry of page.records) {
        if (seenKeys.has(entry.key)) continue;
        seenKeys.add(entry.key);
        if (entry.record?.email && Array.isArray(entry.record.stocks) && (sendTime === undefined || entry.record.sendTime === sendTime)) records.push(entry.record);
        if (seenKeys.size > MAX_RECORDS) throw fail('SUBSCRIPTION_SCAN_LIMIT');
      }
      if (page.complete) return records;
      if (seenCursors.has(page.cursor)) throw fail('SUBSCRIPTION_INVALID_KV_CURSOR');
      seenCursors.add(page.cursor); cursor = page.cursor;
    }
    throw fail('SUBSCRIPTION_SCAN_LIMIT');
  }
  await ready(env);
  let after = '';
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const filter = sendTime === undefined ? '' : " AND json_extract(config_json,'$.sendTime')=?";
    const args = [kind, after, ...(sendTime === undefined ? [] : [sendTime]), SUBSCRIPTION_PAGE_SIZE];
    const { results } = await query(env, `SELECT * FROM subscriptions WHERE kind=? AND email>?${filter} AND ${READY} ORDER BY email LIMIT ?`, args);
    records.push(...results.map(unpack));
    if (records.length > MAX_RECORDS) throw fail('SUBSCRIPTION_SCAN_LIMIT');
    if (results.length < SUBSCRIPTION_PAGE_SIZE) return records;
    after = results.at(-1).email;
  }
  throw fail('SUBSCRIPTION_SCAN_LIMIT');
}
export async function acquireDelivery(env, kind, record) {
  const mode = assertSubscriptionOperation(env, 'dispatch'); kindPrefix(kind);
  const owner = crypto.randomUUID(); const attemptId = crypto.randomUUID();
  if (mode !== 'd1') return { mode: 'legacy', owner, attemptId, idempotencyKey: `subscription-${attemptId}` };
  const meta = metadata(kind, record); if (!meta) return null;
  await ready(env);
  const row = await one(env, `UPDATE subscriptions SET lease_owner=?, lease_until=${NOW_MS}+?, attempt_id=?, delivery_phase='claimed', prepared_state_json=NULL
    WHERE kind=? AND email=? AND generation=? AND config_version=? AND state_version=? AND ${READY}
      AND (lease_owner IS NULL OR (delivery_phase='claimed' AND lease_until<=${NOW_MS}))
    RETURNING lease_until`, [owner, DELIVERY_LEASE_MS, attemptId, kind, record.email, meta.generation, meta.configVersion, meta.stateVersion]);
  return row ? Object.freeze({ ...meta, owner, attemptId, idempotencyKey: `subscription-${attemptId}`, leaseUntil: row.lease_until }) : null;
}
export async function prepareDelivery(env, kind, record, claim, patch) {
  const mode = assertSubscriptionOperation(env, 'dispatch');
  const prepared = statePatch(kind, patch);
  if (mode !== 'd1') return true;
  const meta = matchesClaim(kind, record, claim); if (!meta) return false;
  await ready(env);
  return Boolean(await one(env, `UPDATE subscriptions SET delivery_phase='sending', prepared_state_json=?
    WHERE kind=? AND email=? AND generation=? AND config_version=? AND state_version=? AND lease_owner=? AND attempt_id=?
      AND lease_until>${NOW_MS} AND delivery_phase='claimed' AND ${READY} RETURNING email`,
  [JSON.stringify(prepared), kind, record.email, meta.generation, meta.configVersion, meta.stateVersion, claim.owner, claim.attemptId]));
}
export async function isDeliveryCurrent(env, kind, record, claim) {
  if (assertSubscriptionOperation(env, 'dispatch') !== 'd1') return true;
  const meta = matchesClaim(kind, record, claim); if (!meta) return false;
  await ready(env);
  return Boolean(await one(env, `SELECT email FROM subscriptions WHERE kind=? AND email=? AND generation=? AND config_version=? AND state_version=?
    AND lease_owner=? AND attempt_id=? AND lease_until>${NOW_MS} AND delivery_phase='sending' AND ${READY}`,
  [kind, record.email, meta.generation, meta.configVersion, meta.stateVersion, claim.owner, claim.attemptId]));
}
export async function completeDelivery(env, kind, record, claim, patch) {
  const mode = assertSubscriptionOperation(env, 'dispatch'); const next = statePatch(kind, patch);
  if (mode !== 'd1') {
    const updated = { ...record, ...(kind === 'daily' ? next : { lastAlertKeys: next.alertKeys, lastAlertAt: next.lastAlertAt }) };
    await env.SUBSCRIPTIONS.put(kindPrefix(kind) + record.email, JSON.stringify(updated));
    return true;
  }
  const meta = matchesClaim(kind, record, claim); if (!meta) return false;
  await ready(env);
  const fields = kind === 'daily' ? 'last_sent_date=?' : 'last_alert_keys_json=?, last_alert_at=?';
  const values = kind === 'daily' ? [next.lastSentDate] : [JSON.stringify(next.alertKeys), next.lastAlertAt];
  // No config_version predicate: an edit after the provider accepted the message
  // must not prevent recording that delivery. Generation + state CAS still apply.
  return Boolean(await one(env, `UPDATE subscriptions SET ${fields}, state_version=state_version+1, ${CLEAR_CLAIM}
    WHERE kind=? AND email=? AND generation=? AND state_version=? AND lease_owner=? AND attempt_id=?
      AND delivery_phase='sending' AND prepared_state_json=? AND ${READY} RETURNING email`,
  [...values, kind, record.email, meta.generation, meta.stateVersion, claim.owner, claim.attemptId, JSON.stringify(next)]));
}
export async function releaseDelivery(env, kind, record, claim, { unsent = false } = {}) {
  if (assertSubscriptionOperation(env, 'dispatch') !== 'd1') return true;
  const meta = matchesClaim(kind, record, claim); if (!meta) return false;
  await ready(env);
  // unsent may only be used when the caller knows no provider request was made.
  return Boolean(await one(env, `UPDATE subscriptions SET ${CLEAR_CLAIM}
    WHERE kind=? AND email=? AND generation=? AND lease_owner=? AND attempt_id=? AND ${READY}
      AND (delivery_phase='claimed' OR ?=1) RETURNING email`,
  [kind, record.email, meta.generation, claim.owner, claim.attemptId, unsent ? 1 : 0]));
}

// Offline/operator-only migration primitives. Nothing below is routed by HTTP.
// Handover and a NOT-ready control row are mandatory. No activation helper:
// an operator must verify the import, purge staging, delete the old KV prefixes,
// verify their disappearance after KV propagation, then explicitly set readiness.
async function frozen(env) {
  if (storageMode(env) !== 'handover') throw fail('SUBSCRIPTION_IMPORT_REQUIRES_HANDOVER');
  const status = await getSubscriptionStorageStatus(env);
  if (status.ready) throw fail('SUBSCRIPTION_IMPORT_ALREADY_READY');
  return status;
}
async function batch(env, statements) {
  try {
    const db = primary(env);
    if (typeof db.batch !== 'function') throw new Error('D1 batch is required');
    const results = await db.batch(statements.map(({ sql, args = [] }) => db.prepare(sql).bind(...args)));
    if (!Array.isArray(results) || results.some((result) => result?.success === false)) throw new Error('Invalid D1 batch result');
    return results;
  } catch (error) {
    if (error instanceof SubscriptionStorageError) throw error;
    throw fail('SUBSCRIPTION_DB_UNAVAILABLE', error);
  }
}
function importIdValue(importId) {
  if (typeof importId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(importId)) throw new TypeError('Invalid subscription import ID');
  return importId;
}
export async function getSubscriptionImportStatus(env, importId) {
  importIdValue(importId); storageMode(env);
  return one(env, `SELECT r.*,
    (SELECT count(*) FROM subscription_import_staging s WHERE s.import_id=r.import_id AND s.kind='daily') AS staged_daily,
    (SELECT count(*) FROM subscription_import_staging s WHERE s.import_id=r.import_id AND s.kind='alert') AS staged_alert,
    (SELECT count(*) FROM subscriptions WHERE kind='daily') AS promoted_daily,
    (SELECT count(*) FROM subscriptions WHERE kind='alert') AS promoted_alert
    FROM subscription_import_runs r WHERE import_id=?`, [importId]);
}
export async function beginSubscriptionImport(env, { importId = crypto.randomUUID() } = {}) {
  importIdValue(importId);
  const control = await frozen(env);
  if (control.importId && control.importId !== importId) throw fail('SUBSCRIPTION_IMPORT_CONFLICT');
  if (!control.importId && (await one(env, 'SELECT 1 AS present FROM subscriptions LIMIT 1'))) throw fail('SUBSCRIPTION_IMPORT_NONEMPTY_TARGET');
  const results = await batch(env, [
    { sql: `UPDATE subscription_storage_control SET import_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE singleton=1 AND ready=0 AND (import_id IS NULL OR import_id=?)`, args: [importId, importId] },
    { sql: `INSERT OR IGNORE INTO subscription_import_runs(import_id)
      SELECT ? WHERE EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND ready=0 AND import_id=?)`, args: [importId, importId] },
  ]);
  if (results[0]?.meta?.changes !== 1) throw fail('SUBSCRIPTION_IMPORT_CONFLICT');
  return getSubscriptionImportStatus(env, importId);
}
export async function stageSubscriptionImportPage(env, { importId, kind, expectedCursor = '', records, cursor = '', complete = false }) {
  importIdValue(importId); const prefix = kindPrefix(kind); const control = await frozen(env);
  if (control.importId !== importId) throw fail('SUBSCRIPTION_IMPORT_CONFLICT');
  if (!Array.isArray(records) || records.length > SUBSCRIPTION_PAGE_SIZE || typeof expectedCursor !== 'string' || typeof cursor !== 'string' || typeof complete !== 'boolean' || (!complete && (!cursor || cursor === expectedCursor))) throw new TypeError('Invalid import page');
  const normalized = records.map(({ key, record }) => {
    const config = configRecord(kind, record);
    if (key !== prefix + record.email) throw new TypeError('KV key and subscription email differ');
    const state = kind === 'daily'
      ? { lastSentDate: typeof record.lastSentDate === 'string' ? record.lastSentDate : null }
      : { lastAlertKeys: Array.isArray(record.lastAlertKeys) ? [...new Set(record.lastAlertKeys)].slice(-300) : [], lastAlertAt: typeof record.lastAlertAt === 'string' ? record.lastAlertAt : null };
    if (state.lastAlertKeys?.some((value) => typeof value !== 'string')) throw new TypeError('Invalid imported alert state');
    const json = JSON.stringify({ ...config, ...state });
    if (new TextEncoder().encode(json).length > 65536) throw new TypeError('Subscription import record is too large');
    return { email: record.email, json, generation: crypto.randomUUID() };
  });
  if (new Set(normalized.map((record) => record.email)).size !== normalized.length) throw new TypeError('Duplicate records within import page');
  const guard = `${FROZEN} AND EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND import_id=?)
    AND EXISTS (SELECT 1 FROM subscription_import_runs WHERE import_id=? AND status='staging' AND ${kind}_cursor=? AND ${kind}_complete=0)`;
  const args = [importId, importId, expectedCursor];
  const statements = normalized.map((record) => ({
    sql: `INSERT INTO subscription_import_staging(import_id,kind,email,record_json,generation)
      SELECT ?,?,?,?,? WHERE ${guard}
      ON CONFLICT(import_id,kind,email) DO UPDATE SET record_json=excluded.record_json`,
    args: [importId, kind, record.email, record.json, record.generation, ...args],
  }));
  statements.push({ sql: `UPDATE subscription_import_runs SET ${kind}_cursor=?, ${kind}_complete=?,
    ${kind}_count=CASE WHEN ?=1 THEN (SELECT count(*) FROM subscription_import_staging WHERE import_id=? AND kind=?) ELSE NULL END
    WHERE import_id=? AND ${guard}`, args: [complete ? '' : cursor, complete ? 1 : 0, complete ? 1 : 0, importId, kind, importId, ...args] });
  const results = await batch(env, statements);
  if (results.at(-1)?.meta?.changes !== 1) throw fail('SUBSCRIPTION_IMPORT_CURSOR_CONFLICT');
  return getSubscriptionImportStatus(env, importId);
}
export async function promoteSubscriptionImportPage(env, { importId, limit = SUBSCRIPTION_PAGE_SIZE }) {
  importIdValue(importId);
  if (!Number.isInteger(limit) || limit < 1 || limit > SUBSCRIPTION_PAGE_SIZE) throw new TypeError('Invalid import page limit');
  const control = await frozen(env);
  if (control.importId !== importId) throw fail('SUBSCRIPTION_IMPORT_CONFLICT');
  const run = await getSubscriptionImportStatus(env, importId);
  if (!run || !run.daily_complete || !run.alert_complete || !['staging', 'promoting', 'promoted'].includes(run.status)) throw fail('SUBSCRIPTION_IMPORT_INCOMPLETE');
  if (run.status === 'promoted') return { complete: true, promoted: 0, status: run };
  const rows = (await query(env, `SELECT * FROM subscription_import_staging WHERE import_id=?
    AND (kind>? OR (kind=? AND email>?)) ORDER BY kind,email LIMIT ?`, [importId, run.promote_kind, run.promote_kind, run.promote_email, limit])).results;
  const guard = `${FROZEN} AND EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND import_id=?)
    AND EXISTS (SELECT 1 FROM subscription_import_runs WHERE import_id=? AND status IN ('staging','promoting')
      AND daily_complete=1 AND alert_complete=1 AND promote_kind=? AND promote_email=?)`;
  const guardArgs = [importId, importId, run.promote_kind, run.promote_email];
  const statements = rows.map((row) => {
    const record = JSON.parse(row.record_json);
    return { sql: `INSERT INTO subscriptions(kind,email,generation,config_json,last_sent_date,last_alert_keys_json,last_alert_at)
      SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(kind,email) DO NOTHING`,
    args: [row.kind, row.email, row.generation, JSON.stringify(configRecord(row.kind, record)), record.lastSentDate ?? null, JSON.stringify(record.lastAlertKeys ?? []), record.lastAlertAt ?? null, ...guardArgs] };
  });
  const last = rows.at(-1);
  const complete = rows.length < limit;
  statements.push({ sql: `UPDATE subscription_import_runs SET status=?,promote_kind=?,promote_email=? WHERE import_id=? AND ${guard}`,
    args: [complete ? 'promoted' : 'promoting', last?.kind ?? run.promote_kind, last?.email ?? run.promote_email, importId, ...guardArgs] });
  const results = await batch(env, statements);
  if (results.at(-1)?.meta?.changes !== 1) throw fail('SUBSCRIPTION_IMPORT_CURSOR_CONFLICT');
  return { complete, promoted: results.slice(0, -1).reduce((count, result) => count + (result.meta?.changes ?? 0), 0), status: await getSubscriptionImportStatus(env, importId) };
}
export async function verifySubscriptionImport(env, importId) {
  importIdValue(importId); await frozen(env);
  const run = await getSubscriptionImportStatus(env, importId);
  if (!run || run.status !== 'promoted') throw fail('SUBSCRIPTION_IMPORT_INCOMPLETE');
  if (run.daily_count !== run.staged_daily || run.alert_count !== run.staged_alert) throw fail('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED');
  // Compare the complete source record, ignoring JSON key ordering, against the
  // promoted row. This is paginated, bounded, and does not return email addresses.
  let afterKind = ''; let afterEmail = ''; let checked = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = (await query(env, `SELECT s.*,p.generation AS target_generation,p.config_json,p.last_sent_date,p.last_alert_keys_json,p.last_alert_at
      FROM subscription_import_staging s LEFT JOIN subscriptions p ON p.kind=s.kind AND p.email=s.email
      WHERE s.import_id=? AND (s.kind>? OR (s.kind=? AND s.email>?)) ORDER BY s.kind,s.email LIMIT ?`, [importId, afterKind, afterKind, afterEmail, SUBSCRIPTION_PAGE_SIZE])).results;
    for (const row of rows) {
      const record = JSON.parse(row.record_json);
      if (row.generation !== row.target_generation || JSON.stringify(configRecord(row.kind, record)) !== row.config_json || (record.lastSentDate ?? null) !== row.last_sent_date || JSON.stringify(record.lastAlertKeys ?? []) !== row.last_alert_keys_json || (record.lastAlertAt ?? null) !== row.last_alert_at) throw fail('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED');
      checked += 1;
      if (checked > MAX_RECORDS) throw fail('SUBSCRIPTION_SCAN_LIMIT');
    }
    if (rows.length < SUBSCRIPTION_PAGE_SIZE) {
      if (checked !== run.promoted_daily + run.promoted_alert || checked !== run.daily_count + run.alert_count) throw fail('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED');
      // Seal only after complete record verification. Guard counts again in the
      // same SQL statement so a partial staging purge cannot be certified.
      const sealed = await one(env, `UPDATE subscription_import_runs SET status='verified',
        promote_email='', promote_kind='', daily_cursor='', alert_cursor='',
        verified_daily_count=daily_count, verified_alert_count=alert_count,
        verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE import_id=? AND status='promoted' AND daily_complete=1 AND alert_complete=1
          AND daily_count=? AND alert_count=? AND ${FROZEN}
          AND EXISTS (SELECT 1 FROM subscription_storage_control WHERE singleton=1 AND import_id=?)
          AND daily_count=(SELECT count(*) FROM subscription_import_staging WHERE import_id=? AND kind='daily')
          AND alert_count=(SELECT count(*) FROM subscription_import_staging WHERE import_id=? AND kind='alert')
          AND daily_count=(SELECT count(*) FROM subscriptions WHERE kind='daily')
          AND alert_count=(SELECT count(*) FROM subscriptions WHERE kind='alert') RETURNING import_id`,
      [importId, run.daily_count, run.alert_count, importId, importId, importId]);
      if (!sealed) throw fail('SUBSCRIPTION_IMPORT_VERIFICATION_FAILED');
      return { verified: true, count: checked, daily: run.daily_count, alert: run.alert_count };
    }
    afterKind = rows.at(-1).kind; afterEmail = rows.at(-1).email;
  }
  throw fail('SUBSCRIPTION_SCAN_LIMIT');
}
