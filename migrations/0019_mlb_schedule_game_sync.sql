PRAGMA foreign_keys = ON;

ALTER TABLE games ADD COLUMN official_date TEXT;
ALTER TABLE games ADD COLUMN status_abstract TEXT;
ALTER TABLE games ADD COLUMN status_detailed TEXT;
ALTER TABLE games ADD COLUMN status_code TEXT;
ALTER TABLE games ADD COLUMN venue_name TEXT;
ALTER TABLE games ADD COLUMN day_night TEXT;
ALTER TABLE games ADD COLUMN doubleheader TEXT;
ALTER TABLE games ADD COLUMN game_number INTEGER;
ALTER TABLE games ADD COLUMN away_score INTEGER;
ALTER TABLE games ADD COLUMN home_score INTEGER;
ALTER TABLE games ADD COLUMN away_probable_pitcher_mlb_id INTEGER;
ALTER TABLE games ADD COLUMN away_probable_pitcher_name TEXT;
ALTER TABLE games ADD COLUMN away_probable_pitcher_hand TEXT;
ALTER TABLE games ADD COLUMN home_probable_pitcher_mlb_id INTEGER;
ALTER TABLE games ADD COLUMN home_probable_pitcher_name TEXT;
ALTER TABLE games ADD COLUMN home_probable_pitcher_hand TEXT;
ALTER TABLE games ADD COLUMN source_name TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE games ADD COLUMN first_seen_at TEXT;
ALTER TABLE games ADD COLUMN last_synced_at TEXT;
ALTER TABLE games ADD COLUMN source_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_games_official_date ON games(official_date, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(game_status, official_date);
CREATE INDEX IF NOT EXISTS idx_games_probable_pitchers ON games(away_probable_pitcher_mlb_id, home_probable_pitcher_mlb_id);

CREATE TABLE IF NOT EXISTS raw_mlb_schedule_snapshots (
  schedule_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_mlb_schedule_game_time
  ON raw_mlb_schedule_snapshots(mlb_game_pk, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_mlb_schedule_date
  ON raw_mlb_schedule_snapshots(official_date, captured_at DESC);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'MLB_STATS_API', 'MLB_SCHEDULE_GAMES', 'NEVER_SYNCED', 30,
  90, 'Build 2.1 schedule sync has not run yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_2_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.1","build":"2.1","feature":"MLB schedule and game sync"}'
);
