ALTER TABLE recommendations ADD COLUMN game_pk INTEGER;
ALTER TABLE recommendations ADD COLUMN scheduled_first_pitch TEXT;
ALTER TABLE recommendations ADD COLUMN last_pregame_checked_at TEXT;
ALTER TABLE recommendations ADD COLUMN last_successful_refresh_at TEXT;
ALTER TABLE recommendations ADD COLUMN pregame_check_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE recommendations ADD COLUMN pregame_check_message TEXT;

CREATE TABLE IF NOT EXISTS automation_runs (
  automation_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER,
  run_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  games_checked INTEGER NOT NULL DEFAULT 0,
  props_matched INTEGER NOT NULL DEFAULT 0,
  starter_confirmed INTEGER NOT NULL DEFAULT 0,
  lineup_confirmed INTEGER NOT NULL DEFAULT 0,
  weather_checked INTEGER NOT NULL DEFAULT 0,
  umpire_checked INTEGER NOT NULL DEFAULT 0,
  stale_props INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  FOREIGN KEY (board_id) REFERENCES boards(board_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_board_started
  ON automation_runs(board_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_recommendations_pregame_status
  ON recommendations(pregame_check_status, scheduled_first_pitch);
