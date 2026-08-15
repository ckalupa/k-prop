PRAGMA foreign_keys = ON;

ALTER TABLE feature_snapshots ADD COLUMN last_10_k_avg REAL;
ALTER TABLE feature_snapshots ADD COLUMN average_bf_last_5 REAL;
ALTER TABLE feature_snapshots ADD COLUMN average_pitch_count_last_5 REAL;
ALTER TABLE feature_snapshots ADD COLUMN starter_rate_last_10 REAL;
ALTER TABLE feature_snapshots ADD COLUMN form_delta_l3_l10 REAL;

INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v7-volume-stability',
  'Opponent handedness model with L3/L5/L10 form, batters-faced and pitch-count volume, starter-role stability, confidence caps, and play downgrades.',
  0
);

UPDATE model_versions SET is_active = 0;
UPDATE model_versions SET is_active = 1 WHERE version_name = 'v7-volume-stability';
