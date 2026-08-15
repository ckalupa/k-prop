SELECT
  (SELECT COUNT(*) FROM teams) AS teams,
  (SELECT COUNT(*) FROM pitchers) AS pitchers,
  (SELECT COUNT(*) FROM pitcher_aliases) AS aliases,
  (SELECT COUNT(*) FROM games) AS games,
  (SELECT COUNT(*) FROM boards) AS boards,
  (SELECT COUNT(*) FROM props) AS props,
  (SELECT COUNT(*) FROM prop_results) AS results,
  (SELECT COUNT(*) FROM pitcher_game_stats) AS game_stats,
  (SELECT COUNT(*) FROM feature_snapshots) AS feature_snapshots,
  (SELECT COUNT(*) FROM recommendations) AS recommendations;
