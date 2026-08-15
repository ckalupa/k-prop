PRAGMA foreign_keys = ON;

ALTER TABLE prop_feature_snapshots ADD COLUMN overall_data_quality_score INTEGER CHECK (overall_data_quality_score BETWEEN 0 AND 100);
ALTER TABLE prop_feature_snapshots ADD COLUMN data_quality_grade TEXT CHECK (data_quality_grade IN ('A','B','C','D','F'));
ALTER TABLE prop_feature_snapshots ADD COLUMN quality_gate TEXT CHECK (quality_gate IN ('PASS','CAUTION','BLOCK'));
ALTER TABLE prop_feature_snapshots ADD COLUMN challenger_eligible INTEGER NOT NULL DEFAULT 0 CHECK (challenger_eligible IN (0,1));
ALTER TABLE prop_feature_snapshots ADD COLUMN quality_flags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prop_feature_snapshots ADD COLUMN critical_quality_flags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prop_feature_snapshots ADD COLUMN quality_policy_version TEXT NOT NULL DEFAULT 'prop-quality-v1-backfill';

-- Backfill snapshots created before Build 3.4 with a conservative score based on
-- the quality information that was actually frozen at capture time. New
-- snapshots receive the richer runtime scoring policy in Worker code.
UPDATE prop_feature_snapshots
SET overall_data_quality_score = CASE
      WHEN snapshot_status = 'INSUFFICIENT' THEN 25
      WHEN snapshot_status = 'PARTIAL' THEN MIN(65, COALESCE(pitcher_data_quality_score, team_data_quality_score, 50))
      ELSE ROUND((COALESCE(pitcher_data_quality_score, 80) + COALESCE(team_data_quality_score, 80)) / 2.0)
    END,
    quality_flags_json = missing_features_json,
    critical_quality_flags_json = CASE WHEN snapshot_status = 'COMPLETE' THEN '[]' ELSE missing_features_json END;

UPDATE prop_feature_snapshots
SET data_quality_grade = CASE
      WHEN overall_data_quality_score >= 90 THEN 'A'
      WHEN overall_data_quality_score >= 80 THEN 'B'
      WHEN overall_data_quality_score >= 70 THEN 'C'
      WHEN overall_data_quality_score >= 60 THEN 'D'
      ELSE 'F'
    END,
    quality_gate = CASE
      WHEN snapshot_status <> 'COMPLETE' OR overall_data_quality_score < 60 THEN 'BLOCK'
      WHEN overall_data_quality_score < 85 THEN 'CAUTION'
      ELSE 'PASS'
    END,
    challenger_eligible = CASE
      WHEN snapshot_status = 'COMPLETE' AND overall_data_quality_score >= 75 THEN 1
      ELSE 0
    END;

CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_quality_gate
  ON prop_feature_snapshots(quality_gate, overall_data_quality_score DESC, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_challenger_eligible
  ON prop_feature_snapshots(challenger_eligible, board_date DESC, captured_at DESC);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_3_4_INSTALLED',
  'SYSTEM',
  '{"release":"3.2","build":"3.4","feature":"Prop snapshot data quality scoring and challenger gate"}'
);
