SELECT name FROM sqlite_master WHERE type='table' AND name='prop_feature_snapshots';
SELECT name FROM pragma_table_info('model_predictions') WHERE name='prop_feature_snapshot_id';
SELECT COUNT(*) AS snapshot_rows FROM prop_feature_snapshots;
SELECT COUNT(*) AS production_models FROM model_versions WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE';
