-- Release 3.0 / Build 1.1: Schema and Model Versioning
-- Additive foundation for production/challenger models, immutable predictions,
-- exact feature values, and future ingestion health tracking.

-- Extend the existing model registry without changing current model execution.
ALTER TABLE model_versions ADD COLUMN model_role TEXT NOT NULL DEFAULT 'ARCHIVED'
  CHECK (model_role IN ('PRODUCTION', 'CHALLENGER', 'ARCHIVED', 'DISABLED'));
ALTER TABLE model_versions ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (lifecycle_status IN ('DRAFT', 'ACTIVE', 'RETIRED'));
ALTER TABLE model_versions ADD COLUMN code_identifier TEXT;
ALTER TABLE model_versions ADD COLUMN feature_schema_version TEXT;
ALTER TABLE model_versions ADD COLUMN config_json TEXT;
ALTER TABLE model_versions ADD COLUMN release_notes TEXT;
ALTER TABLE model_versions ADD COLUMN activated_at TEXT;
ALTER TABLE model_versions ADD COLUMN retired_at TEXT;
ALTER TABLE model_versions ADD COLUMN updated_at TEXT;

-- Preserve the existing is_active behavior and label the current active model as production.
UPDATE model_versions
SET model_role = CASE WHEN is_active = 1 THEN 'PRODUCTION' ELSE 'ARCHIVED' END,
    lifecycle_status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE lifecycle_status END,
    activated_at = CASE WHEN is_active = 1 THEN COALESCE(activated_at, CURRENT_TIMESTAMP) ELSE activated_at END,
    code_identifier = CASE
      WHEN version_name = 'v13-directional-calibration' THEN 'src/index.ts:v13-directional-calibration'
      ELSE code_identifier
    END,
    feature_schema_version = COALESCE(feature_schema_version, 'legacy-feature-snapshot-v1'),
    updated_at = CURRENT_TIMESTAMP;

-- Enforce no more than one production model while still allowing zero during a controlled switch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_versions_single_production
  ON model_versions(model_role)
  WHERE model_role = 'PRODUCTION';

CREATE INDEX IF NOT EXISTS idx_model_versions_role_status
  ON model_versions(model_role, lifecycle_status, created_at DESC);

-- Immutable prediction ledger. Existing recommendations remain the production-facing current-state table.
CREATE TABLE IF NOT EXISTS model_predictions (
  model_prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_uuid TEXT NOT NULL UNIQUE,
  prop_id INTEGER NOT NULL,
  model_version_id INTEGER NOT NULL,
  feature_snapshot_id INTEGER,
  prediction_mode TEXT NOT NULL DEFAULT 'PRODUCTION'
    CHECK (prediction_mode IN ('PRODUCTION', 'SHADOW', 'BACKTEST')),
  prediction_status TEXT NOT NULL DEFAULT 'COMPLETE'
    CHECK (prediction_status IN ('PENDING', 'COMPLETE', 'FAILED', 'WITHHELD')),
  predicted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  information_cutoff_at TEXT NOT NULL,
  prop_line REAL NOT NULL,
  projected_strikeouts REAL,
  raw_more_probability REAL CHECK (raw_more_probability IS NULL OR (raw_more_probability >= 0 AND raw_more_probability <= 1)),
  raw_less_probability REAL CHECK (raw_less_probability IS NULL OR (raw_less_probability >= 0 AND raw_less_probability <= 1)),
  calibrated_more_probability REAL CHECK (calibrated_more_probability IS NULL OR (calibrated_more_probability >= 0 AND calibrated_more_probability <= 1)),
  calibrated_less_probability REAL CHECK (calibrated_less_probability IS NULL OR (calibrated_less_probability >= 0 AND calibrated_less_probability <= 1)),
  preferred_side TEXT CHECK (preferred_side IS NULL OR preferred_side IN ('MORE', 'LESS', 'NONE')),
  model_edge REAL,
  decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  data_quality_status TEXT,
  source_fingerprint TEXT,
  input_hash TEXT,
  output_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_model_predictions_prop_time
  ON model_predictions(prop_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_predictions_version_time
  ON model_predictions(model_version_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_predictions_mode_status
  ON model_predictions(prediction_mode, prediction_status, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_predictions_feature_snapshot
  ON model_predictions(feature_snapshot_id);

-- Exact model inputs attached to a prediction. Values are append-only with the prediction ledger.
CREATE TABLE IF NOT EXISTS model_feature_values (
  model_feature_value_id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_prediction_id INTEGER NOT NULL,
  feature_name TEXT NOT NULL,
  feature_group TEXT,
  value_type TEXT NOT NULL
    CHECK (value_type IN ('REAL', 'INTEGER', 'TEXT', 'BOOLEAN', 'JSON', 'NULL')),
  value_real REAL,
  value_integer INTEGER,
  value_text TEXT,
  value_json TEXT,
  source_name TEXT,
  source_record_key TEXT,
  source_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id) ON DELETE CASCADE,
  UNIQUE (model_prediction_id, feature_name)
);

CREATE INDEX IF NOT EXISTS idx_model_feature_values_prediction
  ON model_feature_values(model_prediction_id);
CREATE INDEX IF NOT EXISTS idx_model_feature_values_name_real
  ON model_feature_values(feature_name, value_real);
CREATE INDEX IF NOT EXISTS idx_model_feature_values_group
  ON model_feature_values(feature_group, feature_name);

-- General-purpose ingestion/synchronization run ledger. Existing automation_runs remains intact.
CREATE TABLE IF NOT EXISTS sync_runs (
  sync_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  sync_mode TEXT NOT NULL DEFAULT 'INCREMENTAL'
    CHECK (sync_mode IN ('FULL', 'INCREMENTAL', 'BACKFILL', 'RETRY', 'MANUAL')),
  trigger_source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (trigger_source IN ('CRON', 'ADMIN', 'DEPLOY', 'API', 'MANUAL')),
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  source_cursor_start TEXT,
  source_cursor_end TEXT,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_unchanged INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  freshness_cutoff_at TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source_dataset_time
  ON sync_runs(source_name, dataset_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status_time
  ON sync_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_errors (
  sync_error_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id INTEGER NOT NULL,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT NOT NULL,
  source_record_key TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0,
  payload_excerpt TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_note TEXT,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_errors_run_time
  ON sync_errors(sync_run_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_errors_unresolved
  ON sync_errors(resolved_at, retryable, occurred_at DESC);

CREATE TABLE IF NOT EXISTS data_source_status (
  data_source_status_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('HEALTHY', 'DELAYED', 'INCOMPLETE', 'FAILED', 'NEVER_SYNCED', 'DISABLED', 'UNKNOWN')),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_complete_through_at TEXT,
  last_sync_run_id INTEGER,
  expected_refresh_minutes INTEGER,
  stale_after_minutes INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER,
  status_message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (last_sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (source_name, dataset_name)
);

CREATE INDEX IF NOT EXISTS idx_data_source_status_health
  ON data_source_status(status, last_success_at);

-- Build audit marker.
INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'SCHEMA_MIGRATION',
  'BUILD',
  '{"release":"3.0","build":"1.1","name":"Schema and Model Versioning","migration":"0016_model_versioning_foundation.sql"}'
);
