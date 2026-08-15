PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_opponent_reconstruction_runs (
  opponent_reconstruction_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-opponent-reconstruction-v1',
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
  games_checked INTEGER NOT NULL DEFAULT 0,
  games_fetched INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS historical_opponent_reconstructions (
  historical_opponent_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  opponent_reconstruction_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-opponent-reconstruction-v1',
  independent_reconstruction_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  information_cutoff_at TEXT,
  opponent_team_id INTEGER NOT NULL,
  opponent_mlb_team_id INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL,
  window_7_pa INTEGER NOT NULL DEFAULT 0,
  window_7_k INTEGER NOT NULL DEFAULT 0,
  window_7_k_rate REAL,
  window_14_pa INTEGER NOT NULL DEFAULT 0,
  window_14_k INTEGER NOT NULL DEFAULT 0,
  window_14_k_rate REAL,
  window_30_pa INTEGER NOT NULL DEFAULT 0,
  window_30_k INTEGER NOT NULL DEFAULT 0,
  window_30_k_rate REAL,
  weighted_recent_k_rate REAL,
  recent_trend_delta REAL,
  league_baseline_k_rate REAL NOT NULL DEFAULT 0.225,
  handedness_edge REAL,
  sample_confidence TEXT,
  matchup_multiplier REAL,
  pitcher_only_projection REAL,
  opponent_adjusted_projection REAL,
  opponent_adjusted_edge REAL,
  opponent_adjusted_over_probability REAL,
  opponent_adjusted_preferred_side TEXT,
  reconstruction_status TEXT NOT NULL CHECK (reconstruction_status IN ('RESEARCH_READY','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  expanded_research_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_research_eligible IN (0,1)),
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  feature_json TEXT NOT NULL DEFAULT '{}',
  actual_strikeouts INTEGER,
  market_result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (opponent_reconstruction_run_id) REFERENCES historical_opponent_reconstruction_runs(opponent_reconstruction_run_id) ON DELETE CASCADE,
  FOREIGN KEY (independent_reconstruction_id) REFERENCES independent_historical_reconstructions(independent_reconstruction_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (opponent_reconstruction_run_id, prop_id)
);

CREATE INDEX IF NOT EXISTS idx_hist_opp_recon_prop
  ON historical_opponent_reconstructions(prop_id, historical_opponent_reconstruction_id DESC);
CREATE INDEX IF NOT EXISTS idx_hist_opp_recon_status_date
  ON historical_opponent_reconstructions(reconstruction_status, board_date, prop_id);
CREATE INDEX IF NOT EXISTS idx_hist_opp_recon_runs_time
  ON historical_opponent_reconstruction_runs(started_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_1_4_INSTALLED','SYSTEM','{"release":"3.3","build":"4.1.4","feature":"Pregame-safe historical opponent handedness reconstruction from cached/MLB play-by-play; native snapshots untouched"}');
