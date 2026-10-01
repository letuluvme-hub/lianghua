#!/usr/bin/env node
// Explicit operator utility only. No schema creation, worker configuration, email,
// deletion/cleanup, or activation. Its only writes are bounded staging/promotion.
import { pathToFileURL } from 'node:url';
import {
  getSubscriptionStorageStatus, getSubscriptionImportStatus, beginSubscriptionImport,
  readLegacySubscriptionPage, stageSubscriptionImportPage,
  promoteSubscriptionImportPage, verifySubscriptionImport,
} from '../subscription-store.js';

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'boll-alert-subscriptions';
const EXPECTED_NAMESPACE = 'cd3da0fe397f42f288c6a29cd06c11b5';
const LIMIT = 100;
const safeCode = (error) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'SUBSCRIPTION_IMPORT_FAILED';
function fail(code) { return Object.assign(new Error('Subscription import stopped.'), { code }); }
function summary(status) {
  return {
    phase: status?.status ?? null,
    dailyComplete: status?.daily_complete === 1,
    alertComplete: status?.alert_complete === 1,
    stagedDaily: status?.staged_daily ?? 0,
    stagedAlert: status?.staged_alert ?? 0,
    promotedDaily: status?.promoted_daily ?? 0,
    promotedAlert: status?.promoted_alert ?? 0,
  };
}
export function parseArguments(argv) {
  const command = argv[0] ?? 'status';
  if (!['status', 'begin', 'scan-page', 'promote-page', 'verify'].includes(command)) throw fail('SUBSCRIPTION_IMPORT_INVALID_COMMAND');
  const allowed = new Set(['--apply', '--handover-confirmed', '--dispatch-drained']);
  const flags = new Set(); let importId;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--import-id=')) importId = arg.slice('--import-id='.length);
    else if (allowed.has(arg)) flags.add(arg);
    else throw fail('SUBSCRIPTION_IMPORT_INVALID_ARGUMENT');
  }
  if (command !== 'status' && (!importId || !/^[A-Za-z0-9_-]{1,100}$/.test(importId))) throw fail('SUBSCRIPTION_IMPORT_ID_REQUIRED');
  const mutating = ['begin', 'scan-page', 'promote-page', 'verify'].includes(command);
  if (mutating && !['--apply', '--handover-confirmed', '--dispatch-drained'].every(x => flags.has(x))) throw fail('SUBSCRIPTION_IMPORT_APPROVAL_FLAGS_REQUIRED');
  return { command, importId, mutating };
}

export async function createRestEnvironment(env, { fetchImpl = fetch, now = Date.now, requireHandover = true } = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) throw fail('SUBSCRIPTION_IMPORT_CREDENTIALS_MISSING');
  const started = now(); let calls = 0;
  const call = async (path, init = {}) => {
    calls += 1;
    if (calls > 256 || now() - started > 120000) throw fail('SUBSCRIPTION_IMPORT_REQUEST_BUDGET');
    const response = await fetchImpl(API + path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if ([401, 403].includes(response.status)) throw fail('SUBSCRIPTION_IMPORT_PERMISSION_DENIED');
    if (!response.ok) throw fail('SUBSCRIPTION_IMPORT_HTTP_ERROR');
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw fail('SUBSCRIPTION_IMPORT_RESPONSE_TOO_LARGE');
    return text;
  };
  const json = async (path, init) => {
    let body; try { body = JSON.parse(await call(path, init)); } catch (e) { if (e?.code) throw e; throw fail('SUBSCRIPTION_IMPORT_INVALID_JSON'); }
    if (body?.success !== true || body?.errors?.length) throw fail('SUBSCRIPTION_IMPORT_API_ERROR');
    return body.result;
  };
  const settings = await json(`/accounts/${account}/workers/scripts/${SCRIPT}/settings`);
  const bindings = settings?.bindings ?? [];
  const mode = bindings.find(x => x.name === 'SUBSCRIPTION_STORAGE_MODE' && x.type === 'plain_text')?.text ?? 'legacy';
  const namespace = bindings.find(x => x.name === 'SUBSCRIPTIONS' && x.type === 'kv_namespace')?.namespace_id;
  const database = bindings.find(x => x.name === 'DB' && x.type === 'd1')?.id;
  if (!['legacy', 'handover', 'd1'].includes(mode) || requireHandover && mode !== 'handover') throw fail('SUBSCRIPTION_IMPORT_LIVE_HANDOVER_REQUIRED');
  if (namespace !== EXPECTED_NAMESPACE || !/^[a-f0-9-]{36}$/.test(database ?? '')) throw fail('SUBSCRIPTION_IMPORT_BINDING_MISMATCH');
  const dbPath = `/accounts/${account}/d1/database/${database}/query`;
  const query = async (body) => {
    const results = await json(dbPath, { method: 'POST', body: JSON.stringify(body) });
    if (!Array.isArray(results) || results.some(r => r.success === false)) throw fail('SUBSCRIPTION_IMPORT_D1_ERROR');
    return results;
  };
  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    async all() { return (await query({ sql: this.sql, params: this.params }))[0]; }
  }
  const DB = {
    prepare: (sql) => new Statement(sql),
    batch: (statements) => query({ batch: statements.map(s => ({ sql: s.sql, params: s.params })) }),
  };
  const SUBSCRIPTIONS = {
    async list({ prefix, cursor = '', limit = LIMIT }) {
      if (!['sub:', 'alert:'].includes(prefix) || limit < 1 || limit > LIMIT) throw fail('SUBSCRIPTION_IMPORT_PREFIX_REJECTED');
      const query = new URLSearchParams({ prefix, limit: String(limit), ...(cursor ? { cursor } : {}) });
      let data; try { data = JSON.parse(await call(`/accounts/${account}/storage/kv/namespaces/${namespace}/keys?${query}`)); } catch(e) { if(e?.code) throw e; throw fail('SUBSCRIPTION_IMPORT_INVALID_JSON'); }
      if (data.success !== true || !Array.isArray(data.result)) throw fail('SUBSCRIPTION_IMPORT_INVALID_KV_PAGE');
      return { keys: data.result.map(k => ({ name: k.name })), list_complete: !data.result_info?.cursor, cursor: data.result_info?.cursor || '' };
    },
    async get(key) {
      if (!/^(sub:|alert:).+/.test(key)) throw fail('SUBSCRIPTION_IMPORT_PREFIX_REJECTED');
      return call(`/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`);
    },
  };
  return { SUBSCRIPTION_STORAGE_MODE: mode, DB, SUBSCRIPTIONS };
}

export async function runImportCommand(options, env) {
  const { command, importId } = options;
  const control = await getSubscriptionStorageStatus(env);
  if (command === 'status') return { mode: control.mode, ready: control.ready, schemaVersion: control.schemaVersion, hasImport: Boolean(control.importId), ...(control.importId ? summary(await getSubscriptionImportStatus(env, control.importId)) : {}) };
  if (control.mode !== 'handover' || control.ready) throw fail('SUBSCRIPTION_IMPORT_FROZEN_STATE_REQUIRED');
  if (command === 'begin') return summary(await beginSubscriptionImport(env, { importId }));
  if (command === 'verify') return verifySubscriptionImport(env, importId);
  if (command === 'promote-page') {
    const result = await promoteSubscriptionImportPage(env, { importId, limit: LIMIT });
    return { complete: result.complete, promoted: result.promoted, ...summary(result.status) };
  }
  const status = await getSubscriptionImportStatus(env, importId);
  if (!status) throw fail('SUBSCRIPTION_IMPORT_NOT_FOUND');
  const kind = !status.daily_complete ? 'daily' : !status.alert_complete ? 'alert' : null;
  if (!kind) return { complete: true, ...summary(status) };
  const expectedCursor = status[`${kind}_cursor`] || '';
  const page = await readLegacySubscriptionPage(env, kind, expectedCursor, LIMIT);
  const result = await stageSubscriptionImportPage(env, { importId, kind, expectedCursor, ...page });
  return { kind, pageRecords: page.records.length, ...summary(result) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const env = await createRestEnvironment(process.env, { requireHandover: options.command !== 'status' });
    console.log(JSON.stringify({ ok: true, result: await runImportCommand(options, env) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: safeCode(error) }));
    process.exitCode = 1;
  }
}
