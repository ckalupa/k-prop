PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_handedness_stats (
  team_handedness_stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('R', 'L')),
  plate_appearances INTEGER NOT NULL,
  strikeouts INTEGER NOT NULL,
  strikeout_rate REAL NOT NULL,
  league_average_rate REAL NOT NULL,
  handedness_edge REAL NOT NULL,
  source TEXT,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  UNIQUE (team_id, season, pitcher_hand)
);

CREATE INDEX IF NOT EXISTS idx_team_handedness_lookup
  ON team_handedness_stats(team_id, season, pitcher_hand);

INSERT OR IGNORE INTO model_versions (version_name, description, is_active)
VALUES (
  'v6-handedness',
  'Recent pitcher form and workload with opponent team strikeout rate versus pitcher handedness.',
  0
);

UPDATE model_versions SET is_active = 0;
UPDATE model_versions SET is_active = 1 WHERE version_name = 'v6-handedness';
