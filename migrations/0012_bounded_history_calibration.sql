-- V12 bounded historical context and calibration layer.
ALTER TABLE feature_snapshots ADD COLUMN same_opponent_start_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feature_snapshots ADD COLUMN same_opponent_k_avg REAL;
ALTER TABLE feature_snapshots ADD COLUMN same_opponent_bf_avg REAL;
ALTER TABLE feature_snapshots ADD COLUMN same_opponent_adjustment REAL NOT NULL DEFAULT 0;

ALTER TABLE recommendations ADD COLUMN base_projected_strikeouts REAL;
ALTER TABLE recommendations ADD COLUMN matchup_projected_strikeouts REAL;
ALTER TABLE recommendations ADD COLUMN same_opponent_adjustment REAL NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN calibration_adjustment REAL NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN calibration_sample_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN calibration_hit_rate REAL;

UPDATE model_versions SET is_active = 0;
INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v12-bounded-history-calibration',
  'V11 core engine plus capped same-opponent projection context and Bayesian-shrunk historical score calibration. Raw historical prop outcomes never directly alter strikeout projections.',
  1
);
UPDATE model_versions
SET is_active = CASE WHEN version_name = 'v12-bounded-history-calibration' THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS idx_pitcher_game_stats_opponent_history
  ON pitcher_game_stats(pitcher_id, opponent_team_id, game_date DESC);
