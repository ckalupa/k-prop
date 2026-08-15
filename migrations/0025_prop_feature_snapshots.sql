PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS prop_feature_snapshots (
  prop_feature_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_uuid TEXT NOT NULL UNIQUE,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  model_version_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  information_cutoff_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  board_date TEXT NOT NULL,
  prop_line REAL NOT NULL,
  available_side TEXT,
  prop_type TEXT,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  pitcher_daily_feature_id INTEGER,
  team_daily_feature_id INTEGER,
  legacy_feature_snapshot_id INTEGER,
  pitcher_feature_as_of_date TEXT,
  team_feature_as_of_date TEXT,
  pitcher_source_cutoff_date TEXT,
  team_source_cutoff_date TEXT,
  pitcher_data_quality_score INTEGER,
  team_data_quality_score INTEGER,
  snapshot_status TEXT NOT NULL DEFAULT 'PARTIAL'
    CHECK (snapshot_status IN ('COMPLETE','PARTIAL','INSUFFICIENT')),
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  pitcher_features_json TEXT,
  team_features_json TEXT,
  legacy_features_json TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (pitcher_daily_feature_id) REFERENCES pitcher_daily_features(pitcher_daily_feature_id),
  FOREIGN KEY (team_daily_feature_id) REFERENCES team_daily_features(team_daily_feature_id),
  FOREIGN KEY (legacy_feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_prop_time
  ON prop_feature_snapshots(prop_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_board
  ON prop_feature_snapshots(board_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_model
  ON prop_feature_snapshots(model_version_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_feature_snapshots_status
  ON prop_feature_snapshots(snapshot_status, captured_at DESC);

ALTER TABLE model_predictions ADD COLUMN prop_feature_snapshot_id INTEGER REFERENCES prop_feature_snapshots(prop_feature_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_model_predictions_prop_feature_snapshot
  ON model_predictions(prop_feature_snapshot_id);

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_3_3_INSTALLED',
  'SYSTEM',
  '{"release":"3.2","build":"3.3","feature":"Immutable prop feature snapshots"}'
);
