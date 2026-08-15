PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_context_features (
  context_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  context_certification_id INTEGER NOT NULL,
  game_context_snapshot_id INTEGER,
  mlb_game_pk INTEGER,
  feature_version TEXT NOT NULL DEFAULT 'context-v1',
  feature_status TEXT NOT NULL,
  venue_id INTEGER,
  venue_name TEXT,
  roof_type TEXT,
  day_night TEXT,
  is_night INTEGER NOT NULL DEFAULT 0,
  temperature_f REAL,
  temperature_delta_70 REAL,
  weather_condition TEXT,
  weather_group TEXT,
  wind_text TEXT,
  wind_speed_mph REAL,
  wind_direction_group TEXT,
  is_roof_closed INTEGER NOT NULL DEFAULT 0,
  home_plate_umpire_mlb_id INTEGER,
  home_plate_umpire_name TEXT,
  source_quality_score INTEGER NOT NULL DEFAULT 0,
  feature_quality_score INTEGER NOT NULL DEFAULT 0,
  promotion_eligible INTEGER NOT NULL DEFAULT 0,
  provenance_class TEXT NOT NULL DEFAULT 'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  feature_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(context_certification_id) REFERENCES game_context_backfill_certifications(context_certification_id) ON DELETE CASCADE,
  FOREIGN KEY(game_context_snapshot_id) REFERENCES game_context_snapshots(game_context_snapshot_id) ON DELETE SET NULL,
  UNIQUE(backtest_run_id,backtest_dataset_row_id,feature_version)
);

CREATE INDEX IF NOT EXISTS idx_hist_context_features_date ON historical_context_features(backtest_run_id,board_date,feature_status);
CREATE INDEX IF NOT EXISTS idx_hist_context_features_game ON historical_context_features(mlb_game_pk,board_date);
CREATE INDEX IF NOT EXISTS idx_hist_context_features_umpire ON historical_context_features(home_plate_umpire_mlb_id,board_date);

INSERT INTO data_source_status(source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,metadata_json,updated_at)
VALUES('FEATURE_STORE','HISTORICAL_CONTEXT_FEATURES','NEVER_SYNCED',1440,10080,'Release 3.7 Build 8.3 context features have not been built yet.','{"feature_version":"context-v1","research_only":true}',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_8_3_INSTALLED','SYSTEM','{"release":"3.7","build":"8.3","feature":"Historical context feature engineering","production_models_changed":false}');
