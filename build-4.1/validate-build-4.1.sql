SELECT name FROM sqlite_master WHERE type='table' AND name IN ('backtest_dataset_builds','backtest_dataset_rows') ORDER BY name;
PRAGMA table_info(backtest_dataset_builds);
PRAGMA table_info(backtest_dataset_rows);
SELECT COUNT(*) AS build_4_1_audit_rows FROM audit_events WHERE event_type='BUILD_4_1_INSTALLED';
