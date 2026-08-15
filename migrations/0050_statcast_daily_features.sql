PRAGMA foreign_keys = ON;

ALTER TABLE statcast_pitcher_daily_features ADD COLUMN games_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE statcast_pitcher_daily_features ADD COLUMN pitches_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE statcast_pitcher_daily_features ADD COLUMN last_game_date TEXT;
ALTER TABLE statcast_pitcher_daily_features ADD COLUMN recent_fastball_velocity REAL;
ALTER TABLE statcast_pitcher_daily_features ADD COLUMN baseline_fastball_velocity_30d REAL;
ALTER TABLE statcast_pitcher_daily_features ADD COLUMN pitch_mix_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_statcast_daily_pitcher_date
  ON statcast_pitcher_daily_features(pitcher_mlb_id, feature_date);

INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES ('BUILD_7_3_INSTALLED','SYSTEM','{"release":"3.6","build":"7.3","feature":"Anti-lookahead Statcast daily rolling features; research only"}');
