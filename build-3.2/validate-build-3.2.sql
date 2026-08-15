SELECT name FROM sqlite_master WHERE type='table' AND name='team_daily_features';
SELECT COUNT(*) AS team_daily_feature_rows FROM team_daily_features;
SELECT source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes FROM data_source_status WHERE source_name='FEATURE_STORE' AND dataset_name='TEAM_DAILY_FEATURES';
SELECT COUNT(*) AS pitcher_daily_features_preserved FROM pitcher_daily_features;
SELECT COUNT(*) AS recommendations_preserved FROM recommendations;
