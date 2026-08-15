PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v8-calibration-instrumentation',
  'v7 volume-stability logic with empirical calibration reporting and improved model-review table usability. Confidence remains unaltered until enough graded recommendations exist.',
  0
);

UPDATE model_versions SET is_active = 0;
UPDATE model_versions SET is_active = 1 WHERE version_name = 'v8-calibration-instrumentation';
