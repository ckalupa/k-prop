PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_feature_certification_runs (
  certification_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  certification_version TEXT NOT NULL DEFAULT 'backfill-certification-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  reconstructed_a_count INTEGER NOT NULL DEFAULT 0,
  reconstructed_b_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS historical_feature_certifications (
  historical_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  certification_run_id INTEGER NOT NULL,
  certification_version TEXT NOT NULL DEFAULT 'backfill-certification-v1',
  historical_reconstruction_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  certification_class TEXT NOT NULL CHECK (certification_class IN ('RECONSTRUCTED_A','RECONSTRUCTED_B','INCOMPLETE')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('CERTIFIED','EXCLUDED')),
  strict_eligible INTEGER NOT NULL DEFAULT 0 CHECK (strict_eligible IN (0,1)),
  certified_eligible INTEGER NOT NULL DEFAULT 0 CHECK (certified_eligible IN (0,1)),
  expanded_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_eligible IN (0,1)),
  certification_score INTEGER NOT NULL DEFAULT 0 CHECK (certification_score BETWEEN 0 AND 100),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (certification_run_id) REFERENCES historical_feature_certification_runs(certification_run_id) ON DELETE CASCADE,
  FOREIGN KEY (historical_reconstruction_id) REFERENCES historical_feature_reconstructions(historical_reconstruction_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  UNIQUE (certification_run_id, historical_reconstruction_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_certification_prop
  ON historical_feature_certifications(prop_id, historical_certification_id DESC);
CREATE INDEX IF NOT EXISTS idx_historical_certification_class_date
  ON historical_feature_certifications(certification_class, board_date, prop_id);

ALTER TABLE backtest_dataset_builds ADD COLUMN dataset_mode TEXT NOT NULL DEFAULT 'STRICT'
  CHECK (dataset_mode IN ('STRICT','CERTIFIED','EXPANDED'));

CREATE TABLE IF NOT EXISTS backtest_dataset_rows_v2 (
  backtest_dataset_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_dataset_build_id INTEGER NOT NULL,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v2',
  source_provenance TEXT NOT NULL DEFAULT 'NATIVE' CHECK (source_provenance IN ('NATIVE','RECONSTRUCTED_A','RECONSTRUCTED_B')),
  prop_feature_snapshot_id INTEGER,
  historical_reconstruction_id INTEGER,
  historical_certification_id INTEGER,
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
  FOREIGN KEY (historical_reconstruction_id) REFERENCES historical_feature_reconstructions(historical_reconstruction_id),
  FOREIGN KEY (historical_certification_id) REFERENCES historical_feature_certifications(historical_certification_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  CHECK ((source_provenance='NATIVE' AND prop_feature_snapshot_id IS NOT NULL AND historical_reconstruction_id IS NULL)
      OR (source_provenance<>'NATIVE' AND prop_feature_snapshot_id IS NULL AND historical_reconstruction_id IS NOT NULL)),
  UNIQUE (backtest_dataset_build_id, prop_id, model_version_id)
);

CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_v2_build_eligible
  ON backtest_dataset_rows_v2(backtest_dataset_build_id, backtest_eligible, board_date);
CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_v2_prop
  ON backtest_dataset_rows_v2(prop_id, backtest_dataset_build_id DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_dataset_rows_v2_provenance
  ON backtest_dataset_rows_v2(source_provenance, board_date, backtest_eligible);

CREATE TABLE IF NOT EXISTS backtest_fold_rows_v2 (
  backtest_fold_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_fold_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN','TEST')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_fold_id) REFERENCES backtest_folds(backtest_fold_id) ON DELETE CASCADE,
  FOREIGN KEY (backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v2(backtest_dataset_row_id),
  UNIQUE (backtest_fold_id, backtest_dataset_row_id, partition)
);
CREATE INDEX IF NOT EXISTS idx_backtest_fold_rows_v2_fold_partition ON backtest_fold_rows_v2(backtest_fold_id, partition);
CREATE INDEX IF NOT EXISTS idx_backtest_fold_rows_v2_dataset_row ON backtest_fold_rows_v2(backtest_dataset_row_id);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_1_2_INSTALLED','SYSTEM','{"release":"3.3","build":"4.1.2","feature":"Backfill certification with STRICT/CERTIFIED/EXPANDED dataset modes and isolated v2 backtest storage"}');
