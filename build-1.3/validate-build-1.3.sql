SELECT version_name, model_role, lifecycle_status, execution_enabled, execution_priority
FROM model_versions
ORDER BY CASE model_role WHEN 'PRODUCTION' THEN 0 WHEN 'CHALLENGER' THEN 1 ELSE 2 END, execution_priority;

SELECT COUNT(*) AS production_models
FROM model_versions
WHERE model_role = 'PRODUCTION' AND lifecycle_status = 'ACTIVE';

SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'idx_model_predictions_version_mode_time',
  'idx_model_predictions_version_status'
)
ORDER BY name;
