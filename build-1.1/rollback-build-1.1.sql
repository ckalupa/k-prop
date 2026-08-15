-- EMERGENCY LOGICAL ROLLBACK ONLY.
-- Preferred rollback: restore the pre-deployment D1 export created by Deploy-Build-1.1.ps1.
-- This script removes only Build 1.1 tables/indexes. SQLite cannot safely remove the
-- added model_versions columns in place, so restoring the export is the complete rollback.

DROP TABLE IF EXISTS data_source_status;
DROP TABLE IF EXISTS sync_errors;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS model_feature_values;
DROP TABLE IF EXISTS model_predictions;
DROP INDEX IF EXISTS idx_model_versions_single_production;
DROP INDEX IF EXISTS idx_model_versions_role_status;

UPDATE model_versions
SET is_active = CASE WHEN version_name = 'v13-directional-calibration' THEN 1 ELSE 0 END;
