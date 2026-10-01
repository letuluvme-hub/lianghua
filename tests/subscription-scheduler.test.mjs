import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sendDueSubscriptions, sendDueAlerts, currentShanghaiParts } from '../subscription-worker.js';
import { collectUniverse } from '../snapshot-store.js';
import { writeSubscription, readSubscription, deleteSubscription } from '../subscription-store.js';
import { createD1, createKV } from './helpers/d1-sqlite.mjs';

const email = 'subscriber@example.test';
const daily = (extras = {}) => ({ email, sendTime: '16:00', stocks: ['600036'], period: 20, multipliers: [1,2,3], timezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00Z', lastSentDate: null, ...extras });
const alert = (extras = {}) => ({ email, stocks: ['600036'], period: 20, multiplier: 2, condition: 'above', timezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00Z', lastAlertKeys: [], lastAlertAt: null, ...extras });
function environment(t, entries = []) {
  const DB = createD1({ ready: true }); t.after(() => DB.close());
  return { DB, SUBSCRIPTION_STORAGE_MODE: 'd1', SUBSCRIPTIONS: createKV(entries), RESEND_API_KEY: 'test-not-a-secret', RESEND_FROM_EMAIL: 'test@example.test' };
}
function clock(t, now='2026-10-01T08:00:00Z') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
}
function networking(t, { onQuote, onMail, noQuotes=false } = {}) {
  const mails=[]; let quotes=0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init={}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'money.finance.sina.com.cn') {
      quotes++; await onQuote?.();
      const rows = noQuotes ? [] : Array.from({ length: 20 }, (_, i) => ({ day: new Date(Date.UTC(2026,8,12+i)).toISOString().slice(0,10), open: 10, close: i===19 ? 100 : 10, high: 100, low: 10, volume: 1000 }));
      return Response.json(rows);
    }
    if (parsed.href === 'https://api.resend.com/emails') {
      const data = JSON.parse(init.body); mails.push({ data, headers: init.headers });
      await onMail?.(data);
      return Response.json({ id: 'test-mail' });
    }
    throw new Error('Unexpected network request blocked by offline test');
  });
  return { mails, get quotes() { return quotes; } };
}

test('1,440 minute ticks preserve selected-minute send and perform zero KV LIST/GET for subscriptions', async t => {
  clock(t); const env=environment(t); const net=networking(t);
  await writeSubscription(env,'daily',daily());
  const start=Date.parse('2026-09-30T16:00:00Z');
  for(let minute=0;minute<1440;minute++) {
    t.mock.timers.setTime(start+minute*60_000);
    await sendDueSubscriptions(env);
    await sendDueAlerts(env);
  }
  assert.equal(net.mails.length,1);
  assert.equal(net.quotes,1);
  assert.equal((await readSubscription(env,'daily',email)).lastSentDate,'2026-10-01');
  assert.equal(env.SUBSCRIPTIONS.calls.length,0);
  assert.match(net.mails[0].headers['Idempotency-Key'],/^subscription-/);
});

test('Shanghai midnight formatting, daily dedupe and forced-send behavior stay intact', async t => {
  clock(t,'2026-09-30T16:00:00Z'); const env=environment(t); const net=networking(t);
  assert.deepEqual(currentShanghaiParts(),{ date:'2026-10-01',time:'00:00' });
  await writeSubscription(env,'daily',daily({sendTime:'00:00'}));
  await sendDueSubscriptions(env); await sendDueSubscriptions(env);
  assert.equal(net.mails.length,1);
  await sendDueSubscriptions(env,true);
  assert.equal(net.mails.length,2);
  t.mock.timers.setTime(Date.parse('2026-10-01T16:00:00Z'));
  await sendDueSubscriptions(env);
  assert.equal(net.mails.length,3);
});

test('intraday alerts still check every minute and retain previous alert dedupe keys', async t => {
  clock(t);const env=environment(t);const net=networking(t);
  await writeSubscription(env,'alert',alert());
  env.DB.sqlite.prepare('UPDATE subscriptions SET last_alert_keys_json=?').run(JSON.stringify(['old-alert-key']));
  for(let n=0;n<3;n++){await sendDueAlerts(env);t.mock.timers.tick(60_000);}
  assert.equal(net.quotes,3);assert.equal(net.mails.length,1);
  const state=await readSubscription(env,'alert',email);
  assert.equal(state.lastAlertKeys.length,2);assert.ok(state.lastAlertKeys.includes('old-alert-key'));
  assert.equal(env.SUBSCRIPTIONS.calls.length,0);
});

test('unsubscribe during quote work prevents send and does not resurrect the subscription', async t => {
  clock(t);const env=environment(t);const net=networking(t,{onQuote:()=>deleteSubscription(env,'daily',email)});
  await writeSubscription(env,'daily',daily());await sendDueSubscriptions(env);
  assert.equal(net.mails.length,0);assert.equal(await readSubscription(env,'daily',email),null);
});

test('config edit during quote work prevents stale email and allows next current invocation', async t => {
  clock(t);const env=environment(t);let first=true;
  const net=networking(t,{onQuote:async()=>{if(first){first=false;await writeSubscription(env,'daily',daily({period:19}));}}});
  await writeSubscription(env,'daily',daily());await sendDueSubscriptions(env);
  assert.equal(net.mails.length,0);
  await sendDueSubscriptions(env);assert.equal(net.mails.length,1);
  assert.equal((await readSubscription(env,'daily',email)).period,19);
});

test('unsubscribe after provider acceptance cannot be undone by delivery completion', async t => {
  clock(t);const env=environment(t);const net=networking(t,{onMail:()=>deleteSubscription(env,'daily',email)});
  await writeSubscription(env,'daily',daily());await sendDueSubscriptions(env);
  assert.equal(net.mails.length,1);assert.equal(await readSubscription(env,'daily',email),null);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM subscriptions').get().n,0);
});

test('unknown provider result remains held, never automatically resends even after lease expiry', async t => {
  clock(t);const env=environment(t);const net=networking(t,{onMail:()=>{throw new Error('simulated connection loss')}});
  await writeSubscription(env,'daily',daily());await sendDueSubscriptions(env);
  env.DB.sqlite.exec('UPDATE subscriptions SET lease_until=0');
  await sendDueSubscriptions(env,true);
  assert.equal(net.mails.length,1);
  assert.equal(env.DB.sqlite.prepare('SELECT delivery_phase FROM subscriptions').get().delivery_phase,'sending');
  assert.equal((await readSubscription(env,'daily',email)).lastSentDate,null);
});

test('quote failure releases unprepared claim; later invocation can recover', async t => {
  clock(t);const env=environment(t);const net=networking(t,{noQuotes:true});
  await writeSubscription(env,'daily',daily());await sendDueSubscriptions(env);
  assert.equal(net.mails.length,0);
  assert.equal(env.DB.sqlite.prepare('SELECT delivery_phase FROM subscriptions').get().delivery_phase,null);
});

test('handover returns503 for subscription edits and leaves health route intact', async t => {
  clock(t);const env={...environment(t),SUBSCRIPTION_STORAGE_MODE:'handover'};const net=networking(t);
  const response=await worker.fetch(new Request('https://example.test/api/subscribe',{method:'POST',body:JSON.stringify(daily())}),env);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'SUBSCRIPTION_HANDOVER');
  assert.equal((await worker.fetch(new Request('https://example.test/api/health'),env)).status,200);
  assert.equal(net.mails.length,0);assert.equal(env.SUBSCRIPTIONS.calls.length,0);
});

test('snapshot universe reads daily/alert records from D1 and only watchlists from KV', async t => {
  clock(t);const env=environment(t,[['watchlist:other@example.test',{codes:['123456']}]]);
  await writeSubscription(env,'daily',daily({stocks:['654321'],period:35}));
  await writeSubscription(env,'alert',alert({stocks:['777777'],period:45}));
  const result=await collectUniverse(env);
  assert.ok(result.codes.includes('654321'));assert.ok(result.codes.includes('777777'));assert.ok(result.codes.includes('123456'));
  assert.ok(result.periods.includes(35));assert.ok(result.periods.includes(45));
  assert.deepEqual(env.SUBSCRIPTIONS.calls.filter(x=>x.type==='list').map(x=>x.prefix),['watchlist:']);
});

test('legacy daily send still updates original KV record and emits no new idempotency behavior', async t => {
  clock(t);const env={SUBSCRIPTIONS:createKV([['sub:'+email,daily()]]),RESEND_API_KEY:'fake',RESEND_FROM_EMAIL:'test@example.test'};const net=networking(t);
  await sendDueSubscriptions(env);await sendDueSubscriptions(env);
  assert.equal(net.mails.length,1);assert.equal(net.mails[0].headers['Idempotency-Key'],undefined);
  assert.equal(JSON.parse(env.SUBSCRIPTIONS.values.get('sub:'+email)).lastSentDate,'2026-10-01');
});

test('idle intraday alert scans perform zero D1 writes, avoiding a replacement quota bottleneck', async t => {
  clock(t);const env=environment(t);const net=networking(t);
  await writeSubscription(env,'alert',alert({condition:'below'}));
  env.DB.calls.length=0;
  for(let n=0;n<1440;n++){await sendDueAlerts(env);t.mock.timers.tick(60_000);}
  assert.equal(net.quotes,1440);assert.equal(net.mails.length,0);
  assert.equal(env.DB.calls.filter(x=>/^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql??'')).length,0);
  assert.equal(env.SUBSCRIPTIONS.calls.length,0);
});
