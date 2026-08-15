PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS statcast_source_state (
  source_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NEVER_SYNCED' CHECK(status IN ('NEVER_SYNCED','HEALTHY','STALE','FAILED','PAUSED')),
  last_attempt_at TEXT,
  last_success_at TEXT,
  complete_through_date TEXT,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS statcast_pitch_events (
  statcast_pitch_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  pitcher_mlb_id INTEGER NOT NULL,
  batter_mlb_id INTEGER,
  at_bat_number INTEGER NOT NULL,
  pitch_number INTEGER NOT NULL,
  inning INTEGER,
  half_inning TEXT,
  pitcher_hand TEXT CHECK(pitcher_hand IN ('L','R') OR pitcher_hand IS NULL),
  batter_side TEXT CHECK(batter_side IN ('L','R') OR batter_side IS NULL),
  pitch_type TEXT,
  pitch_name TEXT,
  release_speed REAL,
  effective_speed REAL,
  release_spin_rate REAL,
  plate_x REAL,
  plate_z REAL,
  zone INTEGER,
  description TEXT,
  event TEXT,
  is_swing INTEGER NOT NULL DEFAULT 0 CHECK(is_swing IN (0,1)),
  is_whiff INTEGER NOT NULL DEFAULT 0 CHECK(is_whiff IN (0,1)),
  is_called_strike INTEGER NOT NULL DEFAULT 0 CHECK(is_called_strike IN (0,1)),
  is_in_zone INTEGER CHECK(is_in_zone IN (0,1) OR is_in_zone IS NULL),
  is_chase INTEGER CHECK(is_chase IN (0,1) OR is_chase IS NULL),
  source_payload_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(game_pk, at_bat_number, pitch_number)
);

CREATE INDEX IF NOT EXISTS idx_statcast_pitch_events_pitcher_date
  ON statcast_pitch_events(pitcher_mlb_id, game_date);
CREATE INDEX IF NOT EXISTS idx_statcast_pitch_events_game
  ON statcast_pitch_events(game_pk, at_bat_number, pitch_number);

CREATE TABLE IF NOT EXISTS statcast_pitcher_game_metrics (
  statcast_pitcher_game_metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  pitcher_mlb_id INTEGER NOT NULL,
  pitches INTEGER NOT NULL DEFAULT 0,
  swings INTEGER NOT NULL DEFAULT 0,
  whiffs INTEGER NOT NULL DEFAULT 0,
  called_strikes INTEGER NOT NULL DEFAULT 0,
  csw_events INTEGER NOT NULL DEFAULT 0,
  zone_pitches INTEGER NOT NULL DEFAULT 0,
  out_of_zone_pitches INTEGER NOT NULL DEFAULT 0,
  chase_swings INTEGER NOT NULL DEFAULT 0,
  whiff_rate REAL,
  swinging_strike_rate REAL,
  csw_rate REAL,
  chase_rate REAL,
  avg_fastball_velocity REAL,
  max_fastball_velocity REAL,
  avg_fastball_spin REAL,
  pitch_mix_json TEXT NOT NULL DEFAULT '{}',
  quality_score INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(game_pk, pitcher_mlb_id)
);

CREATE INDEX IF NOT EXISTS idx_statcast_pitcher_game_metrics_pitcher_date
  ON statcast_pitcher_game_metrics(pitcher_mlb_id, game_date);

CREATE TABLE IF NOT EXISTS statcast_pitcher_daily_features (
  statcast_pitcher_daily_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_date TEXT NOT NULL,
  pitcher_mlb_id INTEGER NOT NULL,
  games_lookback INTEGER NOT NULL DEFAULT 0,
  pitches_lookback INTEGER NOT NULL DEFAULT 0,
  whiff_rate REAL,
  swinging_strike_rate REAL,
  csw_rate REAL,
  chase_rate REAL,
  avg_fastball_velocity REAL,
  velocity_delta_30d REAL,
  avg_fastball_spin REAL,
  hand_split_quality REAL,
  feature_quality_score INTEGER NOT NULL DEFAULT 0,
  source_complete_through TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(feature_date, pitcher_mlb_id)
);

CREATE INDEX IF NOT EXISTS idx_statcast_pitcher_daily_features_date
  ON statcast_pitcher_daily_features(feature_date, pitcher_mlb_id);

INSERT OR IGNORE INTO statcast_source_state(source_key,status)
VALUES ('STATCAST_PITCH_LEVEL','NEVER_SYNCED');

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES ('BUILD_7_1_INSTALLED','SYSTEM','{"release":"3.6","build":"7.1","feature":"Statcast data foundation: immutable pitch events, pitcher-game metrics, daily model feature store; ingestion not enabled yet"}');
