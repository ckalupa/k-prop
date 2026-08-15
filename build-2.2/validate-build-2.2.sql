SELECT name FROM sqlite_master WHERE type='table' AND name IN ('raw_pitcher_game_logs','raw_mlb_boxscore_snapshots');
SELECT source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes FROM data_source_status WHERE dataset_name='PITCHER_GAME_LOGS';
SELECT COUNT(*) AS pitcher_log_count FROM raw_pitcher_game_logs;
SELECT COUNT(*) AS production_models FROM model_versions WHERE model_role='PRODUCTION' AND enabled=1;
SELECT COUNT(*) AS prop_count FROM props;
SELECT COUNT(*) AS recommendation_count FROM recommendations;
