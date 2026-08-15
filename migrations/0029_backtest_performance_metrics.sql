PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backtest_performance_runs (
  backtest_performance_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  metrics_version TEXT NOT NULL DEFAULT 'performance-metrics-v1',
  backtest_run_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  evaluated_row_count INTEGER NOT NULL DEFAULT 0,
  graded_row_count INTEGER NOT NULL DEFAULT 0,
  qualified_play_count INTEGER NOT NULL DEFAULT 0,
  distinct_test_dates INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  brier_score REAL,
  calibration_error REAL,
  more_hit_rate REAL,
  less_hit_rate REAL,
  average_predicted_probability REAL,
  picks_per_day REAL,
  qualified_plays_per_day REAL,
  max_drawdown_units REAL,
  longest_losing_streak INTEGER NOT NULL DEFAULT 0,
  power_roi REAL,
  flex_roi REAL,
  power_entries INTEGER NOT NULL DEFAULT 0,
  flex_entries INTEGER NOT NULL DEFAULT 0,
  simulation_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (backtest_run_id) REFERENCES backtest_runs(backtest_run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backtest_performance_windows (
  backtest_performance_window_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_performance_run_id INTEGER NOT NULL,
  window_name TEXT NOT NULL CHECK (window_name IN ('ALL','7D','14D','30D')),
  date_min TEXT,
  date_max TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  graded_count INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  brier_score REAL,
  calibration_error REAL,
  more_wins INTEGER NOT NULL DEFAULT 0,
  more_losses INTEGER NOT NULL DEFAULT 0,
  more_pushes INTEGER NOT NULL DEFAULT 0,
  more_hit_rate REAL,
  less_wins INTEGER NOT NULL DEFAULT 0,
  less_losses INTEGER NOT NULL DEFAULT 0,
  less_pushes INTEGER NOT NULL DEFAULT 0,
  less_hit_rate REAL,
  avg_predicted_probability REAL,
  qualified_play_count INTEGER NOT NULL DEFAULT 0,
  picks_per_day REAL,
  qualified_plays_per_day REAL,
  max_drawdown_units REAL,
  longest_losing_streak INTEGER NOT NULL DEFAULT 0,
  power_roi REAL,
  flex_roi REAL,
  power_entries INTEGER NOT NULL DEFAULT 0,
  flex_entries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_performance_run_id) REFERENCES backtest_performance_runs(backtest_performance_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_performance_run_id, window_name)
);

CREATE TABLE IF NOT EXISTS backtest_calibration_bins (
  backtest_calibration_bin_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_performance_run_id INTEGER NOT NULL,
  window_name TEXT NOT NULL CHECK (window_name IN ('ALL','7D','14D','30D')),
  bucket_index INTEGER NOT NULL,
  probability_min REAL NOT NULL,
  probability_max REAL NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  average_predicted_probability REAL,
  observed_win_rate REAL,
  absolute_calibration_error REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_performance_run_id) REFERENCES backtest_performance_runs(backtest_performance_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_performance_run_id, window_name, bucket_index)
);

CREATE INDEX IF NOT EXISTS idx_backtest_performance_runs_backtest_time
  ON backtest_performance_runs(backtest_run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_performance_windows_run
  ON backtest_performance_windows(backtest_performance_run_id, window_name);
CREATE INDEX IF NOT EXISTS idx_backtest_calibration_bins_run_window
  ON backtest_calibration_bins(backtest_performance_run_id, window_name, bucket_index);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_3_INSTALLED','SYSTEM','{"release":"3.3","build":"4.3","feature":"Backtest performance metrics, calibration, directional analysis, drawdown, and configurable Power/Flex ROI simulation"}');
