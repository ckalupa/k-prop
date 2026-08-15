SELECT 'data_source_status_rows' AS check_name, COUNT(*) AS value
FROM data_source_status
WHERE source_name='MLB_STATS_API'
  AND dataset_name IN ('MLB_SCHEDULE_GAMES','PITCHER_GAME_LOGS','TEAM_STRIKEOUT_SPLITS');

SELECT 'schedule_games' AS check_name, COUNT(*) AS value FROM games WHERE source_name='MLB_STATS_API';
SELECT 'pitcher_logs' AS check_name, COUNT(*) AS value FROM raw_pitcher_game_logs;
SELECT 'team_split_rows' AS check_name, COUNT(*) AS value FROM team_strikeout_splits_daily;

SELECT dataset_name,status,last_success_at,last_complete_through_at,record_count,consecutive_failures
FROM data_source_status
WHERE source_name='MLB_STATS_API'
  AND dataset_name IN ('MLB_SCHEDULE_GAMES','PITCHER_GAME_LOGS','TEAM_STRIKEOUT_SPLITS')
ORDER BY dataset_name;
