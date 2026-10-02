import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite query execution, including UPDATE/INSERT RETURNING, constraints,
// transactional batches, CAS predicates and the explicit additive migration.
export function createD1({ migrate = true, ready = false, sessions = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const calls = [];
  const db = { sqlite, calls, failSQL: null, close: () => sqlite.close() };
  function statement(sql, args = [], session = null) {
    function execute() {
      calls.push({ sql, args, session });
      if (db.failSQL?.test(sql)) throw new Error('Simulated D1 failure');
      const rows = sqlite.prepare(sql).all(...args).map((row) => ({ ...row }));
      const changes = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql) ? 0 : sqlite.prepare('SELECT changes() AS n').get().n;
      return { success: true, results: rows, meta: { changes, served_by_primary: true } };
    }
    return {
      bind: (...values) => statement(sql, values, session),
      all: async () => execute(),
      run: async () => execute(),
      first: async (column) => { const row = execute().results[0] ?? null; return column ? row?.[column] ?? null : row; },
      _execute: execute,
    };
  }
  function executor(session = null) {
    return {
      prepare: (sql) => statement(sql, [], session),
      batch: async (statements) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try { const results = statements.map((item) => item._execute()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    };
  }
  Object.assign(db, executor());
  if (sessions) db.withSession = (constraint) => {
    if (constraint !== 'first-primary') throw new Error('Authoritative reads must start at primary');
    const id = calls.filter((call) => call.type === 'session').length + 1;
    calls.push({ type: 'session', constraint, id });
    return executor(id);
  };
  if (migrate) sqlite.exec(readFileSync(new URL('../../migrations/0001-subscriptions.sql', import.meta.url), 'utf8'));
  if (ready) sqlite.exec(`
    INSERT INTO subscription_import_runs
      (import_id,status,daily_complete,alert_complete,daily_count,alert_count,verified_daily_count,verified_alert_count,verified_at)
      VALUES ('fixture-verified-empty','verified',1,1,0,0,0,0,'2026-10-01T00:00:00Z');
    UPDATE subscription_storage_control SET import_id='fixture-verified-empty',ready=1 WHERE singleton=1;
  `);
  return db;
}

export function createKV(entries = [], { pageSize = 100 } = {}) {
  const values = new Map(entries.map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const calls = [];
  return {
    values, calls,
    get: async (key) => { calls.push({ type: 'get', key }); return values.get(key) ?? null; },
    put: async (key, value) => { calls.push({ type: 'put', key }); values.set(key, value); },
    delete: async (key) => { calls.push({ type: 'delete', key }); values.delete(key); },
    list: async ({ prefix = '', cursor = '', limit = 1000 } = {}) => {
      calls.push({ type: 'list', prefix, cursor, limit });
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(cursor || 0); const end = Math.min(start + Math.min(pageSize, limit), keys.length);
      return { keys: keys.slice(start, end).map((name) => ({ name })), list_complete: end >= keys.length, cursor: end < keys.length ? String(end) : '' };
    },
  };
}
