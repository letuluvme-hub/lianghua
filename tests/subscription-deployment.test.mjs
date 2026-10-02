import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../deploy-subscription-worker.js', import.meta.url), 'utf8');
const account = 'a'.repeat(32);
const namespaceId = 'b'.repeat(32);
const databaseId = '11111111-2222-3333-4444-555555555555';
const scriptPath = `/accounts/${account}/workers/scripts/boll-alert-subscriptions`;
function deployment(options = {}) {
  const calls = []; const output = []; const files = []; let uploaded = null; let scheduleReads = 0;
  const bindings = options.bindings ?? [
    { type: 'kv_namespace', name: 'SUBSCRIPTIONS', namespace_id: namespaceId },
    { type: 'd1', name: 'DB', id: databaseId },
    { type: 'plain_text', name: 'SUBSCRIPTION_STORAGE_MODE', text: 'handover' },
    { type: 'plain_text', name: 'QUANT_AUTOMATION_PAUSED', text: '1' },
    { type: 'plain_text', name: 'UNRELATED_SETTING', text: 'preserve-me' },
    { type: 'secret_text', name: 'RESEND_API_KEY' },
    { type: 'secret_text', name: 'ALERT_SECRET' },
  ];
  const settings = {
    bindings, compatibility_date: '2025-09-01', compatibility_flags: ['nodejs_compat'],
    logpush: false, observability: { enabled: false, head_sampling_rate: 0.25 },
    placement: { mode: 'smart', status: 'SUCCESS' }, limits: { cpu_ms: 100, subrequests: 50 },
    usage_model: 'standard', tags: ['keep-tag'], tail_consumers: [{ service: 'existing-log-consumer' }],
    ...options.settingsOverrides,
  };
  const respond = (result) => Response.json({ success: true, result });
  const context = vm.createContext({
    process: { env: { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'mock-token', ...options.env } },
    module: { exports: {} },
    require: (name) => {
      assert.equal(name, 'node:fs/promises');
      return { readFile: async (file) => { files.push(file); return `// Mock ${file}`; } };
    },
    console: { log: (value) => output.push(JSON.parse(value)), error: () => assert.fail('Unexpected console.error') },
    Blob, FormData,
    fetch: async (url, init = {}) => {
      const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.cloudflare.com');
      const path = parsed.pathname.replace('/client/v4', ''); const method = init.method ?? 'GET';
      calls.push({ path, method });
      if (path === `${scriptPath}/settings`) {
        if (options.settingsDenied) return Response.json({ success: false, errors: [{ message: 'SECRET_RESPONSE_MUST_NOT_LEAK' }] }, { status: 403 });
        return respond(options.malformedSettings ? {} : { ...settings, ...(uploaded ? options.afterSettingsOverrides : {}) });
      }
      if (path === `/accounts/${account}/storage/kv/namespaces`) return respond(options.missingKV ? [] : [{ id: namespaceId, title: 'boll_alert_subscriptions' }]);
      if (path === `/accounts/${account}/d1/database`) return respond(options.missingDB ? [] : [{ uuid: databaseId, name: 'boll_snapshots' }]);
      if (path === `${scriptPath}/schedules`) {
        assert.equal(method, 'GET', 'Deployment must NEVER write schedules');
        scheduleReads += 1;
        if (options.malformedSchedules) return respond({});
        const schedules = scheduleReads > 1 && options.afterSchedules !== undefined ? options.afterSchedules : options.schedules ?? [];
        return respond({ schedules: schedules.map((cron) => ({ cron, created_on: 'before', modified_on: String(scheduleReads) })) });
      }
      if (path === `${scriptPath}/subdomain`) {
        assert.equal(method, 'GET', 'Deployment must not change site exposure');
        return respond({ enabled: options.workersDevEnabled ?? true });
      }
      if (path === `/accounts/${account}/workers/subdomain`) return respond({ subdomain: 'existing-account' });
      if (path === scriptPath && method === 'PUT') {
        assert.equal(parsed.searchParams.get('bindings_inherit'), 'strict', 'Unresolved inherit bindings must fail closed');
        if (options.inheritRejected) return Response.json({ success: false, errors: [{ message: 'inherit cannot resolve' }] }, { status: 400 });
        uploaded = JSON.parse(await init.body.get('metadata').text());
        assert.ok(init.body.get('subscription-store.js')); return respond({ id: 'existing-worker' });
      }
      assert.fail(`Unexpected deployment request: ${method} ${path}`);
    },
  });
  vm.runInContext(source, context, { filename: 'deploy-subscription-worker.js' });
  return { calls, output, files, main: context.module.exports.main, metadata: () => uploaded };
}
function writes(fixture) { return fixture.calls.filter((call) => call.method !== 'GET'); }

test('deployment preserves empty schedules, pause/mode/other bindings and every existing resource', async () => {
  const fixture = deployment(); await fixture.main();
  assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]);
  assert.deepEqual(fixture.output[0].schedules, []);
  assert.equal(fixture.output[0].schedulePolicy, 'preserved');
  assert.equal(fixture.output[0].automationPause, 'preserved');
  const bindings = fixture.metadata().bindings;
  for (const name of ['QUANT_AUTOMATION_PAUSED', 'SUBSCRIPTION_STORAGE_MODE', 'UNRELATED_SETTING', 'RESEND_API_KEY', 'ALERT_SECRET']) {
    assert.deepEqual(bindings.find((binding) => binding.name === name), { type: 'inherit', name });
  }
  assert.equal(bindings.find((binding) => binding.name === 'DB').database_id, databaseId);
  assert.equal(bindings.find((binding) => binding.name === 'SUBSCRIPTIONS').namespace_id, namespaceId);
  assert.equal(fixture.files.length, 5);
});

test('existing schedules are preserved without rewriting timestamps or assuming minute cron', async () => {
  const fixture = deployment({ schedules: ['30 8 * * 1', '0 0 * * *'] }); await fixture.main();
  assert.deepEqual(fixture.output[0].schedules, ['0 0 * * *', '30 8 * * 1']);
  assert.equal(fixture.calls.filter((call) => call.path.endsWith('/schedules')).length, 2);
  assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]);
});

test('an explicit pause may be set, but false/empty values cannot clear it or resume automation', async () => {
  const fixture = deployment({ env: { QUANT_AUTOMATION_PAUSED: '1', SUBSCRIPTION_STORAGE_MODE: 'handover' } });
  await fixture.main();
  assert.deepEqual(fixture.metadata().bindings.find((binding) => binding.name === 'QUANT_AUTOMATION_PAUSED'), { type: 'plain_text', name: 'QUANT_AUTOMATION_PAUSED', text: '1' });
  for (const value of ['0', 'false', '']) {
    const rejected = deployment({ env: { QUANT_AUTOMATION_PAUSED: value } });
    await assert.rejects(rejected.main(), /cannot resume automation/); assert.equal(rejected.calls.length, 0);
  }
});

test('missing KV/D1, unknown settings, malformed schedules or mismatched resource IDs fail before upload', async () => {
  for (const options of [{ missingKV: true }, { missingDB: true }, { malformedSettings: true }, { malformedSchedules: true }, { settingsOverrides: { compatibility_date: null } }, {
    bindings: [{ name: 'SUBSCRIPTIONS', namespace_id: 'wrong-id' }, { name: 'DB', id: databaseId }],
  }]) {
    const fixture = deployment(options);
    await assert.rejects(fixture.main()); assert.equal(writes(fixture).length, 0);
  }
});

test('permission failures never print provider response bodies or replace unknown bindings', async () => {
  const fixture = deployment({ settingsDenied: true });
  await assert.rejects(fixture.main(), (error) => error.message.includes('HTTP 403') && !error.message.includes('SECRET_RESPONSE'));
  assert.equal(writes(fixture).length, 0); assert.equal(fixture.output.length, 0);
});

test('existing disabled workers.dev exposure stays disabled; DB removal is rejected', async () => {
  const fixture = deployment({ workersDevEnabled: false }); await fixture.main();
  assert.equal(fixture.output[0].workersDevEnabled, false); assert.equal(fixture.output[0].workerUrl, null);
  assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]);
  const rejected = deployment({ env: { DISABLE_D1: '1' } });
  await assert.rejects(rejected.main(), /Refusing to remove/); assert.equal(rejected.calls.length, 0);
});

test('post-upload schedule drift is reported without silently rewriting the concurrent schedule', async () => {
  const fixture = deployment({ schedules: [], afterSchedules: ['* * * * *'] });
  await assert.rejects(fixture.main(), /Worker uploaded, but schedules changed concurrently/);
  assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]); assert.equal(fixture.output.length, 0);
});

test('code upload preserves existing runtime, observability, limits and billing metadata', async () => {
  const fixture = deployment(); await fixture.main(); const metadata = fixture.metadata();
  assert.equal(metadata.compatibility_date, '2025-09-01');
  assert.deepEqual(metadata.compatibility_flags, ['nodejs_compat']);
  assert.equal(metadata.logpush, false);
  assert.deepEqual(metadata.observability, { enabled: false, head_sampling_rate: 0.25 });
  assert.deepEqual(metadata.placement, { mode: 'smart', status: 'SUCCESS' });
  assert.deepEqual(metadata.limits, { cpu_ms: 100, subrequests: 50 });
  assert.equal(metadata.usage_model, 'standard'); assert.deepEqual(metadata.tags, ['keep-tag']);
  assert.deepEqual(metadata.tail_consumers, [{ service: 'existing-log-consumer' }]);
  assert.equal(metadata.keep_assets, undefined);
});

test('strict inherit rejection stops deployment instead of accepting dropped pause or secret bindings', async () => {
  const fixture = deployment({ inheritRejected: true });
  await assert.rejects(fixture.main(), /HTTP 400/);
  assert.equal(fixture.output.length, 0); assert.equal(fixture.metadata(), null);
  assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]);
});

test('D1 binding supports database_id or deprecated id and rejects conflicting identifiers', async () => {
  const base = [{ type: 'kv_namespace', name: 'SUBSCRIPTIONS', namespace_id: namespaceId }];
  for (const fields of [{ database_id: databaseId }, { id: databaseId }, { database_id: databaseId, id: databaseId }]) {
    const fixture = deployment({ bindings: [...base, { type: 'd1', name: 'DB', ...fields }] });
    await fixture.main(); assert.equal(fixture.metadata().bindings.find((binding) => binding.name === 'DB').database_id, databaseId);
  }
  const bad = deployment({ bindings: [...base, { type: 'd1', name: 'DB', database_id: databaseId, id: 'different' }] });
  await assert.rejects(bad.main(), /Conflicting/); assert.equal(writes(bad).length, 0);
});

test('nonempty unsupported assets, exports or cache settings fail before code upload', async () => {
  for (const settingsOverrides of [{ assets: { config: { html_handling: 'auto-trailing-slash' } } }, { exports: { DurableData: { type: 'durable_object' } } }, { cache_options: { enabled: false } }, { has_assets: true }]) {
    const fixture = deployment({ settingsOverrides });
    await assert.rejects(fixture.main(), /Unsupported|assets require/); assert.equal(writes(fixture).length, 0);
  }
});

test('postflight metadata drift fails verification without exposing values or overwriting the drift', async () => {
  const fixture = deployment({ afterSettingsOverrides: { logpush: true } });
  await assert.rejects(fixture.main(), /preserved setting logpush differs/);
  assert.equal(fixture.output.length, 0); assert.deepEqual(writes(fixture), [{ method: 'PUT', path: scriptPath }]);
});
