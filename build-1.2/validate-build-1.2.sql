-- Build 1.2 validation: runtime controls and shadow plumbing.
SELECT
  SUM(CASE WHEN model_role = 'PRODUCTION' AND execution_enabled = 1 THEN 1 ELSE 0 END) AS enabled_production_models,
  SUM(CASE WHEN model_role = 'CHALLENGER' AND execution_enabled = 1 THEN 1 ELSE 0 END) AS enabled_challenger_models
FROM model_versions;

SELECT model_version_id, version_name, model_role, lifecycle_status,
       execution_enabled, execution_priority, code_identifier,
       shadow_source_model_version_id, last_execution_status
FROM model_versions
WHERE model_role IN ('PRODUCTION', 'CHALLENGER')
ORDER BY execution_priority, model_version_id;

SELECT COUNT(*) AS existing_props FROM props;
SELECT COUNT(*) AS existing_recommendations FROM recommendations;
SELECT COUNT(*) AS existing_feature_snapshots FROM feature_snapshots;
SELECT COUNT(*) AS prediction_ledger_rows FROM model_predictions;
SELECT COUNT(*) AS prediction_feature_rows FROM model_feature_values;
