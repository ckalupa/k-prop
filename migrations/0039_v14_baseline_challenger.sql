PRAGMA foreign_keys = ON;

-- Release 3.4 / Build 5.1: v14 Baseline Challenger
-- Registers a conservative, leakage-safe calibration challenger. v13 remains the
-- only production-facing model. The challenger writes SHADOW predictions only.

UPDATE model_versions
SET execution_enabled=0,
    last_execution_status='DISABLED',
    last_execution_error=NULL,
    updated_at=CURRENT_TIMESTAMP
WHERE version_name='v13-shadow-plumbing' AND model_role='CHALLENGER';

INSERT INTO model_versions(
  version_name,description,is_active,created_at,model_role,lifecycle_status,
  code_identifier,feature_schema_version,config_json,release_notes,activated_at,
  updated_at,execution_enabled,execution_priority,shadow_source_model_version_id,
  last_execution_status
)
SELECT
  'v14-baseline-challenger',
  'Release 3.4 baseline challenger. Reuses the production projection/ranking signal but recalibrates preferred-side probability from prior certified walk-forward history only. Shadow mode only.',
  0,CURRENT_TIMESTAMP,'CHALLENGER','ACTIVE',
  'shadow-adapter:v14-baseline-calibrated-v1',
  'prop-snapshot-v1',
  '{"model_family":"v14_baseline","calibration":"side_specific_empirical_buckets","minimum_bucket_rows":40,"bucket_widths":[0.05,0.10],"beta_shrinkage":true,"probability_cap":0.70,"pooled_cap":0.62,"play_threshold":0.54,"anti_lookahead":"board_date_strictly_before_target","production_unchanged":true}',
  'Build 5.1 establishes the v14 baseline as a conservative shadow challenger. It addresses v13 overconfidence without hand-coding the best retrospective edge segments. Promotion remains manual and disabled.',
  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1,50,
  (SELECT model_version_id FROM model_versions WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE' ORDER BY model_version_id DESC LIMIT 1),
  'SUCCEEDED'
WHERE NOT EXISTS(SELECT 1 FROM model_versions WHERE version_name='v14-baseline-challenger');

UPDATE model_versions
SET execution_enabled=1,
    execution_priority=50,
    lifecycle_status='ACTIVE',
    model_role='CHALLENGER',
    code_identifier='shadow-adapter:v14-baseline-calibrated-v1',
    shadow_source_model_version_id=(SELECT model_version_id FROM model_versions WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE' ORDER BY model_version_id DESC LIMIT 1),
    updated_at=CURRENT_TIMESTAMP
WHERE version_name='v14-baseline-challenger';

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_5_1_INSTALLED','SYSTEM','{"release":"3.4","build":"5.1","feature":"v14 baseline calibrated shadow challenger","production_model_unchanged":true}');
