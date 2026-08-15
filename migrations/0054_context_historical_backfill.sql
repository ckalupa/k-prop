PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_context_backfill_dates (
  calendar_date TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_games INTEGER NOT NULL DEFAULT 0,
  games_processed INTEGER NOT NULL DEFAULT 0,
  snapshots_stored INTEGER NOT NULL DEFAULT 0,
  weather_rows INTEGER NOT NULL DEFAULT 0,
  umpire_rows INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  attempted_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_context_backfill_certifications (
  context_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  prop_id INTEGER,
  mlb_game_pk INTEGER,
  game_context_snapshot_id INTEGER,
  certification_status TEXT NOT NULL,
  quality_score INTEGER NOT NULL DEFAULT 0,
  weather_available INTEGER NOT NULL DEFAULT 0,
  umpire_available INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL DEFAULT 'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(game_context_snapshot_id) REFERENCES game_context_snapshots(game_context_snapshot_id) ON DELETE SET NULL,
  UNIQUE(backtest_run_id,backtest_dataset_row_id)
);

CREATE INDEX IF NOT EXISTS idx_context_cert_date ON game_context_backfill_certifications(backtest_run_id,board_date,certification_status);
CREATE INDEX IF NOT EXISTS idx_context_cert_game ON game_context_backfill_certifications(mlb_game_pk,board_date);

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_8_2_INSTALLED','SYSTEM','{"release":"3.7","build":"8.2","feature":"Historical game-context backfill and certification"}');
