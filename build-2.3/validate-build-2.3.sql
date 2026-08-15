SELECT name FROM sqlite_master WHERE type='table' AND name='team_strikeout_splits_daily';
SELECT source_name,dataset_name,status FROM data_source_status WHERE dataset_name='TEAM_STRIKEOUT_SPLITS';
SELECT COUNT(*) AS production_models FROM model_versions WHERE model_role='PRODUCTION' AND execution_enabled=1;
SELECT COUNT(*) AS props_preserved FROM props;
SELECT COUNT(*) AS recommendations_preserved FROM recommendations;
