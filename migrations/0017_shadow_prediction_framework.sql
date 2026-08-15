-- Release 3.0 / Build 1.2: Shadow Prediction Framework
-- Adds runtime controls and a safe shadow-plumbing challenger. Shadow output is
-- written only to model_predictions/model_feature_values and never to the
-- production-facing recommendations table.

ALTER TABLE model_versions ADD COLUMN execution_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (execution_enabled IN (0, 1));
ALTER TABLE model_versions ADD COLUMN execution_priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE model_versions ADD COLUMN shadow_source_model_version_id INTEGER;
ALTER TABLE model_versions ADD COLUMN last_execution_at TEXT;
ALTER TABLE model_versions ADD COLUMN last_execution_status TEXT
  CHECK (last_execution_status IS NULL OR last_execution_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'DISABLED'));
ALTER TABLE model_versions ADD COLUMN last_execution_error TEXT;

UPDATE model_versions
SET execution_enabled = CASE WHEN model_role = 'PRODUCTION' THEN 1 ELSE 0 END,
    execution_priority = CASE WHEN model_role = 'PRODUCTION' THEN 0 ELSE 100 END,
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO model_versions (
  version_name,
  description,
  is_active,
  created_at,
  model_role,
  lifecycle_status,
  code_identifier,
  feature_schema_version,
  config_json,
  release_notes,
  activated_at,
  updated_at,
  execution_enabled,
  execution_priority,
  shadow_source_model_version_id,
  last_execution_status
)
SELECT
  'v13-shadow-plumbing',
  'Build 1.2 shadow plumbing validation model. Mirrors the current production output into the immutable ledger; it is not v14.',
  0,
  CURRENT_TIMESTAMP,
  'CHALLENGER',
  'ACTIVE',
  'shadow-adapter:production-mirror-v1',
  COALESCE(feature_schema_version, 'legacy-feature-snapshot-v1'),
  '{"adapter":"production_mirror_v1","purpose":"shadow_framework_validation","not_a_new_model":true}',
  'Validates parallel execution, immutable prediction capture, independent failure logging, and runtime enable/disable controls.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  1,
  100,
  model_version_id,
  'SUCCEEDED'
FROM model_versions
WHERE model_role = 'PRODUCTION'
  AND NOT EXISTS (
    SELECT 1 FROM model_versions WHERE version_name = 'v13-shadow-plumbing'
  )
LIMIT 1;

CREATE INDEX IF NOT EXISTS idx_model_versions_execution
  ON model_versions(execution_enabled, model_role, execution_priority, model_version_id);

CREATE INDEX IF NOT EXISTS idx_model_predictions_prop_version_mode
  ON model_predictions(prop_id, model_version_id, prediction_mode, predicted_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'SCHEMA_MIGRATION',
  'BUILD',
  '{"release":"3.0","build":"1.2","name":"Shadow Prediction Framework","migration":"0017_shadow_prediction_framework.sql"}'
);
