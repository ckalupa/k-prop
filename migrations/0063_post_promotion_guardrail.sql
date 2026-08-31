PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS post_promotion_guardrail_windows (
  post_promotion_guardrail_window_id INTEGER PRIMARY KEY AUTOINCREMENT,
  guardrail_uuid TEXT NOT NULL UNIQUE,
  manual_model_promotion_id INTEGER NOT NULL UNIQUE,
  promoted_model_version_id INTEGER NOT NULL,
  rollback_model_version_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  min_health_graded_pairs INTEGER NOT NULL DEFAULT 50,
  min_health_distinct_dates INTEGER NOT NULL DEFAULT 3,
  min_full_graded_pairs INTEGER NOT NULL DEFAULT 100,
  min_full_distinct_dates INTEGER NOT NULL DEFAULT 7,
  max_hit_rate_drop REAL NOT NULL DEFAULT 0.08,
  max_brier_increase REAL NOT NULL DEFAULT 0.05,
  max_abs_calibration_gap REAL NOT NULL DEFAULT 0.10,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  policy_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(manual_model_promotion_id) REFERENCES manual_model_promotions(manual_model_promotion_id),
  FOREIGN KEY(promoted_model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(rollback_model_version_id) REFERENCES model_versions(model_version_id)
);

CREATE TABLE IF NOT EXISTS post_promotion_guardrail_failures (
  post_promotion_guardrail_failure_id INTEGER PRIMARY KEY AUTOINCREMENT,
  failure_uuid TEXT NOT NULL UNIQUE,
  manual_model_promotion_id INTEGER NOT NULL,
  model_version_id INTEGER NOT NULL,
  prop_id INTEGER,
  board_date TEXT,
  failure_stage TEXT NOT NULL,
  error_message TEXT NOT NULL,
  failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(manual_model_promotion_id) REFERENCES manual_model_promotions(manual_model_promotion_id),
  FOREIGN KEY(model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(prop_id) REFERENCES props(prop_id)
);

CREATE INDEX IF NOT EXISTS idx_post_promotion_guardrail_failures_time
  ON post_promotion_guardrail_failures(manual_model_promotion_id, failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_promotion_guardrail_failures_prop
  ON post_promotion_guardrail_failures(prop_id, failed_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_post_promotion_guardrail_windows_no_update
BEFORE UPDATE ON post_promotion_guardrail_windows
BEGIN SELECT RAISE(ABORT,'post-promotion guardrail window is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_post_promotion_guardrail_windows_no_delete
BEFORE DELETE ON post_promotion_guardrail_windows
BEGIN SELECT RAISE(ABORT,'post-promotion guardrail window is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_post_promotion_guardrail_failures_no_update
BEFORE UPDATE ON post_promotion_guardrail_failures
BEGIN SELECT RAISE(ABORT,'post-promotion guardrail failure is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_post_promotion_guardrail_failures_no_delete
BEFORE DELETE ON post_promotion_guardrail_failures
BEGIN SELECT RAISE(ABORT,'post-promotion guardrail failure is immutable'); END;

INSERT INTO post_promotion_guardrail_windows(
  guardrail_uuid, manual_model_promotion_id, promoted_model_version_id, rollback_model_version_id,
  started_at, policy_json
)
SELECT
  lower(hex(randomblob(16))), p.manual_model_promotion_id, p.promoted_model_version_id,
  p.previous_production_model_version_id, p.promoted_at,
  '{"policy":"post-promotion-guardrail-v1","health_sample":{"graded_pairs":50,"distinct_dates":3},"full_sample":{"graded_pairs":100,"distinct_dates":7},"tolerances":{"hit_rate_drop":0.08,"brier_increase":0.05,"abs_calibration_gap":0.10},"rollback":"manual_only","automatic_rollback":false}'
FROM manual_model_promotions p
WHERE p.promotion_status='COMPLETED'
  AND NOT EXISTS (
    SELECT 1 FROM post_promotion_guardrail_windows w
    WHERE w.manual_model_promotion_id=p.manual_model_promotion_id
  );

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_9_6_INSTALLED','SYSTEM','{"release":"3.8","build":"9.6","feature":"Post-Promotion Guardrail Window","automatic_rollback":false,"production_model_changed_on_install":false}');
