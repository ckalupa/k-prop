SELECT 'migration' AS check_name, COUNT(*) AS value
FROM d1_migrations WHERE name = '0019_mlb_schedule_game_sync.sql';
SELECT 'games_table' AS check_name, COUNT(*) AS value
FROM pragma_table_info('games') WHERE name IN ('official_date','status_detailed','away_probable_pitcher_mlb_id','last_synced_at');
SELECT 'raw_snapshots_table' AS check_name, COUNT(*) AS value
FROM sqlite_master WHERE type='table' AND name='raw_mlb_schedule_snapshots';
SELECT 'source_status' AS check_name, COUNT(*) AS value
FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='MLB_SCHEDULE_GAMES';
SELECT 'production_models' AS check_name, COUNT(*) AS value
FROM model_versions WHERE model_role='PRODUCTION' AND is_active=1;
SELECT 'props_preserved' AS check_name, COUNT(*) AS value FROM props;
SELECT 'recommendations_preserved' AS check_name, COUNT(*) AS value FROM recommendations;
