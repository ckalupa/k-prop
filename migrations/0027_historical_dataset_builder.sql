PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backtest_dataset_builds (
  backtest_dataset_build_id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_uuid TEXT NOT NULL UNIQUE,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  source_snapshot_count INTEGER NOT NULL DEFAULT 0,
  dataset_row_count INTEGER NOT NULL DEFAULT 0,
  eligible_row_count INTEGER NOT NULL DEFAULT 0,
  excluded_row_count INTEGER NOT NULL DEFAULT 0,
  push_count INTEGER NOT NULL DEFAULT 0,
  void_count INTEGER NOT NULL DEFAULT 0,
  board_date_min TEXT,
  board_date_max TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS backtest_dataset_rows (
  backtest_dataset_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_dataset_build_id INTEGER NOT NULL,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v1',
  prop_feature_snapshot_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  model_version_id INTEGER NOT NULL,
  model_prediction_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  captured_at TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  pitcher_source_cutoff_date TEXT,
  team_source_cutoff_date TEXT,
  snapshot_status TEXT NOT NULL,
  overall_data_quality_score INTEGER,
  data_quality_grade TEXT,
  quality_gate TEXT,
  challenger_eligible INTEGER NOT NULL DEFAULT 0,
  projected_strikeouts REAL,
  raw_more_probability REAL,
  raw_less_probability REAL,
  calibrated_more_probability REAL,
  calibrated_less_probability REAL,
  preferred_side TEXT,
  model_edge REAL,
  model_decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  innings_pitched REAL,
  pitch_count INTEGER,
  batters_faced INTEGER,
  starter INTEGER,
  more_outcome TEXT CHECK (more_outcome IS NULL OR more_outcome IN ('WIN','LOSS','PUSH','VOID')),
  less_outcome TEXT CHECK (less_outcome IS NULL OR less_outcome IN ('WIN','LOSS','PUSH','VOID')),
  preferred_outcome TEXT CHECK (preferred_outcome IS NULL OR preferred_outcome IN ('WIN','LOSS','PUSH','VOID','NONE')),
  feature_cutoff_status TEXT NOT NULL CHECK (feature_cutoff_status IN ('PASS','UNKNOWN','FAIL')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('CERTIFIED','EXCLUDED')),
  exclusion_reason TEXT,
  backtest_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backtest_eligible IN (0,1)),
  pitcher_features_json TEXT,
  team_features_json TEXT,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  critical_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_feature_snapshot_id) REFERENCES prop_feature_snapshots(prop_feature_snapshot_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (backtest_dataset_build_id, prop_id, model_version_id)
);

CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_build_eligible
  ON backtest_dataset_rows(backtest_dataset_build_id, backtest_eligible, board_date);
CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_prop
  ON backtest_dataset_rows(prop_id, backtest_dataset_build_id DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_model_date
  ON backtest_dataset_rows(model_version_id, board_date, certification_status);
CREATE INDEX IF NOT EXISTS idx_backtest_dataset_builds_time
  ON backtest_dataset_builds(started_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_4_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.3","build":"4.1","feature":"Leak-safe historical backtest dataset builder"}'
);
