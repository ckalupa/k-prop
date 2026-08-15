PRAGMA foreign_keys = ON;

-- Release 3.4 / Build 5.4
-- Restore the live v14 challenger to the Build 5.1 calibrated baseline after
-- Build 5.3 adaptive selection underperformed in leakage-safe historical replay.
UPDATE model_versions
SET code_identifier='shadow-adapter:v14-baseline-calibrated-v1',
    description='Release 3.4 calibrated baseline challenger. Uses prior-only side-specific empirical calibration and remains shadow-only. Build 5.3 adaptive selection was rejected after historical replay underperformed.',
    config_json='{"model_family":"v14_baseline","calibration":"side_specific_empirical_buckets","minimum_bucket_rows":40,"beta_shrinkage":true,"play_threshold":0.54,"anti_lookahead":"board_date_strictly_before_target","adaptive_selection":"rejected_build_5_3","production_unchanged":true}',
    release_notes='Build 5.4 restores live v14 to the Build 5.1 calibrated baseline and adds read-only feature/error diagnostics. Build 5.3 adaptive selection remains available only as historical research evidence.',
    execution_enabled=1,
    execution_priority=50,
    lifecycle_status='ACTIVE',
    model_role='CHALLENGER',
    last_execution_error=NULL,
    updated_at=CURRENT_TIMESTAMP
WHERE version_name='v14-baseline-challenger';

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_5_4_INSTALLED','SYSTEM','{"release":"3.4","build":"5.4","feature":"restore v14 baseline plus feature diagnostics","adaptive_5_3_status":"REJECTED_RESEARCH_ONLY","production_model_unchanged":true,"challenger_shadow_only":true}');
