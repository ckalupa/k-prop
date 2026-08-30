PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS manual_model_promotions (
  manual_model_promotion_id INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_uuid TEXT NOT NULL UNIQUE,
  technical_readiness_freeze_id INTEGER NOT NULL UNIQUE,
  promotion_policy_id INTEGER NOT NULL,
  previous_production_model_version_id INTEGER NOT NULL,
  promoted_model_version_id INTEGER NOT NULL UNIQUE,
  promotion_status TEXT NOT NULL CHECK(promotion_status IN ('COMPLETED')),
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_by TEXT NOT NULL,
  confirmation_text TEXT NOT NULL,
  pre_state_json TEXT NOT NULL,
  post_state_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  FOREIGN KEY(technical_readiness_freeze_id) REFERENCES technical_readiness_freezes(technical_readiness_freeze_id),
  FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
  FOREIGN KEY(previous_production_model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(promoted_model_version_id) REFERENCES model_versions(model_version_id)
);
CREATE INDEX IF NOT EXISTS idx_manual_model_promotions_time ON manual_model_promotions(promoted_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_manual_model_promotions_no_update BEFORE UPDATE ON manual_model_promotions BEGIN SELECT RAISE(ABORT,'manual model promotion record is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_manual_model_promotions_no_delete BEFORE DELETE ON manual_model_promotions BEGIN SELECT RAISE(ABORT,'manual model promotion record is immutable'); END;
INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('BUILD_9_5_INSTALLED','SYSTEM','{"release":"3.8","build":"9.5","feature":"Guarded Manual Promotion Control","promotion_on_install":false,"requires_immutable_readiness_freeze":true}');
