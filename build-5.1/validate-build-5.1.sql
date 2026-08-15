SELECT model_version_id,version_name,model_role,lifecycle_status,code_identifier,execution_enabled,execution_priority,shadow_source_model_version_id
FROM model_versions
WHERE version_name IN ('v13-directional-calibration','v13-shadow-plumbing','v14-baseline-challenger')
ORDER BY model_version_id;
SELECT COUNT(*) AS foreign_key_violations FROM pragma_foreign_key_check;
