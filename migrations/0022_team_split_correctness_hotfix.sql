PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_game_handedness_batting (
  team_game_handedness_batting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  batting_team_mlb_id INTEGER NOT NULL,
  opponent_team_mlb_id INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  walks INTEGER NOT NULL DEFAULT 0,
  source_name TEXT NOT NULL DEFAULT 'MLB_PLAY_BY_PLAY',
  sync_run_id INTEGER,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, batting_team_mlb_id, pitcher_hand)
);

CREATE INDEX IF NOT EXISTS idx_team_game_hand_batting_lookup
  ON team_game_handedness_batting(batting_team_mlb_id, official_date, pitcher_hand);

CREATE TABLE IF NOT EXISTS team_game_handedness_games (
  mlb_game_pk INTEGER PRIMARY KEY,
  official_date TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  sync_run_id INTEGER,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL
);

-- Build 2.3's byDateRange endpoint ignored sitCodes, producing false identical L/R rows.
-- Remove those derived daily rows so only corrected data can be consumed going forward.
DELETE FROM team_strikeout_splits_daily;

-- Remove only handedness rows that are provably invalid: both hands have the exact same
-- PA and K totals for the same team/season. Correct L/R splits cannot both equal the full-team totals.
DELETE FROM team_handedness_stats
WHERE source LIKE 'MLB Stats API%'
  AND EXISTS (
    SELECT 1
    FROM team_handedness_stats other
    WHERE other.team_id = team_handedness_stats.team_id
      AND other.season = team_handedness_stats.season
      AND other.pitcher_hand <> team_handedness_stats.pitcher_hand
      AND other.plate_appearances = team_handedness_stats.plate_appearances
      AND other.strikeouts = team_handedness_stats.strikeouts
  );

UPDATE data_source_status
SET status = 'NEVER_SYNCED',
    last_success_at = NULL,
    last_complete_through_at = NULL,
    record_count = 0,
    status_message = 'Build 2.3.1 reset invalid handedness rows; corrected sync pending.',
    metadata_json = '{"next_offset":0,"batch_size":2,"method":"season_statSplits_plus_recent_playByPlay"}',
    updated_at = CURRENT_TIMESTAMP
WHERE source_name = 'MLB_STATS_API'
  AND dataset_name = 'TEAM_STRIKEOUT_SPLITS';

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_2_3_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.1","build":"2.3.1","feature":"Correct team handedness split ingestion","reason":"byDateRange ignored sitCodes"}'
);
