-- Emergency logical rollback only. D1 migrations are forward-only in normal operation.
-- Disable use of the reconstruction feature by leaving these tables untouched and reverting Worker code.
-- Native prop_feature_snapshots are never modified by Build 4.1.1.
SELECT COUNT(*) AS reconstruction_rows_preserved_for_audit FROM historical_feature_reconstructions;
