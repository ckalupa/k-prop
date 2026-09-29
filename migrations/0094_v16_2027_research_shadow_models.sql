-- K-PROP 2027 V16 research shadow registration.
-- Both challengers are intentionally disabled at install.
-- Production model remains unchanged.

INSERT INTO model_versions(
  version_name,description,is_active,created_at,model_role,lifecycle_status,
  code_identifier,feature_schema_version,config_json,release_notes,activated_at,
  retired_at,updated_at,execution_enabled,execution_priority,
  shadow_source_model_version_id,last_execution_status,last_execution_error
)
SELECT
  'v16-a-v14-shrink-shadow',
  'V16-A 2027 research shadow. Preserves the V14 direction/rank signal and applies frozen full-2026 probability shrinkage toward 0.50.',
  0,CURRENT_TIMESTAMP,'CHALLENGER','ACTIVE',
  'shadow-adapter:v16-a-v14-shrink-v1','prop-snapshot-v1',
  '{"research_only":true,"production_unchanged":true,"dataset_build_id":4,"training_rows":1054,"formula":"p=0.5+alpha*(p_raw-0.5)","alpha":0.16386188304480287,"play_threshold":0.54,"fixed_2026_fit":true}',
  '2027 prospective shadow candidate. Disabled at registration. No production, grading, guardrail, or promotion influence.',
  NULL,NULL,CURRENT_TIMESTAMP,0,230,11,'DISABLED',NULL
WHERE NOT EXISTS(
  SELECT 1 FROM model_versions
  WHERE version_name='v16-a-v14-shrink-shadow'
     OR code_identifier='shadow-adapter:v16-a-v14-shrink-v1'
);

INSERT INTO model_versions(
  version_name,description,is_active,created_at,model_role,lifecycle_status,
  code_identifier,feature_schema_version,config_json,release_notes,activated_at,
  retired_at,updated_at,execution_enabled,execution_priority,
  shadow_source_model_version_id,last_execution_status,last_execution_error
)
SELECT
  'v16-b-calibrated-raw-blend-shadow',
  'V16-B 2027 research shadow. Blends 85% V16-A shrinkage with 15% frozen full-2026 raw-feature logistic probability.',
  0,CURRENT_TIMESTAMP,'CHALLENGER','ACTIVE',
  'shadow-adapter:v16-b-calibrated-raw-blend-v1','prop-snapshot-v1',
  '{"research_only":true,"production_unchanged":true,"dataset_build_id":4,"training_rows":1054,"blend_v16a_weight":0.85,"blend_raw_logistic_weight":0.15,"v16a_alpha":0.16386188304480287,"raw_logistic_coefficient_version":"v16-b-raw-logistic-build4-full2026-v1","play_threshold":0.54,"fixed_2026_fit":true}',
  '2027 prospective shadow candidate. Disabled at registration. Uses immutable prop_feature_snapshot pitcher/team JSON. No production, grading, guardrail, or promotion influence.',
  NULL,NULL,CURRENT_TIMESTAMP,0,240,11,'DISABLED',NULL
WHERE NOT EXISTS(
  SELECT 1 FROM model_versions
  WHERE version_name='v16-b-calibrated-raw-blend-shadow'
     OR code_identifier='shadow-adapter:v16-b-calibrated-raw-blend-v1'
);

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES(
  'V16_2027_RESEARCH_SHADOWS_REGISTERED',
  'SYSTEM',
  '{"v16_a":"v16-a-v14-shrink-shadow","v16_b":"v16-b-calibrated-raw-blend-shadow","execution_enabled":false,"production_model_unchanged":true,"source_model_version_id":11}'
);
