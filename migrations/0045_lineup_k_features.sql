PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batter_k_profiles_daily (
  batter_k_profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  source_cutoff_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  raw_k_rate REAL,
  shrunk_k_rate REAL,
  league_k_rate REAL,
  sample_weight REAL NOT NULL DEFAULT 0,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  profile_version TEXT NOT NULL DEFAULT 'batter-k-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, profile_version)
);
CREATE INDEX IF NOT EXISTS idx_batter_k_profile_date ON batter_k_profiles_daily(as_of_date DESC, mlb_batter_id);
CREATE INDEX IF NOT EXISTS idx_batter_k_profile_player ON batter_k_profiles_daily(mlb_batter_id, as_of_date DESC);

CREATE TABLE IF NOT EXISTS lineup_k_features_daily (
  lineup_k_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineup_snapshot_id INTEGER NOT NULL,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  batting_team_mlb_id INTEGER NOT NULL,
  opponent_team_mlb_id INTEGER NOT NULL,
  opposing_probable_pitcher_mlb_id INTEGER,
  opposing_probable_pitcher_hand TEXT,
  lineup_size INTEGER NOT NULL,
  profiled_batters INTEGER NOT NULL,
  profile_coverage REAL NOT NULL,
  total_profile_pa INTEGER NOT NULL DEFAULT 0,
  unweighted_lineup_k_rate REAL,
  slot_weighted_lineup_k_rate REAL,
  team_k_rate_reference REAL,
  lineup_vs_team_delta REAL,
  league_k_rate REAL,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'lineup-k-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineup_snapshot_id) REFERENCES game_lineup_snapshots(lineup_snapshot_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (lineup_snapshot_id, feature_version)
);
CREATE INDEX IF NOT EXISTS idx_lineup_k_feature_date ON lineup_k_features_daily(official_date DESC, batting_team_mlb_id);
CREATE INDEX IF NOT EXISTS idx_lineup_k_feature_game ON lineup_k_features_daily(mlb_game_pk, batting_team_mlb_id);

INSERT INTO data_source_status (source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES ('FEATURE_STORE','BATTER_K_PROFILES','NEVER_SYNCED',60,180,'Build 6.2 batter K profiles have not run yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO data_source_status (source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES ('FEATURE_STORE','LINEUP_K_FEATURES','NEVER_SYNCED',15,60,'Build 6.2 lineup K features have not run yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_6_2_INSTALLED','SYSTEM','{"release":"3.5","build":"6.2","feature":"batter K profiles and lineup-weighted matchup features"}');
