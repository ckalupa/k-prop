-- Build 1.1 validation. Each section should return the expected result.

-- 1) Exactly one production model.
SELECT 'production_model_count' AS check_name, COUNT(*) AS actual, 1 AS expected
FROM model_versions
WHERE model_role = 'PRODUCTION';

-- 2) Active production model identity.
SELECT model_version_id, version_name, is_active, model_role, lifecycle_status,
       code_identifier, feature_schema_version, activated_at
FROM model_versions
WHERE model_role = 'PRODUCTION';

-- 3) New tables exist (expected count: 5).
SELECT 'new_table_count' AS check_name, COUNT(*) AS actual, 5 AS expected
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('model_predictions', 'model_feature_values', 'sync_runs', 'sync_errors', 'data_source_status');

-- 4) Required indexes exist.
SELECT name, tbl_name
FROM sqlite_master
WHERE type = 'index'
  AND name IN (
    'idx_model_versions_single_production',
    'idx_model_predictions_prop_time',
    'idx_model_predictions_version_time',
    'idx_model_feature_values_prediction',
    'idx_sync_runs_source_dataset_time',
    'idx_sync_errors_run_time',
    'idx_data_source_status_health'
  )
ORDER BY name;

-- 5) No production-facing records were modified by this build.
SELECT
  (SELECT COUNT(*) FROM props) AS props,
  (SELECT COUNT(*) FROM recommendations) AS recommendations,
  (SELECT COUNT(*) FROM feature_snapshots) AS feature_snapshots;

-- 6) Migration audit marker exists.
SELECT audit_event_id, event_type, entity_type, event_details, created_at
FROM audit_events
WHERE event_type = 'SCHEMA_MIGRATION'
  AND event_details LIKE '%"build":"1.1"%'
ORDER BY audit_event_id DESC
LIMIT 1;
