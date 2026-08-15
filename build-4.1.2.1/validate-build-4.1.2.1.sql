SELECT 'migration_0032_present' AS check_name, COUNT(*) AS value
FROM d1_migrations WHERE name='0032_historical_cutoff_certification_fix.sql';

SELECT 'certification_columns' AS check_name, COUNT(*) AS value
FROM pragma_table_info('historical_feature_certifications')
WHERE name IN ('information_cutoff_at','cutoff_source','certified_feature_snapshot_id','certified_recommendation_id','certified_model_version_id','certified_opponent_features_json','certified_model_output_json','source_timing_status');

SELECT 'native_snapshots_untouched' AS check_name, COUNT(*) AS value FROM prop_feature_snapshots;
SELECT 'reconstruction_rows_preserved' AS check_name, COUNT(*) AS value FROM historical_feature_reconstructions;
SELECT 'foreign_key_violations' AS check_name, COUNT(*) AS value FROM pragma_foreign_key_check;
