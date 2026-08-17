PRAGMA foreign_keys = ON;

-- Build 9.2.5: support certification-window lookups without repeated full prediction-ledger scans.
CREATE INDEX IF NOT EXISTS idx_model_predictions_certification_lookup
  ON model_predictions(model_version_id, prediction_mode, prediction_status, prop_id, predicted_at DESC, model_prediction_id DESC);

PRAGMA optimize;

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_9_2_5_INSTALLED','SYSTEM','{"release":"3.8","build":"9.2.5","feature":"Promotion Readiness query hardening","promotion_enabled":false,"production_models_changed":false}');
