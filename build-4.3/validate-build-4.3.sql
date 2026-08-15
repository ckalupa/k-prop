SELECT 'backtest_performance_runs' AS table_name, COUNT(*) AS exists_count FROM sqlite_master WHERE type='table' AND name='backtest_performance_runs';
SELECT 'backtest_performance_windows' AS table_name, COUNT(*) AS exists_count FROM sqlite_master WHERE type='table' AND name='backtest_performance_windows';
SELECT 'backtest_calibration_bins' AS table_name, COUNT(*) AS exists_count FROM sqlite_master WHERE type='table' AND name='backtest_calibration_bins';
SELECT COUNT(*) AS build_4_3_audit_events FROM audit_events WHERE event_type='BUILD_4_3_INSTALLED';
