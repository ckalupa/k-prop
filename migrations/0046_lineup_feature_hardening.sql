PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batter_k_profiles_hand_daily (
  batter_k_hand_profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  source_cutoff_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  raw_k_rate REAL,
  shrunk_k_rate REAL,
  league_k_rate REAL,
  sample_weight REAL NOT NULL DEFAULT 0,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  profile_version TEXT NOT NULL DEFAULT 'batter-k-hand-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, pitcher_hand, profile_version)
);
CREATE INDEX IF NOT EXISTS idx_batter_k_hand_date ON batter_k_profiles_hand_daily(as_of_date DESC,pitcher_hand,mlb_batter_id);
CREATE INDEX IF NOT EXISTS idx_batter_k_hand_player ON batter_k_profiles_hand_daily(mlb_batter_id,as_of_date DESC,pitcher_hand);

ALTER TABLE lineup_k_features_daily ADD COLUMN handedness_profiled_batters INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN handedness_profile_coverage REAL NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN generic_fallback_batters INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN league_fallback_batters INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN handedness_total_pa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN generic_total_pa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lineup_k_features_daily ADD COLUMN profile_method_json TEXT NOT NULL DEFAULT '{}';

INSERT INTO data_source_status (source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES ('FEATURE_STORE','BATTER_K_HAND_PROFILES','NEVER_SYNCED',60,180,'Build 6.2.1 handedness batter profiles have not run yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO data_source_status (source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES ('FEATURE_STORE','LINEUP_K_FEATURES_V2','NEVER_SYNCED',15,60,'Build 6.2.1 hardened lineup K features have not run yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type,entity_type,event_details)
VALUES ('BUILD_6_2_1_INSTALLED','SYSTEM','{"release":"3.5","build":"6.2.1","feature":"pitcher-hand repair, batter K splits by pitcher hand, explicit lineup fallback coverage"}');
