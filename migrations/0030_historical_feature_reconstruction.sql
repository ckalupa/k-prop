PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_feature_reconstruction_runs (
  reconstruction_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cursor_start_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  candidate_a_count INTEGER NOT NULL DEFAULT 0,
  candidate_b_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS historical_feature_reconstructions (
  historical_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconstruction_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-reconstruction-v1',
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  model_version_id INTEGER,
  recommendation_id INTEGER,
  legacy_feature_snapshot_id INTEGER,
  prop_result_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  recommendation_generated_at TEXT,
  legacy_snapshot_time TEXT,
  latest_pitcher_game_date TEXT,
  pitcher_starts_before_board INTEGER NOT NULL DEFAULT 0,
  pitcher_last5_complete INTEGER NOT NULL DEFAULT 0 CHECK (pitcher_last5_complete IN (0,1)),
  opponent_context_available INTEGER NOT NULL DEFAULT 0 CHECK (opponent_context_available IN (0,1)),
  result_available INTEGER NOT NULL DEFAULT 0 CHECK (result_available IN (0,1)),
  model_output_available INTEGER NOT NULL DEFAULT 0 CHECK (model_output_available IN (0,1)),
  reconstruction_class TEXT NOT NULL CHECK (reconstruction_class IN ('RECONSTRUCTED_A_CANDIDATE','RECONSTRUCTED_B_CANDIDATE','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  blocking_reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  pitcher_features_json TEXT,
  opponent_features_json TEXT,
  model_output_json TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reconstruction_run_id) REFERENCES historical_feature_reconstruction_runs(reconstruction_run_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id),
  FOREIGN KEY (legacy_feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id),
  FOREIGN KEY (prop_result_id) REFERENCES prop_results(prop_result_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (reconstruction_run_id, prop_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_reconstruction_prop
  ON historical_feature_reconstructions(prop_id, historical_reconstruction_id DESC);
CREATE INDEX IF NOT EXISTS idx_historical_reconstruction_class_date
  ON historical_feature_reconstructions(reconstruction_class, board_date, prop_id);
CREATE INDEX IF NOT EXISTS idx_historical_reconstruction_runs_time
  ON historical_feature_reconstruction_runs(started_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_4_1_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.3","build":"4.1.1","feature":"Historical feature reconstruction provenance ledger"}'
);
