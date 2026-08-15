PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backtest_runs (
  backtest_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  engine_version TEXT NOT NULL DEFAULT 'walk-forward-v1',
  backtest_dataset_build_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  min_train_dates INTEGER NOT NULL DEFAULT 5,
  min_train_rows INTEGER NOT NULL DEFAULT 50,
  test_window_days INTEGER NOT NULL DEFAULT 1,
  eligible_row_count INTEGER NOT NULL DEFAULT 0,
  distinct_test_dates INTEGER NOT NULL DEFAULT 0,
  fold_count INTEGER NOT NULL DEFAULT 0,
  executed_fold_count INTEGER NOT NULL DEFAULT 0,
  skipped_fold_count INTEGER NOT NULL DEFAULT 0,
  train_date_min TEXT,
  train_date_max TEXT,
  test_date_min TEXT,
  test_date_max TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);

CREATE TABLE IF NOT EXISTS backtest_folds (
  backtest_fold_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL,
  fold_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('EXECUTED','SKIPPED')),
  skip_reason TEXT,
  train_date_min TEXT,
  train_date_max TEXT,
  test_date_min TEXT NOT NULL,
  test_date_max TEXT NOT NULL,
  train_distinct_dates INTEGER NOT NULL DEFAULT 0,
  train_row_count INTEGER NOT NULL DEFAULT 0,
  test_row_count INTEGER NOT NULL DEFAULT 0,
  no_future_overlap INTEGER NOT NULL DEFAULT 1 CHECK (no_future_overlap IN (0,1)),
  preferred_wins INTEGER NOT NULL DEFAULT 0,
  preferred_losses INTEGER NOT NULL DEFAULT 0,
  preferred_pushes INTEGER NOT NULL DEFAULT 0,
  preferred_hit_rate REAL,
  brier_score REAL,
  average_preferred_probability REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_run_id) REFERENCES backtest_runs(backtest_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_run_id, fold_index)
);

CREATE TABLE IF NOT EXISTS backtest_fold_rows (
  backtest_fold_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_fold_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN','TEST')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_fold_id) REFERENCES backtest_folds(backtest_fold_id) ON DELETE CASCADE,
  FOREIGN KEY (backtest_dataset_row_id) REFERENCES backtest_dataset_rows(backtest_dataset_row_id),
  UNIQUE (backtest_fold_id, backtest_dataset_row_id, partition)
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_dataset_time ON backtest_runs(backtest_dataset_build_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_folds_run_status ON backtest_folds(backtest_run_id, status, fold_index);
CREATE INDEX IF NOT EXISTS idx_backtest_fold_rows_fold_partition ON backtest_fold_rows(backtest_fold_id, partition);
CREATE INDEX IF NOT EXISTS idx_backtest_fold_rows_dataset_row ON backtest_fold_rows(backtest_dataset_row_id);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_2_INSTALLED','SYSTEM','{"release":"3.3","build":"4.2","feature":"Walk-forward backtesting engine with strict prior-date training folds"}');
