PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lineup_challenger_replay_runs (
  lineup_replay_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  replay_version TEXT NOT NULL DEFAULT 'lineup-challenger-replay-v1',
  status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dates_seen INTEGER NOT NULL DEFAULT 0,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_reconstructed INTEGER NOT NULL DEFAULT 0,
  rows_incomplete INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);

CREATE TABLE IF NOT EXISTS lineup_challenger_replay_rows (
  lineup_replay_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineup_replay_run_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  mlb_game_pk INTEGER,
  pitcher_id INTEGER NOT NULL,
  pitcher_mlb_id INTEGER,
  pitcher_hand TEXT CHECK(pitcher_hand IN ('L','R') OR pitcher_hand IS NULL),
  opponent_team_id INTEGER,
  opponent_mlb_team_id INTEGER,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('NATIVE_PREGAME','RECONSTRUCTED_ACTUAL','INCOMPLETE')),
  source_note TEXT,
  lineup_size INTEGER NOT NULL DEFAULT 0,
  hand_profiled_batters INTEGER NOT NULL DEFAULT 0,
  hand_profile_coverage REAL NOT NULL DEFAULT 0,
  total_hand_pa INTEGER NOT NULL DEFAULT 0,
  lineup_k_rate REAL,
  team_k_rate_reference REAL,
  lineup_vs_team_delta REAL,
  baseline_projection REAL,
  lineup_projection REAL,
  prop_line REAL NOT NULL,
  baseline_side TEXT,
  lineup_side TEXT,
  baseline_outcome TEXT,
  lineup_outcome TEXT,
  disagreement INTEGER NOT NULL DEFAULT 0 CHECK(disagreement IN (0,1)),
  lineup_hit INTEGER CHECK(lineup_hit IN (0,1) OR lineup_hit IS NULL),
  baseline_hit INTEGER CHECK(baseline_hit IN (0,1) OR baseline_hit IS NULL),
  quality_score INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(lineup_replay_run_id) REFERENCES lineup_challenger_replay_runs(lineup_replay_run_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  UNIQUE(lineup_replay_run_id, backtest_dataset_row_id)
);

CREATE INDEX IF NOT EXISTS idx_lineup_replay_rows_date ON lineup_challenger_replay_rows(lineup_replay_run_id,board_date);
CREATE INDEX IF NOT EXISTS idx_lineup_replay_rows_source ON lineup_challenger_replay_rows(lineup_replay_run_id,source_mode,quality_score);

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES ('BUILD_6_3_INSTALLED','SYSTEM','{"release":"3.5","build":"6.3","feature":"chronological lineup challenger replay with reconstructed-actual provenance kept research-only"}');
