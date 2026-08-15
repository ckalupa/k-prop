PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mlb_batters (
  mlb_batter_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  bat_side TEXT CHECK (bat_side IN ('L','R','S') OR bat_side IS NULL),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_seen_team_mlb_id INTEGER,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mlb_batters_hand ON mlb_batters(bat_side);
CREATE INDEX IF NOT EXISTS idx_mlb_batters_team ON mlb_batters(last_seen_team_mlb_id);

CREATE TABLE IF NOT EXISTS game_lineup_snapshots (
  lineup_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  batting_team_mlb_id INTEGER NOT NULL,
  opponent_team_mlb_id INTEGER NOT NULL,
  opposing_probable_pitcher_mlb_id INTEGER,
  opposing_probable_pitcher_hand TEXT CHECK (opposing_probable_pitcher_hand IN ('L','R') OR opposing_probable_pitcher_hand IS NULL),
  lineup_status TEXT NOT NULL CHECK (lineup_status IN ('EXPECTED','CONFIRMED','UNAVAILABLE')),
  lineup_size INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  source_game_status TEXT,
  payload_hash TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, batting_team_mlb_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_lineup_snapshot_game_team_time
  ON game_lineup_snapshots(mlb_game_pk, batting_team_mlb_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_lineup_snapshot_date_status
  ON game_lineup_snapshots(official_date, lineup_status, captured_at DESC);

CREATE TABLE IF NOT EXISTS game_lineup_entries (
  lineup_entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineup_snapshot_id INTEGER NOT NULL,
  batting_slot INTEGER NOT NULL CHECK (batting_slot BETWEEN 1 AND 9),
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  bat_side TEXT CHECK (bat_side IN ('L','R','S') OR bat_side IS NULL),
  position_abbr TEXT,
  source_order_value TEXT,
  FOREIGN KEY (lineup_snapshot_id) REFERENCES game_lineup_snapshots(lineup_snapshot_id) ON DELETE CASCADE,
  UNIQUE (lineup_snapshot_id, batting_slot),
  UNIQUE (lineup_snapshot_id, mlb_batter_id)
);

CREATE INDEX IF NOT EXISTS idx_lineup_entries_batter ON game_lineup_entries(mlb_batter_id);

INSERT INTO data_source_status (
  source_name, dataset_name, status, expected_refresh_minutes,
  stale_after_minutes, status_message, updated_at
) VALUES (
  'MLB_STATS_API', 'LINEUP_SNAPSHOTS', 'NEVER_SYNCED', 15,
  45, 'Build 6.1 lineup foundation has not run yet.', CURRENT_TIMESTAMP
)
ON CONFLICT(source_name, dataset_name) DO UPDATE SET
  expected_refresh_minutes = excluded.expected_refresh_minutes,
  stale_after_minutes = excluded.stale_after_minutes,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO audit_events (event_type, entity_type, event_details)
VALUES (
  'BUILD_6_1_INSTALLED',
  'SYSTEM',
  '{"release":"3.5","build":"6.1","feature":"lineup data foundation and immutable daily lineup snapshots"}'
);
