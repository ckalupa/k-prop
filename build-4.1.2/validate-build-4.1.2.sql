SELECT name FROM sqlite_master WHERE type='table' AND name IN ('historical_feature_certification_runs','historical_feature_certifications','backtest_dataset_rows_v2','backtest_fold_rows_v2') ORDER BY name;
SELECT COUNT(*) AS certification_runs FROM historical_feature_certification_runs;
SELECT COUNT(*) AS certification_rows FROM historical_feature_certifications;
SELECT COUNT(*) AS v2_dataset_rows FROM backtest_dataset_rows_v2;
SELECT COUNT(*) AS v2_fold_rows FROM backtest_fold_rows_v2;
SELECT COUNT(*) AS install_audit_rows FROM audit_events WHERE event_type='BUILD_4_1_2_INSTALLED';
