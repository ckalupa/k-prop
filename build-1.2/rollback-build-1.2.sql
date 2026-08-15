-- Logical emergency rollback for Build 1.2.
-- Prefer restoring the automatic pre-build D1 export for a complete rollback.
UPDATE model_versions
SET execution_enabled = CASE WHEN model_role = 'PRODUCTION' THEN 1 ELSE 0 END,
    last_execution_status = CASE WHEN model_role = 'CHALLENGER' THEN 'DISABLED' ELSE last_execution_status END,
    updated_at = CURRENT_TIMESTAMP;

DELETE FROM model_predictions
WHERE model_version_id IN (
  SELECT model_version_id FROM model_versions WHERE version_name = 'v13-shadow-plumbing'
);

DELETE FROM model_versions WHERE version_name = 'v13-shadow-plumbing';
