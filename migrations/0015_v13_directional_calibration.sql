-- V13 directional calibration.
-- Activates side-aware scoring and stricter promotion gates implemented in src/index.ts.
UPDATE model_versions SET is_active = 0;

INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v13-directional-calibration',
  'Directional scoring calibration: matchup, recent form, and volume are evaluated differently for More and Less. More plays require stronger all-gate confirmation; calibration cannot promote a pick through eligibility gates.',
  1
);

UPDATE model_versions
SET is_active = CASE
  WHEN version_name = 'v13-directional-calibration' THEN 1
  ELSE 0
END;
