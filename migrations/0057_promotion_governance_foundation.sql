PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS promotion_policies (
  promotion_policy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RETIRED')),
  candidate_version_name TEXT NOT NULL,
  min_historical_paired_rows INTEGER NOT NULL DEFAULT 1000,
  min_live_graded_pairs INTEGER NOT NULL DEFAULT 200,
  min_live_distinct_dates INTEGER NOT NULL DEFAULT 14,
  min_live_hit_delta REAL NOT NULL DEFAULT -0.01,
  max_live_brier_delta REAL NOT NULL DEFAULT 0.0,
  max_abs_live_calibration_gap REAL NOT NULL DEFAULT 0.05,
  require_zero_runtime_failures INTEGER NOT NULL DEFAULT 1 CHECK(require_zero_runtime_failures IN (0,1)),
  require_manual_approval INTEGER NOT NULL DEFAULT 1 CHECK(require_manual_approval IN (0,1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promotion_readiness_snapshots (
  promotion_readiness_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_uuid TEXT NOT NULL UNIQUE,
  promotion_policy_id INTEGER NOT NULL,
  production_model_version_id INTEGER NOT NULL,
  candidate_model_version_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gate_status TEXT NOT NULL CHECK(gate_status IN ('OBSERVATION','TECHNICALLY_READY','BLOCKED')),
  historical_paired_rows INTEGER NOT NULL DEFAULT 0,
  historical_distinct_dates INTEGER NOT NULL DEFAULT 0,
  live_paired_predictions INTEGER NOT NULL DEFAULT 0,
  live_graded_pairs INTEGER NOT NULL DEFAULT 0,
  live_distinct_dates INTEGER NOT NULL DEFAULT 0,
  production_live_hit_rate REAL,
  candidate_live_hit_rate REAL,
  live_hit_delta REAL,
  production_live_brier REAL,
  candidate_live_brier REAL,
  live_brier_delta REAL,
  candidate_abs_calibration_gap REAL,
  candidate_runtime_failures INTEGER NOT NULL DEFAULT 0,
  gates_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  captured_by TEXT,
  FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
  FOREIGN KEY(production_model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(candidate_model_version_id) REFERENCES model_versions(model_version_id)
);

CREATE INDEX IF NOT EXISTS idx_promotion_snapshots_candidate_time ON promotion_readiness_snapshots(candidate_model_version_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotion_snapshots_status_time ON promotion_readiness_snapshots(gate_status,captured_at DESC);

INSERT INTO promotion_policies(policy_name,status,candidate_version_name,min_historical_paired_rows,min_live_graded_pairs,min_live_distinct_dates,min_live_hit_delta,max_live_brier_delta,max_abs_live_calibration_gap,require_zero_runtime_failures,require_manual_approval,config_json)
SELECT 'promotion-gate-v1','ACTIVE','v14-baseline-challenger',1000,200,14,-0.01,0.0,0.05,1,1,
  '{"historical":"certified walk-forward-v2 evidence","live":"native paired production/shadow predictions only","hit_rule":"non-inferiority: candidate may trail production by at most 1 percentage point after minimum live sample","brier_rule":"candidate must be no worse than production","manual_promotion_only":true,"build_9_1_promotion_enabled":false}'
WHERE NOT EXISTS (SELECT 1 FROM promotion_policies WHERE policy_name='promotion-gate-v1');

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_9_1_INSTALLED','SYSTEM','{"release":"3.8","build":"9.1","feature":"Promotion governance foundation and readiness evidence snapshots","promotion_enabled":false,"production_models_changed":false}');
