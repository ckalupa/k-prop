PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS live_shadow_certifications (
 live_shadow_certification_id INTEGER PRIMARY KEY AUTOINCREMENT, certification_uuid TEXT NOT NULL UNIQUE,
 promotion_policy_id INTEGER NOT NULL, production_model_version_id INTEGER NOT NULL, candidate_model_version_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'COLLECTING' CHECK(status IN ('COLLECTING','TECHNICALLY_READY','CERTIFIED','BLOCKED','CLOSED')),
 started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, min_live_graded_pairs INTEGER NOT NULL,
 min_live_distinct_dates INTEGER NOT NULL, require_zero_runtime_failures INTEGER NOT NULL DEFAULT 1 CHECK(require_zero_runtime_failures IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
 FOREIGN KEY(production_model_version_id) REFERENCES model_versions(model_version_id), FOREIGN KEY(candidate_model_version_id) REFERENCES model_versions(model_version_id));
CREATE INDEX IF NOT EXISTS idx_live_shadow_cert_status ON live_shadow_certifications(status,started_at DESC);
CREATE TABLE IF NOT EXISTS live_shadow_failure_ledger (
 live_shadow_failure_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER, model_prediction_id INTEGER NOT NULL UNIQUE,
 prop_id INTEGER NOT NULL, board_date TEXT, failed_at TEXT NOT NULL, failure_scope TEXT NOT NULL CHECK(failure_scope IN ('PRE_CERTIFICATION','CERTIFICATION_WINDOW')),
 failure_type TEXT NOT NULL DEFAULT 'SHADOW_RUNTIME', error_message TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id),
 FOREIGN KEY(model_prediction_id) REFERENCES model_predictions(model_prediction_id), FOREIGN KEY(prop_id) REFERENCES props(prop_id));
CREATE INDEX IF NOT EXISTS idx_live_shadow_failure_cert_time ON live_shadow_failure_ledger(live_shadow_certification_id,failed_at DESC);
CREATE TABLE IF NOT EXISTS live_shadow_certification_evidence (
 live_shadow_certification_evidence_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL, evidence_uuid TEXT NOT NULL UNIQUE,
 captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, evidence_date TEXT NOT NULL, paired_predictions INTEGER NOT NULL DEFAULT 0, graded_pairs INTEGER NOT NULL DEFAULT 0,
 missing_production_pairs INTEGER NOT NULL DEFAULT 0, missing_candidate_pairs INTEGER NOT NULL DEFAULT 0, runtime_failures INTEGER NOT NULL DEFAULT 0,
 production_hit_rate REAL, candidate_hit_rate REAL, production_brier REAL, candidate_brier REAL, candidate_abs_calibration_gap REAL,
 evidence_json TEXT NOT NULL DEFAULT '{}', captured_by TEXT, FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id));
CREATE INDEX IF NOT EXISTS idx_live_shadow_evidence_cert_date ON live_shadow_certification_evidence(live_shadow_certification_id,evidence_date,captured_at DESC);
INSERT OR IGNORE INTO live_shadow_failure_ledger(model_prediction_id,prop_id,board_date,failed_at,failure_scope,failure_type,error_message,details_json)
SELECT mp.model_prediction_id,mp.prop_id,b.board_date,mp.predicted_at,'PRE_CERTIFICATION','SHADOW_RUNTIME',mp.error_message,'{"source":"model_predictions","classification":"pre-certification","build":"9.2"}'
FROM model_predictions mp JOIN props p ON p.prop_id=mp.prop_id JOIN boards b ON b.board_id=p.board_id JOIN model_versions mv ON mv.model_version_id=mp.model_version_id
WHERE mv.version_name='v14-baseline-challenger' AND mp.prediction_mode='SHADOW' AND mp.prediction_status='FAILED';
INSERT INTO live_shadow_certifications(certification_uuid,promotion_policy_id,production_model_version_id,candidate_model_version_id,status,min_live_graded_pairs,min_live_distinct_dates,require_zero_runtime_failures,notes)
SELECT lower(hex(randomblob(16))),pp.promotion_policy_id,prod.model_version_id,cand.model_version_id,'COLLECTING',pp.min_live_graded_pairs,pp.min_live_distinct_dates,pp.require_zero_runtime_failures,
'Build 9.2 certification window. Only predictions at or after started_at qualify. Earlier failures remain immutable historical evidence.'
FROM promotion_policies pp JOIN model_versions prod ON prod.model_role='PRODUCTION' AND prod.lifecycle_status='ACTIVE' JOIN model_versions cand ON cand.version_name=pp.candidate_version_name
WHERE pp.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM live_shadow_certifications WHERE status IN ('COLLECTING','TECHNICALLY_READY'))
ORDER BY pp.promotion_policy_id DESC,prod.model_version_id DESC,cand.model_version_id DESC LIMIT 1;
INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('BUILD_9_2_INSTALLED','SYSTEM','{"release":"3.8","build":"9.2","feature":"Live Shadow Certification","promotion_enabled":false,"production_models_changed":false}');
