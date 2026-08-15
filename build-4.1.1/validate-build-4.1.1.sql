SELECT 'historical_feature_reconstruction_runs' AS object_name,
       CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_feature_reconstruction_runs') THEN 'OK' ELSE 'MISSING' END AS status;
SELECT 'historical_feature_reconstructions' AS object_name,
       CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_feature_reconstructions') THEN 'OK' ELSE 'MISSING' END AS status;
SELECT 'native_snapshots_unchanged' AS check_name, COUNT(*) AS native_snapshot_rows FROM prop_feature_snapshots;
SELECT 'historical_reconstruction_rows' AS check_name, COUNT(*) AS reconstruction_rows FROM historical_feature_reconstructions;
SELECT event_type,created_at FROM audit_events WHERE event_type='BUILD_4_1_1_INSTALLED' ORDER BY audit_event_id DESC LIMIT 1;
