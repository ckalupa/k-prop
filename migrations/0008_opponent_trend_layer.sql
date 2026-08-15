-- Opponent trend layer MVP
-- Adds recent 14-day and 30-day team strikeout-rate history and stores
-- the blended opponent inputs used for each feature snapshot.

CREATE TABLE IF NOT EXISTS team_opponent_trends (
  trend_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days IN (14, 30)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  plate_appearances INTEGER NOT NULL,
  strikeouts INTEGER NOT NULL,
  strikeout_rate REAL NOT NULL,
  source TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, as_of_date, window_days),
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_team_opponent_trends_lookup
  ON team_opponent_trends(team_id, as_of_date, window_days);

ALTER TABLE feature_snapshots ADD COLUMN season_opponent_k_rate REAL;
ALTER TABLE feature_snapshots ADD COLUMN recent_30_k_rate REAL;
ALTER TABLE feature_snapshots ADD COLUMN recent_14_k_rate REAL;
ALTER TABLE feature_snapshots ADD COLUMN opponent_trend_delta REAL;
ALTER TABLE feature_snapshots ADD COLUMN opponent_sample_confidence TEXT;
