SELECT COUNT(*) AS archive_certification_tables
FROM sqlite_master
WHERE type='table' AND name IN ('archive_historical_certification_runs','archive_historical_certifications');

SELECT COUNT(*) AS dataset_v3_tables
FROM sqlite_master
WHERE type='table' AND name IN ('backtest_dataset_rows_v3','backtest_fold_rows_v3');

SELECT COUNT(*) AS archive_reconstructions
FROM archive_historical_reconstructions;

SELECT COUNT(*) AS archive_research_ready
FROM archive_historical_reconstructions r
WHERE r.archive_historical_reconstruction_id=(SELECT MAX(r2.archive_historical_reconstruction_id) FROM archive_historical_reconstructions r2 WHERE r2.historical_archive_prop_id=r.historical_archive_prop_id)
  AND r.reconstruction_status='RESEARCH_READY';

SELECT COUNT(*) AS foreign_key_violations FROM pragma_foreign_key_check;
