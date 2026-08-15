-- V11 ranked recommendation engine instrumentation.
ALTER TABLE recommendations ADD COLUMN recommendation_score REAL;
ALTER TABLE recommendations ADD COLUMN recommendation_band TEXT;
ALTER TABLE recommendations ADD COLUMN score_projection REAL;
ALTER TABLE recommendations ADD COLUMN score_recent_form REAL;
ALTER TABLE recommendations ADD COLUMN score_volume REAL;
ALTER TABLE recommendations ADD COLUMN score_matchup REAL;
ALTER TABLE recommendations ADD COLUMN score_role REAL;
ALTER TABLE recommendations ADD COLUMN score_completeness REAL;
ALTER TABLE recommendations ADD COLUMN score_explanation TEXT;

UPDATE model_versions SET is_active = 0;
INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v11-ranked-decision-board',
  'Transparent 0-100 ranked decision engine with projection, form, volume, matchup, role, and completeness components.',
  1
);
UPDATE model_versions
SET is_active = CASE WHEN version_name = 'v11-ranked-decision-board' THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS idx_recommendations_v11_score
  ON recommendations(model_version_id, recommendation_score DESC);
