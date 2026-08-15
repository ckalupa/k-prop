PRAGMA foreign_keys = ON;

ALTER TABLE historical_feature_certifications ADD COLUMN information_cutoff_at TEXT;
ALTER TABLE historical_feature_certifications ADD COLUMN cutoff_source TEXT;
ALTER TABLE historical_feature_certifications ADD COLUMN certified_feature_snapshot_id INTEGER;
ALTER TABLE historical_feature_certifications ADD COLUMN certified_recommendation_id INTEGER;
ALTER TABLE historical_feature_certifications ADD COLUMN certified_model_version_id INTEGER;
ALTER TABLE historical_feature_certifications ADD COLUMN certified_opponent_features_json TEXT;
ALTER TABLE historical_feature_certifications ADD COLUMN certified_model_output_json TEXT;
ALTER TABLE historical_feature_certifications ADD COLUMN source_timing_status TEXT;

CREATE INDEX IF NOT EXISTS idx_historical_certification_cutoff
  ON historical_feature_certifications(certification_version, certification_class, information_cutoff_at);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES ('BUILD_4_1_2_1_INSTALLED','SYSTEM','{"release":"3.3","build":"4.1.2.1","feature":"Historical certification cutoff corrected to scheduled game start"}');
