-- Apply explicitly. This additive migration does not enable D1 subscription storage.
-- No runtime DDL. Existing snapshot tables and KV data are untouched.
CREATE TABLE IF NOT EXISTS subscription_storage_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  import_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO subscription_storage_control (singleton, schema_version, ready)
VALUES (1, 1, 0);

CREATE TABLE IF NOT EXISTS subscriptions (
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'alert')),
  email TEXT NOT NULL,
  generation TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  last_sent_date TEXT,
  last_alert_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(last_alert_keys_json)),
  last_alert_at TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  attempt_id TEXT,
  delivery_phase TEXT CHECK (delivery_phase IN ('claimed', 'sending')),
  prepared_state_json TEXT CHECK (prepared_state_json IS NULL OR json_valid(prepared_state_json)),
  PRIMARY KEY (kind, email),
  CHECK ((lease_owner IS NULL AND lease_until IS NULL AND attempt_id IS NULL AND delivery_phase IS NULL AND prepared_state_json IS NULL)
      OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL AND attempt_id IS NOT NULL AND delivery_phase IS NOT NULL)),
  CHECK (delivery_phase IS NOT 'sending' OR prepared_state_json IS NOT NULL)
);

-- Scheduled daily dispatch can seek only this minute's subscribers.
CREATE INDEX IF NOT EXISTS subscriptions_daily_send_time
ON subscriptions(kind, json_extract(config_json, '$.sendTime'), email);

-- Temporary migration data only. Delete staging rows on successful activation.
-- There are no unsubscribe tombstones: DELETE physically removes a subscription.
CREATE TABLE IF NOT EXISTS subscription_import_runs (
  import_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'promoting', 'promoted', 'verified', 'activated')),
  daily_cursor TEXT NOT NULL DEFAULT '',
  alert_cursor TEXT NOT NULL DEFAULT '',
  daily_complete INTEGER NOT NULL DEFAULT 0 CHECK (daily_complete IN (0, 1)),
  alert_complete INTEGER NOT NULL DEFAULT 0 CHECK (alert_complete IN (0, 1)),
  daily_count INTEGER CHECK (daily_count IS NULL OR daily_count >= 0),
  alert_count INTEGER CHECK (alert_count IS NULL OR alert_count >= 0),
  verified_daily_count INTEGER CHECK (verified_daily_count IS NULL OR verified_daily_count >= 0),
  verified_alert_count INTEGER CHECK (verified_alert_count IS NULL OR verified_alert_count >= 0),
  verified_at TEXT,
  promote_kind TEXT NOT NULL DEFAULT '',
  promote_email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS subscription_import_staging (
  import_id TEXT NOT NULL REFERENCES subscription_import_runs(import_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'alert')),
  email TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  generation TEXT NOT NULL,
  PRIMARY KEY (import_id, kind, email)
);
-- Readiness is a sealed cutover transition, not just an operator-controlled bit.
-- Counts are captured at source completion and verification, before staged
-- personal copies are purged. Empty imports still require both completed streams.
CREATE TRIGGER IF NOT EXISTS subscription_ready_requires_verified_import_update
BEFORE UPDATE OF ready, import_id, schema_version ON subscription_storage_control
WHEN NEW.ready=1 AND (
  NEW.import_id IS NULL
  OR EXISTS (SELECT 1 FROM subscription_import_staging LIMIT 1)
  OR EXISTS (SELECT 1 FROM subscription_import_runs
    WHERE promote_email<>'' OR daily_cursor<>'' OR alert_cursor<>'' LIMIT 1)
  OR NOT EXISTS (
    SELECT 1 FROM subscription_import_runs r
    WHERE r.import_id=NEW.import_id AND r.status IN ('verified', 'activated')
      AND r.daily_complete=1 AND r.alert_complete=1
      AND r.promote_email='' AND r.promote_kind='' AND r.daily_cursor='' AND r.alert_cursor=''
      AND r.verified_at IS NOT NULL
      AND r.daily_count=r.verified_daily_count
      AND r.alert_count=r.verified_alert_count
      AND r.verified_daily_count=(SELECT count(*) FROM subscriptions WHERE kind='daily')
      AND r.verified_alert_count=(SELECT count(*) FROM subscriptions WHERE kind='alert')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Verified complete import, matching target counts and empty staging required before activation');
END;
CREATE TRIGGER IF NOT EXISTS subscription_ready_requires_verified_import_insert
BEFORE INSERT ON subscription_storage_control
WHEN NEW.ready=1 AND (
  NEW.import_id IS NULL
  OR EXISTS (SELECT 1 FROM subscription_import_staging LIMIT 1)
  OR EXISTS (SELECT 1 FROM subscription_import_runs
    WHERE promote_email<>'' OR daily_cursor<>'' OR alert_cursor<>'' LIMIT 1)
  OR NOT EXISTS (
    SELECT 1 FROM subscription_import_runs r
    WHERE r.import_id=NEW.import_id AND r.status IN ('verified', 'activated')
      AND r.daily_complete=1 AND r.alert_complete=1
      AND r.promote_email='' AND r.promote_kind='' AND r.daily_cursor='' AND r.alert_cursor=''
      AND r.verified_at IS NOT NULL
      AND r.daily_count=r.verified_daily_count
      AND r.alert_count=r.verified_alert_count
      AND r.verified_daily_count=(SELECT count(*) FROM subscriptions WHERE kind='daily')
      AND r.verified_alert_count=(SELECT count(*) FROM subscriptions WHERE kind='alert')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Verified complete import, matching target counts and empty staging required before activation');
END;
