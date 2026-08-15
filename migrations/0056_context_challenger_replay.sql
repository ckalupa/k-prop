PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_challenger_replay_runs (
  context_replay_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  replay_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dates_completed INTEGER NOT NULL DEFAULT 0,
  rows_scored INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);

CREATE TABLE IF NOT EXISTS context_challenger_replay_dates (
  context_replay_date_id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_replay_run_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('EXECUTED','SKIPPED','FAILED')),
  train_rows INTEGER NOT NULL DEFAULT 0,
  test_rows INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  disagreements INTEGER NOT NULL DEFAULT 0,
  improved INTEGER NOT NULL DEFAULT 0,
  harmed INTEGER NOT NULL DEFAULT 0,
  boost_rows INTEGER NOT NULL DEFAULT 0,
  suppress_rows INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(context_replay_run_id) REFERENCES context_challenger_replay_runs(context_replay_run_id) ON DELETE CASCADE,
  UNIQUE(context_replay_run_id,board_date)
);

CREATE TABLE IF NOT EXISTS context_challenger_replay_rows (
  context_replay_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_replay_run_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  pitcher_id INTEGER NOT NULL,
  prop_line REAL NOT NULL,
  model_edge REAL,
  baseline_side TEXT,
  baseline_hit INTEGER,
  challenger_side TEXT,
  challenger_hit INTEGER,
  disagreement INTEGER NOT NULL DEFAULT 0,
  context_expected_baseline_hit REAL,
  prior_global_hit_rate REAL,
  context_signal_count INTEGER NOT NULL DEFAULT 0,
  confidence_class TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(confidence_class IN ('BOOST','NEUTRAL','SUPPRESS')),
  weather_group TEXT,
  wind_direction_group TEXT,
  roof_type TEXT,
  is_roof_closed INTEGER NOT NULL DEFAULT 0,
  day_night TEXT,
  temperature_f REAL,
  temperature_band TEXT,
  home_plate_umpire_mlb_id INTEGER,
  feature_quality_score REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(context_replay_run_id) REFERENCES context_challenger_replay_runs(context_replay_run_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  UNIQUE(context_replay_run_id,backtest_dataset_row_id)
);

CREATE INDEX IF NOT EXISTS idx_context_replay_rows_run_date ON context_challenger_replay_rows(context_replay_run_id,board_date);
CREATE INDEX IF NOT EXISTS idx_context_replay_rows_confidence ON context_challenger_replay_rows(context_replay_run_id,confidence_class);
CREATE INDEX IF NOT EXISTS idx_context_replay_dates_run_date ON context_challenger_replay_dates(context_replay_run_id,board_date);

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_8_4_INSTALLED','SYSTEM','{"release":"3.7","build":"8.4","feature":"Context challenger chronological replay and confidence diagnostics","production_models_changed":false}');
