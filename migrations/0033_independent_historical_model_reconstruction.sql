PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS independent_historical_reconstruction_runs (
  independent_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'independent-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cursor_start_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  research_ready_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS independent_historical_reconstructions (
  independent_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  independent_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'independent-reconstruction-v1',
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  game_id INTEGER,
  information_cutoff_at TEXT,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  available_side TEXT,
  prop_type TEXT,
  prior_start_count INTEGER NOT NULL DEFAULT 0,
  last_start_date TEXT,
  last3_k_avg REAL,
  last5_k_avg REAL,
  last10_k_avg REAL,
  last5_k_per_bf REAL,
  last5_avg_bf REAL,
  last5_avg_ip REAL,
  last5_avg_pitch_count REAL,
  form_delta_l3_l10 REAL,
  same_opponent_start_count INTEGER NOT NULL DEFAULT 0,
  same_opponent_k_avg REAL,
  same_opponent_adjustment REAL NOT NULL DEFAULT 0,
  baseline_projection REAL,
  reconstructed_projection REAL,
  reconstructed_edge REAL,
  reconstructed_over_probability REAL,
  reconstructed_preferred_side TEXT,
  reconstruction_status TEXT NOT NULL CHECK (reconstruction_status IN ('RESEARCH_READY','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  expanded_research_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_research_eligible IN (0,1)),
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  feature_json TEXT NOT NULL DEFAULT '{}',
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (independent_run_id) REFERENCES independent_historical_reconstruction_runs(independent_run_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (game_id) REFERENCES games(game_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (independent_run_id, prop_id)
);

CREATE INDEX IF NOT EXISTS idx_independent_reconstruction_prop
  ON independent_historical_reconstructions(prop_id, independent_reconstruction_id DESC);
CREATE INDEX IF NOT EXISTS idx_independent_reconstruction_status_date
  ON independent_historical_reconstructions(reconstruction_status, board_date, prop_id);
CREATE INDEX IF NOT EXISTS idx_independent_reconstruction_runs_time
  ON independent_historical_reconstruction_runs(started_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_1_3_INSTALLED','SYSTEM','{"release":"3.3","build":"4.1.3","feature":"Independent historical model reconstruction from pregame-safe pitcher history; legacy postgame snapshots and recommendations excluded"}');
