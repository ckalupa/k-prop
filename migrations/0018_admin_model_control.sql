-- Release 3.0 / Build 1.3: Admin Model Control
-- Adds indexes used by the model-control dashboard. No production model is
-- promoted, disabled, or otherwise changed by this migration.

CREATE INDEX IF NOT EXISTS idx_model_predictions_version_mode_time
  ON model_predictions(model_version_id, prediction_mode, predicted_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_predictions_version_status
  ON model_predictions(model_version_id, prediction_status, predicted_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'SCHEMA_MIGRATION',
  'BUILD',
  '{"release":"3.0","build":"1.3","name":"Admin Model Control","migration":"0018_admin_model_control.sql"}'
);
