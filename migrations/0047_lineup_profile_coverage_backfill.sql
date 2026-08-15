PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batter_k_profile_backfill_attempts (
  batter_k_profile_backfill_attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  status TEXT NOT NULL CHECK (status IN ('FILLED','NO_PRIOR_HAND_PA','RETRYABLE_ERROR','FAILED_PERMANENT')),
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  last_sync_run_id INTEGER,
  last_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (last_sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, pitcher_hand)
);
CREATE INDEX IF NOT EXISTS idx_batter_k_profile_backfill_date ON batter_k_profile_backfill_attempts(as_of_date DESC,pitcher_hand,status);

INSERT INTO data_source_status (source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES ('FEATURE_STORE','BATTER_K_PROFILE_BACKFILL','NEVER_SYNCED',60,180,'Build 6.2.3 targeted lineup profile coverage backfill has not run yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type,entity_type,event_details)
VALUES ('BUILD_6_2_3_INSTALLED','SYSTEM','{"release":"3.5","build":"6.2.3","feature":"targeted missing-lineup batter hand-profile backfill and coverage diagnostics"}');
