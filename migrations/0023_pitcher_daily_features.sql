PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pitcher_daily_features (
  pitcher_daily_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id INTEGER,
  mlb_pitcher_id INTEGER NOT NULL,
  pitcher_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  source_cutoff_date TEXT,
  season_starts INTEGER NOT NULL DEFAULT 0,
  last3_starts INTEGER NOT NULL DEFAULT 0,
  last5_starts INTEGER NOT NULL DEFAULT 0,
  last10_starts INTEGER NOT NULL DEFAULT 0,
  season_strikeouts INTEGER NOT NULL DEFAULT 0,
  season_batters_faced INTEGER NOT NULL DEFAULT 0,
  season_outs_recorded INTEGER NOT NULL DEFAULT 0,
  season_pitch_count INTEGER NOT NULL DEFAULT 0,
  season_k_per_bf REAL,
  season_k_per_inning REAL,
  season_avg_strikeouts REAL,
  season_avg_batters_faced REAL,
  season_avg_innings REAL,
  season_avg_pitch_count REAL,
  last3_k_per_bf REAL,
  last3_avg_strikeouts REAL,
  last3_avg_batters_faced REAL,
  last3_avg_innings REAL,
  last3_avg_pitch_count REAL,
  last5_k_per_bf REAL,
  last5_avg_strikeouts REAL,
  last5_avg_batters_faced REAL,
  last5_avg_innings REAL,
  last5_avg_pitch_count REAL,
  last10_k_per_bf REAL,
  last10_avg_strikeouts REAL,
  last10_avg_batters_faced REAL,
  last10_avg_innings REAL,
  last10_avg_pitch_count REAL,
  home_k_per_bf REAL,
  away_k_per_bf REAL,
  days_since_last_start INTEGER,
  last_start_date TEXT,
  pitch_count_trend_3v3 REAL,
  innings_trend_3v3 REAL,
  strikeout_trend_3v3 REAL,
  recent5_vs_season_k_per_bf REAL,
  data_quality_score INTEGER NOT NULL DEFAULT 0 CHECK (data_quality_score BETWEEN 0 AND 100),
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'pitcher-daily-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id) ON DELETE SET NULL,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_pitcher_id, as_of_date, feature_version)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_daily_features_date
  ON pitcher_daily_features(as_of_date DESC, mlb_pitcher_id);
CREATE INDEX IF NOT EXISTS idx_pitcher_daily_features_pitcher_date
  ON pitcher_daily_features(mlb_pitcher_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_pitcher_daily_features_local_pitcher_date
  ON pitcher_daily_features(pitcher_id, as_of_date DESC);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'FEATURE_STORE', 'PITCHER_DAILY_FEATURES', 'NEVER_SYNCED', 60,
  180, 'Build 3.1 pitcher daily features have not been generated yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_3_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.2","build":"3.1","feature":"Pitcher daily feature store"}'
);
