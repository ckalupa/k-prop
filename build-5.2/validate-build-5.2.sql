SELECT version_name,model_role,lifecycle_status,execution_enabled,code_identifier
FROM model_versions
WHERE version_name IN ('v13-directional-calibration','v14-baseline-challenger')
ORDER BY model_version_id;
SELECT event_type,created_at FROM audit_events WHERE event_type='BUILD_5_2_INSTALLED' ORDER BY audit_event_id DESC LIMIT 1;
