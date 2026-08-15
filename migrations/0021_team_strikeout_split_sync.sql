PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_strikeout_splits_daily (
  team_strikeout_split_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  mlb_team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  window_days INTEGER NOT NULL CHECK (window_days IN (0,7,14,30)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  plate_appearances INTEGER NOT NULL,
  strikeouts INTEGER NOT NULL,
  walks INTEGER,
  strikeout_rate REAL NOT NULL,
  walk_rate REAL,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_run_id INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (team_id, as_of_date, pitcher_hand, window_days)
);

CREATE INDEX IF NOT EXISTS idx_team_k_splits_lookup
  ON team_strikeout_splits_daily(team_id, as_of_date DESC, pitcher_hand, window_days);
CREATE INDEX IF NOT EXISTS idx_team_k_splits_freshness
  ON team_strikeout_splits_daily(as_of_date DESC, window_days, pitcher_hand);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'MLB_STATS_API', 'TEAM_STRIKEOUT_SPLITS', 'NEVER_SYNCED', 30,
  240, 'Build 2.3 team strikeout split sync has not run yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_2_3_INSTALLED',
  'SYSTEM',
  '{"release":"3.1","build":"2.3","feature":"Team strikeout splits by handedness"}'
);
