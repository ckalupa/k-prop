PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_daily_features (
  team_daily_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  mlb_team_id INTEGER NOT NULL,
  team_abbr TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  source_cutoff_date TEXT NOT NULL,
  season_plate_appearances INTEGER NOT NULL DEFAULT 0,
  season_strikeouts INTEGER NOT NULL DEFAULT 0,
  season_k_rate REAL,
  last30_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last30_strikeouts INTEGER NOT NULL DEFAULT 0,
  last30_k_rate REAL,
  last14_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last14_strikeouts INTEGER NOT NULL DEFAULT 0,
  last14_k_rate REAL,
  last7_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last7_strikeouts INTEGER NOT NULL DEFAULT 0,
  last7_k_rate REAL,
  weighted_recent_k_rate REAL,
  recent_vs_season_delta REAL,
  last7_vs_last30_delta REAL,
  trend_direction TEXT NOT NULL DEFAULT 'FLAT' CHECK (trend_direction IN ('UP','DOWN','FLAT')),
  stability_status TEXT NOT NULL DEFAULT 'LOW' CHECK (stability_status IN ('HIGH','MEDIUM','LOW')),
  sample_size_score INTEGER NOT NULL DEFAULT 0 CHECK (sample_size_score BETWEEN 0 AND 100),
  data_quality_score INTEGER NOT NULL DEFAULT 0 CHECK (data_quality_score BETWEEN 0 AND 100),
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_sync_run_ids_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'team-daily-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (team_id, as_of_date, pitcher_hand, feature_version)
);

CREATE INDEX IF NOT EXISTS idx_team_daily_features_date_hand
  ON team_daily_features(as_of_date DESC, pitcher_hand, team_id);
CREATE INDEX IF NOT EXISTS idx_team_daily_features_team_date
  ON team_daily_features(team_id, as_of_date DESC, pitcher_hand);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'FEATURE_STORE', 'TEAM_DAILY_FEATURES', 'NEVER_SYNCED', 60,
  180, 'Build 3.2 team daily features have not been generated yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_3_2_INSTALLED',
  'SYSTEM',
  '{"release":"3.2","build":"3.2","feature":"Team daily feature store"}'
);
