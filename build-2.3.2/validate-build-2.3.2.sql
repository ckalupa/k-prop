SELECT CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS team_split_table
FROM sqlite_master WHERE type='table' AND name='team_strikeout_splits_daily';
SELECT CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS handedness_cache_table
FROM sqlite_master WHERE type='table' AND name='team_game_handedness_batting';
SELECT CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS source_status_row
FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='TEAM_STRIKEOUT_SPLITS';
SELECT COUNT(*) AS current_split_rows FROM team_strikeout_splits_daily;
