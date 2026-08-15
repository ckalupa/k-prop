SELECT name FROM sqlite_master WHERE type='table' AND name='pitcher_daily_features';
SELECT source_name,dataset_name,status FROM data_source_status WHERE dataset_name='PITCHER_DAILY_FEATURES';
SELECT COUNT(*) AS pitcher_daily_feature_rows FROM pitcher_daily_features;
