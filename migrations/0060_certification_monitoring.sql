PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS live_shadow_monitor_checkpoints (
 live_shadow_monitor_checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL,
 checkpoint_type TEXT NOT NULL CHECK(checkpoint_type IN ('DAILY','MILESTONE','MANUAL')), checkpoint_key TEXT NOT NULL, checkpoint_label TEXT NOT NULL,
 graded_pairs INTEGER NOT NULL DEFAULT 0, distinct_dates INTEGER NOT NULL DEFAULT 0, runtime_failures INTEGER NOT NULL DEFAULT 0, pair_integrity_failures INTEGER NOT NULL DEFAULT 0,
 hit_delta REAL, brier_delta REAL, abs_calibration_gap REAL, monitor_status TEXT NOT NULL CHECK(monitor_status IN ('COLLECTING','BLOCKED','TECHNICALLY_READY')),
 snapshot_json TEXT NOT NULL DEFAULT '{}', trigger_source TEXT NOT NULL, captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id), UNIQUE(live_shadow_certification_id,checkpoint_key));
CREATE INDEX IF NOT EXISTS idx_live_shadow_monitor_checkpoint_cert ON live_shadow_monitor_checkpoints(live_shadow_certification_id,captured_at DESC);
CREATE TABLE IF NOT EXISTS live_shadow_monitor_alerts (
 live_shadow_monitor_alert_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL, alert_key TEXT NOT NULL,
 alert_type TEXT NOT NULL CHECK(alert_type IN ('RUNTIME_FAILURE','PAIR_INTEGRITY')), severity TEXT NOT NULL DEFAULT 'BLOCKING', observed_value INTEGER NOT NULL DEFAULT 0,
 message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id), UNIQUE(live_shadow_certification_id,alert_key));
CREATE INDEX IF NOT EXISTS idx_live_shadow_monitor_alert_cert ON live_shadow_monitor_alerts(live_shadow_certification_id,created_at DESC);
INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('BUILD_9_3_INSTALLED','SYSTEM','{"release":"3.8","build":"9.3","feature":"Certification Monitoring & Checkpoints","promotion_enabled":false,"production_models_changed":false}');
