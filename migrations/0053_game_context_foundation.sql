PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS game_context_snapshots (
  game_context_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_start TEXT,
  venue_id INTEGER,
  venue_name TEXT,
  day_night TEXT,
  temperature_f REAL,
  weather_condition TEXT,
  wind_text TEXT,
  wind_speed_mph REAL,
  humidity_pct REAL,
  home_plate_umpire_mlb_id INTEGER,
  home_plate_umpire_name TEXT,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  source_mode TEXT NOT NULL DEFAULT 'CURRENT_SYNC',
  payload_hash TEXT NOT NULL,
  quality_score INTEGER NOT NULL DEFAULT 0 CHECK(quality_score BETWEEN 0 AND 100),
  details_json TEXT NOT NULL DEFAULT '{}',
  sync_run_id INTEGER,
  FOREIGN KEY(sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE(mlb_game_pk,payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_game_context_date ON game_context_snapshots(official_date,scheduled_start);
CREATE INDEX IF NOT EXISTS idx_game_context_umpire ON game_context_snapshots(home_plate_umpire_mlb_id,official_date);
INSERT INTO data_source_status(source_name,dataset_name,status,expected_refresh_minutes,stale_after_minutes,status_message,updated_at)
VALUES('MLB_STATS_API','GAME_CONTEXT','NEVER_SYNCED',30,120,'Release 3.7 Build 8.1 game context has not synced yet.',CURRENT_TIMESTAMP)
ON CONFLICT(source_name,dataset_name) DO UPDATE SET expected_refresh_minutes=excluded.expected_refresh_minutes,stale_after_minutes=excluded.stale_after_minutes,updated_at=CURRENT_TIMESTAMP;
INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('BUILD_8_1_INSTALLED','SYSTEM','{"release":"3.7","build":"8.1","feature":"Game context foundation and current-date sync"}');
