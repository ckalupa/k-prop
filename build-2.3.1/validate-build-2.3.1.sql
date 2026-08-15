SELECT 'team_game_handedness_batting' AS object_name, COUNT(*) AS object_exists
FROM sqlite_master WHERE type='table' AND name='team_game_handedness_batting';
SELECT 'team_game_handedness_games' AS object_name, COUNT(*) AS object_exists
FROM sqlite_master WHERE type='table' AND name='team_game_handedness_games';
SELECT status, record_count, metadata_json
FROM data_source_status
WHERE source_name='MLB_STATS_API' AND dataset_name='TEAM_STRIKEOUT_SPLITS';
SELECT COUNT(*) AS invalid_identical_hand_pairs
FROM team_handedness_stats l
JOIN team_handedness_stats r
  ON r.team_id=l.team_id AND r.season=l.season AND r.pitcher_hand='R'
WHERE l.pitcher_hand='L'
  AND l.source LIKE 'MLB Stats API%'
  AND r.source LIKE 'MLB Stats API%'
  AND l.plate_appearances=r.plate_appearances
  AND l.strikeouts=r.strikeouts;
