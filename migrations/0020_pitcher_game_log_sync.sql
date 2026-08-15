PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS raw_pitcher_game_logs (
  pitcher_game_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  mlb_pitcher_id INTEGER NOT NULL,
  pitcher_name TEXT NOT NULL,
  pitcher_id INTEGER,
  game_id INTEGER,
  game_date TEXT NOT NULL,
  team_abbreviation TEXT NOT NULL,
  opponent_abbreviation TEXT NOT NULL,
  home_away TEXT NOT NULL CHECK (home_away IN ('HOME','AWAY')),
  starter INTEGER NOT NULL DEFAULT 0 CHECK (starter IN (0,1)),
  decision_code TEXT,
  innings_pitched_text TEXT,
  outs_recorded INTEGER,
  strikeouts INTEGER,
  batters_faced INTEGER,
  pitch_count INTEGER,
  walks INTEGER,
  hits_allowed INTEGER,
  runs_allowed INTEGER,
  earned_runs INTEGER,
  home_runs_allowed INTEGER,
  strikes INTEGER,
  balls INTEGER,
  days_rest INTEGER,
  game_status TEXT,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  source_updated_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_run_id INTEGER,
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id) ON DELETE SET NULL,
  FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE SET NULL,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, mlb_pitcher_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_pitcher_logs_pitcher_date
  ON raw_pitcher_game_logs(mlb_pitcher_id, game_date DESC);
CREATE INDEX IF NOT EXISTS idx_raw_pitcher_logs_local_pitcher_date
  ON raw_pitcher_game_logs(pitcher_id, game_date DESC);
CREATE INDEX IF NOT EXISTS idx_raw_pitcher_logs_game
  ON raw_pitcher_game_logs(mlb_game_pk, starter);
CREATE INDEX IF NOT EXISTS idx_raw_pitcher_logs_date
  ON raw_pitcher_game_logs(game_date DESC, starter);

CREATE TABLE IF NOT EXISTS raw_mlb_boxscore_snapshots (
  boxscore_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_boxscore_game_time
  ON raw_mlb_boxscore_snapshots(mlb_game_pk, captured_at DESC);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'MLB_STATS_API', 'PITCHER_GAME_LOGS', 'NEVER_SYNCED', 60,
  180, 'Build 2.2 pitcher game-log sync has not run yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_2_2_INSTALLED',
  'SYSTEM',
  '{"release":"3.1","build":"2.2","feature":"Pitcher game log sync"}'
);
