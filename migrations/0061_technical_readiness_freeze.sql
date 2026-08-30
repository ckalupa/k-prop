PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS technical_readiness_freezes (
 technical_readiness_freeze_id INTEGER PRIMARY KEY AUTOINCREMENT,
 freeze_uuid TEXT NOT NULL UNIQUE,
 live_shadow_certification_id INTEGER NOT NULL UNIQUE,
 promotion_policy_id INTEGER NOT NULL,
 production_model_version_id INTEGER NOT NULL,
 candidate_model_version_id INTEGER NOT NULL,
 decision_status TEXT NOT NULL CHECK(decision_status IN ('TECHNICALLY_READY','CERTIFICATION_FAILED')),
 frozen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 live_graded_pairs INTEGER NOT NULL DEFAULT 0,
 live_distinct_dates INTEGER NOT NULL DEFAULT 0,
 runtime_failures INTEGER NOT NULL DEFAULT 0,
 pair_integrity_failures INTEGER NOT NULL DEFAULT 0,
 live_hit_delta REAL,
 live_brier_delta REAL,
 candidate_abs_calibration_gap REAL,
 gates_json TEXT NOT NULL DEFAULT '[]',
 evidence_json TEXT NOT NULL DEFAULT '{}',
 frozen_by TEXT,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id),
 FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
 FOREIGN KEY(production_model_version_id) REFERENCES model_versions(model_version_id),
 FOREIGN KEY(candidate_model_version_id) REFERENCES model_versions(model_version_id)
);
CREATE INDEX IF NOT EXISTS idx_technical_readiness_freezes_candidate ON technical_readiness_freezes(candidate_model_version_id,frozen_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_technical_readiness_freezes_no_update BEFORE UPDATE ON technical_readiness_freezes BEGIN SELECT RAISE(ABORT,'technical readiness freeze is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_technical_readiness_freezes_no_delete BEFORE DELETE ON technical_readiness_freezes BEGIN SELECT RAISE(ABORT,'technical readiness freeze is immutable'); END;
INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('BUILD_9_4_INSTALLED','SYSTEM','{"release":"3.8","build":"9.4","feature":"Final Technical Readiness Freeze","promotion_enabled":false,"production_models_changed":false}');
