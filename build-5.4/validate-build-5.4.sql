SELECT version_name,model_role,lifecycle_status,execution_enabled,execution_priority,code_identifier
FROM model_versions
WHERE version_name IN ('v13-directional-calibration','v14-baseline-challenger')
ORDER BY model_role DESC,version_name;
SELECT COUNT(*) AS eligible_rows FROM backtest_dataset_rows_v3 WHERE backtest_eligible=1;
SELECT backtest_run_id,engine_version,status,eligible_row_count,distinct_test_dates,executed_fold_count,skipped_fold_count
FROM backtest_runs WHERE engine_version='walk-forward-v2' ORDER BY backtest_run_id DESC LIMIT 1;
