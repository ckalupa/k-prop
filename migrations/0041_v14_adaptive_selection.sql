PRAGMA foreign_keys = ON;

-- Release 3.4 / Build 5.3: Adaptive Challenger Selection
-- v13 remains production. Existing v14 challenger stays shadow-only and receives
-- the new prior-only adaptive selection adapter.

UPDATE model_versions
SET code_identifier='shadow-adapter:v14-adaptive-selection-v1',
    description='Release 3.4 adaptive challenger. Keeps Build 5.1 leakage-safe probability calibration, then applies shrunk prior-only segment evidence and an uncertainty penalty to PLAY/WATCH selection. Shadow mode only.',
    config_json='{"model_family":"v14_adaptive","baseline_calibration":"side_specific_empirical_buckets","adaptive_policy":"v14-adaptive-selection-v1","segment_prior":"Beta(25,25)","segment_dimensions":["side_x_edge","side_x_line","absolute_edge","pitcher_hand"],"minimum_segment_rows":{"side_x_edge":50,"side_x_line":60,"absolute_edge":75,"pitcher_hand":100},"adaptive_blend":0.65,"adaptive_probability_cap":0.62,"play_threshold":0.55,"anti_lookahead":"board_date_strictly_before_target","production_unchanged":true}',
    release_notes='Build 5.3 adds adaptive challenger selection. Segment performance is learned only from dates prior to each prediction, shrunk toward 50%, blended conservatively with Build 5.1 calibration, and penalized when evidence is sparse. v13 remains production and promotion remains manual.',
    execution_enabled=1,
    execution_priority=50,
    lifecycle_status='ACTIVE',
    model_role='CHALLENGER',
    last_execution_error=NULL,
    updated_at=CURRENT_TIMESTAMP
WHERE version_name='v14-baseline-challenger';

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_5_3_INSTALLED','SYSTEM','{"release":"3.4","build":"5.3","feature":"v14 adaptive prior-only challenger selection","production_model_unchanged":true,"challenger_shadow_only":true}');
