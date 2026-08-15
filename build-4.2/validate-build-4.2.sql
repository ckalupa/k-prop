SELECT name FROM sqlite_master WHERE type='table' AND name IN ('backtest_runs','backtest_folds','backtest_fold_rows') ORDER BY name;
PRAGMA table_info(backtest_runs);
PRAGMA table_info(backtest_folds);
SELECT COUNT(*) AS dataset_builds FROM backtest_dataset_builds;
SELECT COUNT(*) AS historical_rows FROM backtest_dataset_rows;
SELECT COUNT(*) AS audit_rows FROM audit_events WHERE event_type='BUILD_4_2_INSTALLED';
