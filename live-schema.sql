PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    abbreviation TEXT NOT NULL UNIQUE,
    full_name TEXT,
    league TEXT,
    division TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pitchers (
    pitcher_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    mlb_id INTEGER UNIQUE,
    throws_hand TEXT CHECK (throws_hand IN ('R', 'L')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, current_team TEXT);
CREATE TABLE pitcher_aliases (
    alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pitcher_id INTEGER NOT NULL,
    alias_name TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id)
);
CREATE TABLE model_versions (
    model_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, model_role TEXT NOT NULL DEFAULT 'ARCHIVED'
  CHECK (model_role IN ('PRODUCTION', 'CHALLENGER', 'ARCHIVED', 'DISABLED')), lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (lifecycle_status IN ('DRAFT', 'ACTIVE', 'RETIRED')), code_identifier TEXT, feature_schema_version TEXT, config_json TEXT, release_notes TEXT, activated_at TEXT, retired_at TEXT, updated_at TEXT, execution_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (execution_enabled IN (0, 1)), execution_priority INTEGER NOT NULL DEFAULT 100, shadow_source_model_version_id INTEGER, last_execution_at TEXT, last_execution_status TEXT
  CHECK (last_execution_status IS NULL OR last_execution_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'DISABLED')), last_execution_error TEXT);
CREATE TABLE boards (
    board_id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_date TEXT NOT NULL,
    board_name TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED')),
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE games (
    game_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mlb_game_pk INTEGER UNIQUE,
    game_date TEXT NOT NULL,
    away_team_id INTEGER,
    home_team_id INTEGER,
    scheduled_start TEXT,
    game_status TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, official_date TEXT, status_abstract TEXT, status_detailed TEXT, status_code TEXT, venue_name TEXT, day_night TEXT, doubleheader TEXT, game_number INTEGER, away_score INTEGER, home_score INTEGER, away_probable_pitcher_mlb_id INTEGER, away_probable_pitcher_name TEXT, away_probable_pitcher_hand TEXT, home_probable_pitcher_mlb_id INTEGER, home_probable_pitcher_name TEXT, home_probable_pitcher_hand TEXT, source_name TEXT NOT NULL DEFAULT 'LEGACY', first_seen_at TEXT, last_synced_at TEXT, source_updated_at TEXT,
    FOREIGN KEY (away_team_id) REFERENCES teams(team_id),
    FOREIGN KEY (home_team_id) REFERENCES teams(team_id)
);
CREATE TABLE props (
    prop_id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    game_id INTEGER,
    pitcher_id INTEGER NOT NULL,
    opponent_team_id INTEGER,
    strikeout_line REAL NOT NULL,
    available_side TEXT NOT NULL DEFAULT 'Both',
    prop_type TEXT NOT NULL DEFAULT 'Standard',
    source TEXT,
    source_row INTEGER,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(board_id),
    FOREIGN KEY (game_id) REFERENCES games(game_id),
    FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
    FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id)
);
CREATE TABLE pitcher_game_stats (
    pitcher_game_stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pitcher_id INTEGER NOT NULL,
    game_id INTEGER,
    game_date TEXT NOT NULL,
    opponent_team_id INTEGER,
    innings_pitched REAL,
    strikeouts INTEGER,
    batters_faced INTEGER,
    pitch_count INTEGER,
    earned_runs INTEGER,
    hits_allowed INTEGER,
    walks INTEGER,
    starter INTEGER NOT NULL DEFAULT 1 CHECK (starter IN (0, 1)),
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
    FOREIGN KEY (game_id) REFERENCES games(game_id),
    FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
    UNIQUE (pitcher_id, game_date)
);
CREATE TABLE feature_snapshots (
    feature_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    prop_id INTEGER NOT NULL,
    model_version_id INTEGER NOT NULL,
    snapshot_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_3_k_avg REAL,
    last_5_k_avg REAL,
    career_k_avg REAL,
    average_ip_last_3 REAL,
    projection_sd REAL,
    opponent_k_rate REAL,
    handedness_edge REAL,
    recent_form_gate TEXT,
    volume_gate TEXT,
    role_gate TEXT,
    health_gate TEXT,
    matchup_gate TEXT,
    data_freshness TEXT,
    source_quality TEXT, last_10_k_avg REAL, average_bf_last_5 REAL, average_pitch_count_last_5 REAL, starter_rate_last_10 REAL, form_delta_l3_l10 REAL, season_opponent_k_rate REAL, recent_30_k_rate REAL, recent_14_k_rate REAL, opponent_trend_delta REAL, opponent_sample_confidence TEXT, same_opponent_start_count INTEGER NOT NULL DEFAULT 0, same_opponent_k_avg REAL, same_opponent_bf_avg REAL, same_opponent_adjustment REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (prop_id) REFERENCES props(prop_id),
    FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id)
);
CREATE TABLE recommendations (
    recommendation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    prop_id INTEGER NOT NULL,
    model_version_id INTEGER NOT NULL,
    projected_strikeouts REAL,
    model_edge REAL,
    estimated_over_rate REAL,
    preferred_side TEXT,
    market_value_band TEXT,
    projection_status TEXT,
    confidence_score REAL,
    confidence_band TEXT,
    confidence_cap TEXT,
    core_block_count INTEGER,
    decision_tier TEXT,
    model_decision TEXT,
    final_decision TEXT,
    positive_factors TEXT,
    negative_factors TEXT,
    final_reason TEXT,
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, initial_classification TEXT, final_classification TEXT, final_card INTEGER NOT NULL DEFAULT 0 CHECK (final_card IN (0, 1)), actually_played INTEGER NOT NULL DEFAULT 0 CHECK (actually_played IN (0, 1)), opening_line REAL, recommended_line REAL, closing_line REAL, market_type TEXT, finalized_at TEXT, change_reason TEXT, completeness_score INTEGER CHECK (completeness_score BETWEEN 0 AND 100), starter_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (starter_confirmed IN (0, 1)), lineup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (lineup_confirmed IN (0, 1)), weather_checked INTEGER NOT NULL DEFAULT 0 CHECK (weather_checked IN (0, 1)), umpire_checked INTEGER NOT NULL DEFAULT 0 CHECK (umpire_checked IN (0, 1)), game_pk INTEGER, scheduled_first_pitch TEXT, last_pregame_checked_at TEXT, last_successful_refresh_at TEXT, pregame_check_status TEXT NOT NULL DEFAULT 'PENDING', pregame_check_message TEXT, recommendation_score REAL, recommendation_band TEXT, score_projection REAL, score_recent_form REAL, score_volume REAL, score_matchup REAL, score_role REAL, score_completeness REAL, score_explanation TEXT, base_projected_strikeouts REAL, matchup_projected_strikeouts REAL, same_opponent_adjustment REAL NOT NULL DEFAULT 0, calibration_adjustment REAL NOT NULL DEFAULT 0, calibration_sample_size INTEGER NOT NULL DEFAULT 0, calibration_hit_rate REAL,
    FOREIGN KEY (prop_id) REFERENCES props(prop_id),
    FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
    UNIQUE (prop_id, model_version_id)
);
CREATE TABLE prop_results (
    prop_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    prop_id INTEGER NOT NULL UNIQUE,
    actual_strikeouts INTEGER,
    result TEXT CHECK (result IN ('OVER', 'UNDER', 'PUSH', 'VOID')),
    result_status TEXT NOT NULL DEFAULT 'PENDING',
    source TEXT,
    graded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, innings_pitched REAL, pitch_count INTEGER, batters_faced INTEGER, starter INTEGER CHECK (starter IN (0, 1)), suggested_reason_code TEXT, postgame_reason_code TEXT, early_exit_reason TEXT, postgame_review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
  CHECK (postgame_review_status IN ('UNREVIEWED', 'REVIEWED', 'NOT_REQUIRED')),
    FOREIGN KEY (prop_id) REFERENCES props(prop_id)
);
CREATE TABLE audit_events (
    audit_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    event_details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, actor_email TEXT, actor_subject TEXT);
CREATE TABLE web_audit_events (
  web_audit_event_id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  event_details TEXT,
  actor_email TEXT,
  actor_subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE team_handedness_stats (
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
CREATE TABLE team_opponent_trends (
  trend_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days IN (14, 30)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  plate_appearances INTEGER NOT NULL,
  strikeouts INTEGER NOT NULL,
  strikeout_rate REAL NOT NULL,
  source TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, as_of_date, window_days),
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE TABLE automation_runs (
  automation_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER,
  run_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  games_checked INTEGER NOT NULL DEFAULT 0,
  props_matched INTEGER NOT NULL DEFAULT 0,
  starter_confirmed INTEGER NOT NULL DEFAULT 0,
  lineup_confirmed INTEGER NOT NULL DEFAULT 0,
  weather_checked INTEGER NOT NULL DEFAULT 0,
  umpire_checked INTEGER NOT NULL DEFAULT 0,
  stale_props INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  FOREIGN KEY (board_id) REFERENCES boards(board_id)
);
CREATE TABLE play_slips (
  slip_id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  entry_name TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('POWER', 'FLEX')),
  amount_wagered REAL NOT NULL CHECK (amount_wagered >= 0),
  full_hit_multiplier REAL NOT NULL CHECK (full_hit_multiplier >= 0),
  promo_label TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SETTLED', 'NEEDS_REVIEW')),
  eligible_legs INTEGER,
  hit_count INTEGER,
  loss_count INTEGER,
  push_count INTEGER,
  void_count INTEGER,
  actual_multiplier REAL,
  amount_returned REAL,
  net_profit REAL,
  settlement_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT, power_play_multiplier REAL, flex_play_multiplier REAL, boost_percentage REAL NOT NULL DEFAULT 0, base_actual_multiplier REAL,
  FOREIGN KEY (board_id) REFERENCES boards(board_id)
);
CREATE TABLE play_slip_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id INTEGER NOT NULL,
  eligible_legs INTEGER NOT NULL CHECK (eligible_legs >= 1),
  hits INTEGER NOT NULL CHECK (hits >= 0),
  multiplier REAL NOT NULL CHECK (multiplier >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slip_id) REFERENCES play_slips(slip_id) ON DELETE CASCADE,
  UNIQUE (slip_id, eligible_legs, hits)
);
CREATE TABLE play_slip_legs (
  leg_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  recommendation_id INTEGER,
  pitcher_name TEXT NOT NULL,
  opponent TEXT,
  strikeout_line REAL NOT NULL,
  preferred_side TEXT NOT NULL,
  prop_type TEXT,
  model_decision TEXT,
  confidence_score REAL,
  model_version TEXT,
  leg_result TEXT NOT NULL DEFAULT 'PENDING' CHECK (leg_result IN ('PENDING', 'WIN', 'LOSS', 'PUSH', 'VOID')),
  actual_strikeouts INTEGER,
  result_source TEXT,
  postgame_category TEXT,
  postgame_analysis TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (analysis_status IN ('PENDING', 'AUTO', 'REVIEWED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slip_id) REFERENCES play_slips(slip_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id),
  UNIQUE (slip_id, prop_id)
);
CREATE TABLE bankroll_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_date TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('STARTING_BALANCE', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT')),
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE play_audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id INTEGER,
  event_type TEXT NOT NULL,
  event_details TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slip_id) REFERENCES play_slips(slip_id) ON DELETE SET NULL
);
CREATE TABLE model_predictions (
  model_prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_uuid TEXT NOT NULL UNIQUE,
  prop_id INTEGER NOT NULL,
  model_version_id INTEGER NOT NULL,
  feature_snapshot_id INTEGER,
  prediction_mode TEXT NOT NULL DEFAULT 'PRODUCTION'
    CHECK (prediction_mode IN ('PRODUCTION', 'SHADOW', 'BACKTEST')),
  prediction_status TEXT NOT NULL DEFAULT 'COMPLETE'
    CHECK (prediction_status IN ('PENDING', 'COMPLETE', 'FAILED', 'WITHHELD')),
  predicted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  information_cutoff_at TEXT NOT NULL,
  prop_line REAL NOT NULL,
  projected_strikeouts REAL,
  raw_more_probability REAL CHECK (raw_more_probability IS NULL OR (raw_more_probability >= 0 AND raw_more_probability <= 1)),
  raw_less_probability REAL CHECK (raw_less_probability IS NULL OR (raw_less_probability >= 0 AND raw_less_probability <= 1)),
  calibrated_more_probability REAL CHECK (calibrated_more_probability IS NULL OR (calibrated_more_probability >= 0 AND calibrated_more_probability <= 1)),
  calibrated_less_probability REAL CHECK (calibrated_less_probability IS NULL OR (calibrated_less_probability >= 0 AND calibrated_less_probability <= 1)),
  preferred_side TEXT CHECK (preferred_side IS NULL OR preferred_side IN ('MORE', 'LESS', 'NONE')),
  model_edge REAL,
  decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  data_quality_status TEXT,
  source_fingerprint TEXT,
  input_hash TEXT,
  output_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, prop_feature_snapshot_id INTEGER REFERENCES prop_feature_snapshots(prop_feature_snapshot_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id)
);
CREATE TABLE model_feature_values (
  model_feature_value_id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_prediction_id INTEGER NOT NULL,
  feature_name TEXT NOT NULL,
  feature_group TEXT,
  value_type TEXT NOT NULL
    CHECK (value_type IN ('REAL', 'INTEGER', 'TEXT', 'BOOLEAN', 'JSON', 'NULL')),
  value_real REAL,
  value_integer INTEGER,
  value_text TEXT,
  value_json TEXT,
  source_name TEXT,
  source_record_key TEXT,
  source_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id) ON DELETE CASCADE,
  UNIQUE (model_prediction_id, feature_name)
);
CREATE TABLE sync_runs (
  sync_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  sync_mode TEXT NOT NULL DEFAULT 'INCREMENTAL'
    CHECK (sync_mode IN ('FULL', 'INCREMENTAL', 'BACKFILL', 'RETRY', 'MANUAL')),
  trigger_source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (trigger_source IN ('CRON', 'ADMIN', 'DEPLOY', 'API', 'MANUAL')),
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  source_cursor_start TEXT,
  source_cursor_end TEXT,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_unchanged INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  freshness_cutoff_at TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sync_errors (
  sync_error_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id INTEGER NOT NULL,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT NOT NULL,
  source_record_key TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0,
  payload_excerpt TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_note TEXT,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE CASCADE
);
CREATE TABLE data_source_status (
  data_source_status_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('HEALTHY', 'DELAYED', 'INCOMPLETE', 'FAILED', 'NEVER_SYNCED', 'DISABLED', 'UNKNOWN')),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_complete_through_at TEXT,
  last_sync_run_id INTEGER,
  expected_refresh_minutes INTEGER,
  stale_after_minutes INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER,
  status_message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (last_sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (source_name, dataset_name)
);
CREATE TABLE raw_mlb_schedule_snapshots (
  schedule_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, payload_hash)
);
CREATE TABLE raw_pitcher_game_logs (
  pitcher_game_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  mlb_pitcher_id INTEGER NOT NULL,
  pitcher_name TEXT NOT NULL,
  pitcher_id INTEGER,
  game_id INTEGER,
  game_date TEXT NOT NULL,
  team_abbreviation TEXT NOT NULL,
  opponent_abbreviation TEXT NOT NULL,
  home_away TEXT NOT NULL CHECK (home_away IN ('HOME','AWAY')),
  starter INTEGER NOT NULL DEFAULT 0 CHECK (starter IN (0,1)),
  decision_code TEXT,
  innings_pitched_text TEXT,
  outs_recorded INTEGER,
  strikeouts INTEGER,
  batters_faced INTEGER,
  pitch_count INTEGER,
  walks INTEGER,
  hits_allowed INTEGER,
  runs_allowed INTEGER,
  earned_runs INTEGER,
  home_runs_allowed INTEGER,
  strikes INTEGER,
  balls INTEGER,
  days_rest INTEGER,
  game_status TEXT,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  source_updated_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_run_id INTEGER,
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id) ON DELETE SET NULL,
  FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE SET NULL,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, mlb_pitcher_id)
);
CREATE TABLE raw_mlb_boxscore_snapshots (
  boxscore_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_game_pk INTEGER NOT NULL,
  game_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_game_pk, payload_hash)
);
CREATE TABLE team_strikeout_splits_daily (
  team_strikeout_split_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  mlb_team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  window_days INTEGER NOT NULL CHECK (window_days IN (0,7,14,30)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  plate_appearances INTEGER NOT NULL,
  strikeouts INTEGER NOT NULL,
  walks INTEGER,
  strikeout_rate REAL NOT NULL,
  walk_rate REAL,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_run_id INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (team_id, as_of_date, pitcher_hand, window_days)
);
CREATE TABLE team_game_handedness_batting (
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
CREATE TABLE team_game_handedness_games (
  mlb_game_pk INTEGER PRIMARY KEY,
  official_date TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  sync_run_id INTEGER,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL
);
CREATE TABLE pitcher_daily_features (
  pitcher_daily_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id INTEGER,
  mlb_pitcher_id INTEGER NOT NULL,
  pitcher_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  source_cutoff_date TEXT,
  season_starts INTEGER NOT NULL DEFAULT 0,
  last3_starts INTEGER NOT NULL DEFAULT 0,
  last5_starts INTEGER NOT NULL DEFAULT 0,
  last10_starts INTEGER NOT NULL DEFAULT 0,
  season_strikeouts INTEGER NOT NULL DEFAULT 0,
  season_batters_faced INTEGER NOT NULL DEFAULT 0,
  season_outs_recorded INTEGER NOT NULL DEFAULT 0,
  season_pitch_count INTEGER NOT NULL DEFAULT 0,
  season_k_per_bf REAL,
  season_k_per_inning REAL,
  season_avg_strikeouts REAL,
  season_avg_batters_faced REAL,
  season_avg_innings REAL,
  season_avg_pitch_count REAL,
  last3_k_per_bf REAL,
  last3_avg_strikeouts REAL,
  last3_avg_batters_faced REAL,
  last3_avg_innings REAL,
  last3_avg_pitch_count REAL,
  last5_k_per_bf REAL,
  last5_avg_strikeouts REAL,
  last5_avg_batters_faced REAL,
  last5_avg_innings REAL,
  last5_avg_pitch_count REAL,
  last10_k_per_bf REAL,
  last10_avg_strikeouts REAL,
  last10_avg_batters_faced REAL,
  last10_avg_innings REAL,
  last10_avg_pitch_count REAL,
  home_k_per_bf REAL,
  away_k_per_bf REAL,
  days_since_last_start INTEGER,
  last_start_date TEXT,
  pitch_count_trend_3v3 REAL,
  innings_trend_3v3 REAL,
  strikeout_trend_3v3 REAL,
  recent5_vs_season_k_per_bf REAL,
  data_quality_score INTEGER NOT NULL DEFAULT 0 CHECK (data_quality_score BETWEEN 0 AND 100),
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'pitcher-daily-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id) ON DELETE SET NULL,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_pitcher_id, as_of_date, feature_version)
);
CREATE TABLE team_daily_features (
  team_daily_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  mlb_team_id INTEGER NOT NULL,
  team_abbr TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  source_cutoff_date TEXT NOT NULL,
  season_plate_appearances INTEGER NOT NULL DEFAULT 0,
  season_strikeouts INTEGER NOT NULL DEFAULT 0,
  season_k_rate REAL,
  last30_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last30_strikeouts INTEGER NOT NULL DEFAULT 0,
  last30_k_rate REAL,
  last14_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last14_strikeouts INTEGER NOT NULL DEFAULT 0,
  last14_k_rate REAL,
  last7_plate_appearances INTEGER NOT NULL DEFAULT 0,
  last7_strikeouts INTEGER NOT NULL DEFAULT 0,
  last7_k_rate REAL,
  weighted_recent_k_rate REAL,
  recent_vs_season_delta REAL,
  last7_vs_last30_delta REAL,
  trend_direction TEXT NOT NULL DEFAULT 'FLAT' CHECK (trend_direction IN ('UP','DOWN','FLAT')),
  stability_status TEXT NOT NULL DEFAULT 'LOW' CHECK (stability_status IN ('HIGH','MEDIUM','LOW')),
  sample_size_score INTEGER NOT NULL DEFAULT 0 CHECK (sample_size_score BETWEEN 0 AND 100),
  data_quality_score INTEGER NOT NULL DEFAULT 0 CHECK (data_quality_score BETWEEN 0 AND 100),
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_sync_run_ids_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'team-daily-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (team_id, as_of_date, pitcher_hand, feature_version)
);
CREATE TABLE prop_feature_snapshots (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, overall_data_quality_score INTEGER CHECK (overall_data_quality_score BETWEEN 0 AND 100), data_quality_grade TEXT CHECK (data_quality_grade IN ('A','B','C','D','F')), quality_gate TEXT CHECK (quality_gate IN ('PASS','CAUTION','BLOCK')), challenger_eligible INTEGER NOT NULL DEFAULT 0 CHECK (challenger_eligible IN (0,1)), quality_flags_json TEXT NOT NULL DEFAULT '[]', critical_quality_flags_json TEXT NOT NULL DEFAULT '[]', quality_policy_version TEXT NOT NULL DEFAULT 'prop-quality-v1-backfill',
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (pitcher_daily_feature_id) REFERENCES pitcher_daily_features(pitcher_daily_feature_id),
  FOREIGN KEY (team_daily_feature_id) REFERENCES team_daily_features(team_daily_feature_id),
  FOREIGN KEY (legacy_feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id)
);
CREATE TABLE backtest_dataset_builds (
  backtest_dataset_build_id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_uuid TEXT NOT NULL UNIQUE,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  source_snapshot_count INTEGER NOT NULL DEFAULT 0,
  dataset_row_count INTEGER NOT NULL DEFAULT 0,
  eligible_row_count INTEGER NOT NULL DEFAULT 0,
  excluded_row_count INTEGER NOT NULL DEFAULT 0,
  push_count INTEGER NOT NULL DEFAULT 0,
  void_count INTEGER NOT NULL DEFAULT 0,
  board_date_min TEXT,
  board_date_max TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
, dataset_mode TEXT NOT NULL DEFAULT 'STRICT'
  CHECK (dataset_mode IN ('STRICT','CERTIFIED','EXPANDED')));
CREATE TABLE backtest_dataset_rows (
  backtest_dataset_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_dataset_build_id INTEGER NOT NULL,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v1',
  prop_feature_snapshot_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  model_version_id INTEGER NOT NULL,
  model_prediction_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  captured_at TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  pitcher_source_cutoff_date TEXT,
  team_source_cutoff_date TEXT,
  snapshot_status TEXT NOT NULL,
  overall_data_quality_score INTEGER,
  data_quality_grade TEXT,
  quality_gate TEXT,
  challenger_eligible INTEGER NOT NULL DEFAULT 0,
  projected_strikeouts REAL,
  raw_more_probability REAL,
  raw_less_probability REAL,
  calibrated_more_probability REAL,
  calibrated_less_probability REAL,
  preferred_side TEXT,
  model_edge REAL,
  model_decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  innings_pitched REAL,
  pitch_count INTEGER,
  batters_faced INTEGER,
  starter INTEGER,
  more_outcome TEXT CHECK (more_outcome IS NULL OR more_outcome IN ('WIN','LOSS','PUSH','VOID')),
  less_outcome TEXT CHECK (less_outcome IS NULL OR less_outcome IN ('WIN','LOSS','PUSH','VOID')),
  preferred_outcome TEXT CHECK (preferred_outcome IS NULL OR preferred_outcome IN ('WIN','LOSS','PUSH','VOID','NONE')),
  feature_cutoff_status TEXT NOT NULL CHECK (feature_cutoff_status IN ('PASS','UNKNOWN','FAIL')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('CERTIFIED','EXCLUDED')),
  exclusion_reason TEXT,
  backtest_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backtest_eligible IN (0,1)),
  pitcher_features_json TEXT,
  team_features_json TEXT,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  critical_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_feature_snapshot_id) REFERENCES prop_feature_snapshots(prop_feature_snapshot_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (backtest_dataset_build_id, prop_id, model_version_id)
);
CREATE TABLE backtest_runs (
  backtest_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  engine_version TEXT NOT NULL DEFAULT 'walk-forward-v1',
  backtest_dataset_build_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  min_train_dates INTEGER NOT NULL DEFAULT 5,
  min_train_rows INTEGER NOT NULL DEFAULT 50,
  test_window_days INTEGER NOT NULL DEFAULT 1,
  eligible_row_count INTEGER NOT NULL DEFAULT 0,
  distinct_test_dates INTEGER NOT NULL DEFAULT 0,
  fold_count INTEGER NOT NULL DEFAULT 0,
  executed_fold_count INTEGER NOT NULL DEFAULT 0,
  skipped_fold_count INTEGER NOT NULL DEFAULT 0,
  train_date_min TEXT,
  train_date_max TEXT,
  test_date_min TEXT,
  test_date_max TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);
CREATE TABLE backtest_folds (
  backtest_fold_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL,
  fold_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('EXECUTED','SKIPPED')),
  skip_reason TEXT,
  train_date_min TEXT,
  train_date_max TEXT,
  test_date_min TEXT NOT NULL,
  test_date_max TEXT NOT NULL,
  train_distinct_dates INTEGER NOT NULL DEFAULT 0,
  train_row_count INTEGER NOT NULL DEFAULT 0,
  test_row_count INTEGER NOT NULL DEFAULT 0,
  no_future_overlap INTEGER NOT NULL DEFAULT 1 CHECK (no_future_overlap IN (0,1)),
  preferred_wins INTEGER NOT NULL DEFAULT 0,
  preferred_losses INTEGER NOT NULL DEFAULT 0,
  preferred_pushes INTEGER NOT NULL DEFAULT 0,
  preferred_hit_rate REAL,
  brier_score REAL,
  average_preferred_probability REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_run_id) REFERENCES backtest_runs(backtest_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_run_id, fold_index)
);
CREATE TABLE backtest_fold_rows (
  backtest_fold_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_fold_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN','TEST')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_fold_id) REFERENCES backtest_folds(backtest_fold_id) ON DELETE CASCADE,
  FOREIGN KEY (backtest_dataset_row_id) REFERENCES backtest_dataset_rows(backtest_dataset_row_id),
  UNIQUE (backtest_fold_id, backtest_dataset_row_id, partition)
);
CREATE TABLE backtest_performance_runs (
  backtest_performance_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  metrics_version TEXT NOT NULL DEFAULT 'performance-metrics-v1',
  backtest_run_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (trigger_source IN ('ADMIN','API','CRON','DEPLOY')),
  evaluated_row_count INTEGER NOT NULL DEFAULT 0,
  graded_row_count INTEGER NOT NULL DEFAULT 0,
  qualified_play_count INTEGER NOT NULL DEFAULT 0,
  distinct_test_dates INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  brier_score REAL,
  calibration_error REAL,
  more_hit_rate REAL,
  less_hit_rate REAL,
  average_predicted_probability REAL,
  picks_per_day REAL,
  qualified_plays_per_day REAL,
  max_drawdown_units REAL,
  longest_losing_streak INTEGER NOT NULL DEFAULT 0,
  power_roi REAL,
  flex_roi REAL,
  power_entries INTEGER NOT NULL DEFAULT 0,
  flex_entries INTEGER NOT NULL DEFAULT 0,
  simulation_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (backtest_run_id) REFERENCES backtest_runs(backtest_run_id) ON DELETE CASCADE
);
CREATE TABLE backtest_performance_windows (
  backtest_performance_window_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_performance_run_id INTEGER NOT NULL,
  window_name TEXT NOT NULL CHECK (window_name IN ('ALL','7D','14D','30D')),
  date_min TEXT,
  date_max TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  graded_count INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  brier_score REAL,
  calibration_error REAL,
  more_wins INTEGER NOT NULL DEFAULT 0,
  more_losses INTEGER NOT NULL DEFAULT 0,
  more_pushes INTEGER NOT NULL DEFAULT 0,
  more_hit_rate REAL,
  less_wins INTEGER NOT NULL DEFAULT 0,
  less_losses INTEGER NOT NULL DEFAULT 0,
  less_pushes INTEGER NOT NULL DEFAULT 0,
  less_hit_rate REAL,
  avg_predicted_probability REAL,
  qualified_play_count INTEGER NOT NULL DEFAULT 0,
  picks_per_day REAL,
  qualified_plays_per_day REAL,
  max_drawdown_units REAL,
  longest_losing_streak INTEGER NOT NULL DEFAULT 0,
  power_roi REAL,
  flex_roi REAL,
  power_entries INTEGER NOT NULL DEFAULT 0,
  flex_entries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_performance_run_id) REFERENCES backtest_performance_runs(backtest_performance_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_performance_run_id, window_name)
);
CREATE TABLE backtest_calibration_bins (
  backtest_calibration_bin_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_performance_run_id INTEGER NOT NULL,
  window_name TEXT NOT NULL CHECK (window_name IN ('ALL','7D','14D','30D')),
  bucket_index INTEGER NOT NULL,
  probability_min REAL NOT NULL,
  probability_max REAL NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  average_predicted_probability REAL,
  observed_win_rate REAL,
  absolute_calibration_error REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_performance_run_id) REFERENCES backtest_performance_runs(backtest_performance_run_id) ON DELETE CASCADE,
  UNIQUE (backtest_performance_run_id, window_name, bucket_index)
);
CREATE TABLE historical_feature_reconstruction_runs (
  reconstruction_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cursor_start_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  candidate_a_count INTEGER NOT NULL DEFAULT 0,
  candidate_b_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE historical_feature_reconstructions (
  historical_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconstruction_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-reconstruction-v1',
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  model_version_id INTEGER,
  recommendation_id INTEGER,
  legacy_feature_snapshot_id INTEGER,
  prop_result_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  recommendation_generated_at TEXT,
  legacy_snapshot_time TEXT,
  latest_pitcher_game_date TEXT,
  pitcher_starts_before_board INTEGER NOT NULL DEFAULT 0,
  pitcher_last5_complete INTEGER NOT NULL DEFAULT 0 CHECK (pitcher_last5_complete IN (0,1)),
  opponent_context_available INTEGER NOT NULL DEFAULT 0 CHECK (opponent_context_available IN (0,1)),
  result_available INTEGER NOT NULL DEFAULT 0 CHECK (result_available IN (0,1)),
  model_output_available INTEGER NOT NULL DEFAULT 0 CHECK (model_output_available IN (0,1)),
  reconstruction_class TEXT NOT NULL CHECK (reconstruction_class IN ('RECONSTRUCTED_A_CANDIDATE','RECONSTRUCTED_B_CANDIDATE','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  blocking_reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  pitcher_features_json TEXT,
  opponent_features_json TEXT,
  model_output_json TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reconstruction_run_id) REFERENCES historical_feature_reconstruction_runs(reconstruction_run_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id),
  FOREIGN KEY (legacy_feature_snapshot_id) REFERENCES feature_snapshots(feature_snapshot_id),
  FOREIGN KEY (prop_result_id) REFERENCES prop_results(prop_result_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (reconstruction_run_id, prop_id)
);
CREATE TABLE historical_feature_certification_runs (
  certification_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  certification_version TEXT NOT NULL DEFAULT 'backfill-certification-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  reconstructed_a_count INTEGER NOT NULL DEFAULT 0,
  reconstructed_b_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE historical_feature_certifications (
  historical_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  certification_run_id INTEGER NOT NULL,
  certification_version TEXT NOT NULL DEFAULT 'backfill-certification-v1',
  historical_reconstruction_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  certification_class TEXT NOT NULL CHECK (certification_class IN ('RECONSTRUCTED_A','RECONSTRUCTED_B','INCOMPLETE')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('CERTIFIED','EXCLUDED')),
  strict_eligible INTEGER NOT NULL DEFAULT 0 CHECK (strict_eligible IN (0,1)),
  certified_eligible INTEGER NOT NULL DEFAULT 0 CHECK (certified_eligible IN (0,1)),
  expanded_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_eligible IN (0,1)),
  certification_score INTEGER NOT NULL DEFAULT 0 CHECK (certification_score BETWEEN 0 AND 100),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, information_cutoff_at TEXT, cutoff_source TEXT, certified_feature_snapshot_id INTEGER, certified_recommendation_id INTEGER, certified_model_version_id INTEGER, certified_opponent_features_json TEXT, certified_model_output_json TEXT, source_timing_status TEXT,
  FOREIGN KEY (certification_run_id) REFERENCES historical_feature_certification_runs(certification_run_id) ON DELETE CASCADE,
  FOREIGN KEY (historical_reconstruction_id) REFERENCES historical_feature_reconstructions(historical_reconstruction_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  UNIQUE (certification_run_id, historical_reconstruction_id)
);
CREATE TABLE backtest_dataset_rows_v2 (
  backtest_dataset_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_dataset_build_id INTEGER NOT NULL,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v2',
  source_provenance TEXT NOT NULL DEFAULT 'NATIVE' CHECK (source_provenance IN ('NATIVE','RECONSTRUCTED_A','RECONSTRUCTED_B')),
  prop_feature_snapshot_id INTEGER,
  historical_reconstruction_id INTEGER,
  historical_certification_id INTEGER,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  model_version_id INTEGER NOT NULL,
  model_prediction_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  captured_at TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  pitcher_source_cutoff_date TEXT,
  team_source_cutoff_date TEXT,
  snapshot_status TEXT NOT NULL,
  overall_data_quality_score INTEGER,
  data_quality_grade TEXT,
  quality_gate TEXT,
  challenger_eligible INTEGER NOT NULL DEFAULT 0,
  projected_strikeouts REAL,
  raw_more_probability REAL,
  raw_less_probability REAL,
  calibrated_more_probability REAL,
  calibrated_less_probability REAL,
  preferred_side TEXT,
  model_edge REAL,
  model_decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  innings_pitched REAL,
  pitch_count INTEGER,
  batters_faced INTEGER,
  starter INTEGER,
  more_outcome TEXT CHECK (more_outcome IS NULL OR more_outcome IN ('WIN','LOSS','PUSH','VOID')),
  less_outcome TEXT CHECK (less_outcome IS NULL OR less_outcome IN ('WIN','LOSS','PUSH','VOID')),
  preferred_outcome TEXT CHECK (preferred_outcome IS NULL OR preferred_outcome IN ('WIN','LOSS','PUSH','VOID','NONE')),
  feature_cutoff_status TEXT NOT NULL CHECK (feature_cutoff_status IN ('PASS','UNKNOWN','FAIL')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('CERTIFIED','EXCLUDED')),
  exclusion_reason TEXT,
  backtest_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backtest_eligible IN (0,1)),
  pitcher_features_json TEXT,
  team_features_json TEXT,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  critical_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_feature_snapshot_id) REFERENCES prop_feature_snapshots(prop_feature_snapshot_id),
  FOREIGN KEY (historical_reconstruction_id) REFERENCES historical_feature_reconstructions(historical_reconstruction_id),
  FOREIGN KEY (historical_certification_id) REFERENCES historical_feature_certifications(historical_certification_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY (model_prediction_id) REFERENCES model_predictions(model_prediction_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  CHECK ((source_provenance='NATIVE' AND prop_feature_snapshot_id IS NOT NULL AND historical_reconstruction_id IS NULL)
      OR (source_provenance<>'NATIVE' AND prop_feature_snapshot_id IS NULL AND historical_reconstruction_id IS NOT NULL)),
  UNIQUE (backtest_dataset_build_id, prop_id, model_version_id)
);
CREATE TABLE backtest_fold_rows_v2 (
  backtest_fold_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_fold_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN','TEST')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (backtest_fold_id) REFERENCES backtest_folds(backtest_fold_id) ON DELETE CASCADE,
  FOREIGN KEY (backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v2(backtest_dataset_row_id),
  UNIQUE (backtest_fold_id, backtest_dataset_row_id, partition)
);
CREATE TABLE independent_historical_reconstruction_runs (
  independent_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'independent-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cursor_start_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  research_ready_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE independent_historical_reconstructions (
  independent_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  independent_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'independent-reconstruction-v1',
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  game_id INTEGER,
  information_cutoff_at TEXT,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  available_side TEXT,
  prop_type TEXT,
  prior_start_count INTEGER NOT NULL DEFAULT 0,
  last_start_date TEXT,
  last3_k_avg REAL,
  last5_k_avg REAL,
  last10_k_avg REAL,
  last5_k_per_bf REAL,
  last5_avg_bf REAL,
  last5_avg_ip REAL,
  last5_avg_pitch_count REAL,
  form_delta_l3_l10 REAL,
  same_opponent_start_count INTEGER NOT NULL DEFAULT 0,
  same_opponent_k_avg REAL,
  same_opponent_adjustment REAL NOT NULL DEFAULT 0,
  baseline_projection REAL,
  reconstructed_projection REAL,
  reconstructed_edge REAL,
  reconstructed_over_probability REAL,
  reconstructed_preferred_side TEXT,
  reconstruction_status TEXT NOT NULL CHECK (reconstruction_status IN ('RESEARCH_READY','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  expanded_research_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_research_eligible IN (0,1)),
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  feature_json TEXT NOT NULL DEFAULT '{}',
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (independent_run_id) REFERENCES independent_historical_reconstruction_runs(independent_run_id) ON DELETE CASCADE,
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (game_id) REFERENCES games(game_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (independent_run_id, prop_id)
);
CREATE TABLE historical_opponent_reconstruction_runs (
  opponent_reconstruction_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-opponent-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cursor_start_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  research_ready_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  games_checked INTEGER NOT NULL DEFAULT 0,
  games_fetched INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE historical_opponent_reconstructions (
  historical_opponent_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  opponent_reconstruction_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'historical-opponent-reconstruction-v1',
  independent_reconstruction_id INTEGER NOT NULL,
  prop_id INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  information_cutoff_at TEXT,
  opponent_team_id INTEGER NOT NULL,
  opponent_mlb_team_id INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL,
  window_7_pa INTEGER NOT NULL DEFAULT 0,
  window_7_k INTEGER NOT NULL DEFAULT 0,
  window_7_k_rate REAL,
  window_14_pa INTEGER NOT NULL DEFAULT 0,
  window_14_k INTEGER NOT NULL DEFAULT 0,
  window_14_k_rate REAL,
  window_30_pa INTEGER NOT NULL DEFAULT 0,
  window_30_k INTEGER NOT NULL DEFAULT 0,
  window_30_k_rate REAL,
  weighted_recent_k_rate REAL,
  recent_trend_delta REAL,
  league_baseline_k_rate REAL NOT NULL DEFAULT 0.225,
  handedness_edge REAL,
  sample_confidence TEXT,
  matchup_multiplier REAL,
  pitcher_only_projection REAL,
  opponent_adjusted_projection REAL,
  opponent_adjusted_edge REAL,
  opponent_adjusted_over_probability REAL,
  opponent_adjusted_preferred_side TEXT,
  reconstruction_status TEXT NOT NULL CHECK (reconstruction_status IN ('RESEARCH_READY','INCOMPLETE')),
  reconstruction_score INTEGER NOT NULL DEFAULT 0 CHECK (reconstruction_score BETWEEN 0 AND 100),
  expanded_research_eligible INTEGER NOT NULL DEFAULT 0 CHECK (expanded_research_eligible IN (0,1)),
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  feature_json TEXT NOT NULL DEFAULT '{}',
  actual_strikeouts INTEGER,
  market_result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (opponent_reconstruction_run_id) REFERENCES historical_opponent_reconstruction_runs(opponent_reconstruction_run_id) ON DELETE CASCADE,
  FOREIGN KEY (independent_reconstruction_id) REFERENCES independent_historical_reconstructions(independent_reconstruction_id),
  FOREIGN KEY (prop_id) REFERENCES props(prop_id),
  FOREIGN KEY (board_id) REFERENCES boards(board_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
  UNIQUE (opponent_reconstruction_run_id, prop_id)
);
CREATE TABLE historical_archive_props (
  historical_archive_prop_id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_version TEXT NOT NULL DEFAULT 'historical-archive-v1',
  board_date TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  team_abbreviation TEXT NOT NULL,
  opponent_abbreviation TEXT NOT NULL,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  original_side TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT NOT NULL,
  source_workbook TEXT NOT NULL,
  source_url TEXT,
  source_quality TEXT NOT NULL DEFAULT 'ARCHIVED_TRACKER',
  eligible_for_reconstruction INTEGER NOT NULL DEFAULT 1 CHECK (eligible_for_reconstruction IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(board_date,pitcher_name,team_abbreviation,opponent_abbreviation,prop_line)
);
CREATE TABLE archive_historical_reconstruction_runs (
  archive_reconstruction_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  reconstruction_version TEXT NOT NULL DEFAULT 'archive-reconstruction-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING',
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  cursor_start_archive_prop_id INTEGER NOT NULL DEFAULT 0,
  cursor_end_archive_prop_id INTEGER NOT NULL DEFAULT 0,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  research_ready_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  games_checked INTEGER NOT NULL DEFAULT 0,
  games_fetched INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE archive_historical_reconstructions (
  archive_historical_reconstruction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_reconstruction_run_id INTEGER NOT NULL,
  reconstruction_version TEXT NOT NULL DEFAULT 'archive-reconstruction-v1',
  historical_archive_prop_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  pitcher_id INTEGER,
  opponent_team_id INTEGER,
  opponent_mlb_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  prior_start_count INTEGER NOT NULL DEFAULT 0,
  last_start_date TEXT,
  last3_k_avg REAL,
  last5_k_avg REAL,
  last10_k_avg REAL,
  last5_k_per_bf REAL,
  last5_avg_bf REAL,
  last5_avg_ip REAL,
  last5_avg_pitch_count REAL,
  form_delta_l3_l10 REAL,
  baseline_projection REAL,
  window_7_pa INTEGER NOT NULL DEFAULT 0,
  window_7_k INTEGER NOT NULL DEFAULT 0,
  window_7_k_rate REAL,
  window_14_pa INTEGER NOT NULL DEFAULT 0,
  window_14_k INTEGER NOT NULL DEFAULT 0,
  window_14_k_rate REAL,
  window_30_pa INTEGER NOT NULL DEFAULT 0,
  window_30_k INTEGER NOT NULL DEFAULT 0,
  window_30_k_rate REAL,
  weighted_recent_k_rate REAL,
  sample_confidence TEXT NOT NULL DEFAULT 'NONE',
  matchup_multiplier REAL,
  reconstructed_projection REAL,
  reconstructed_edge REAL,
  reconstructed_over_probability REAL,
  reconstructed_preferred_side TEXT,
  reconstruction_status TEXT NOT NULL,
  reconstruction_score INTEGER NOT NULL DEFAULT 0,
  missing_features_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  feature_json TEXT NOT NULL DEFAULT '{}',
  actual_strikeouts INTEGER,
  market_result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (archive_reconstruction_run_id) REFERENCES archive_historical_reconstruction_runs(archive_reconstruction_run_id),
  FOREIGN KEY (historical_archive_prop_id) REFERENCES historical_archive_props(historical_archive_prop_id),
  FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id)
);
CREATE TABLE archive_historical_certification_runs (
  archive_certification_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  certification_version TEXT NOT NULL DEFAULT 'archive-certification-v1',
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  archive_a_count INTEGER NOT NULL DEFAULT 0,
  archive_b_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE archive_historical_certifications (
  archive_historical_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_certification_run_id INTEGER NOT NULL,
  certification_version TEXT NOT NULL DEFAULT 'archive-certification-v1',
  archive_historical_reconstruction_id INTEGER NOT NULL,
  historical_archive_prop_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  certification_class TEXT NOT NULL CHECK(certification_class IN ('ARCHIVE_RECONSTRUCTED_A','ARCHIVE_RECONSTRUCTED_B','INCOMPLETE')),
  certification_status TEXT NOT NULL CHECK(certification_status IN ('CERTIFIED','EXCLUDED')),
  certified_eligible INTEGER NOT NULL DEFAULT 0 CHECK(certified_eligible IN (0,1)),
  expanded_eligible INTEGER NOT NULL DEFAULT 0 CHECK(expanded_eligible IN (0,1)),
  certification_score INTEGER NOT NULL DEFAULT 0 CHECK(certification_score BETWEEN 0 AND 100),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  information_cutoff_at TEXT,
  certified_model_version_id INTEGER,
  certified_model_output_json TEXT NOT NULL DEFAULT '{}',
  source_timing_status TEXT NOT NULL DEFAULT 'PREGAME_RECONSTRUCTED',
  certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(archive_certification_run_id) REFERENCES archive_historical_certification_runs(archive_certification_run_id) ON DELETE CASCADE,
  FOREIGN KEY(archive_historical_reconstruction_id) REFERENCES archive_historical_reconstructions(archive_historical_reconstruction_id),
  FOREIGN KEY(historical_archive_prop_id) REFERENCES historical_archive_props(historical_archive_prop_id),
  FOREIGN KEY(certified_model_version_id) REFERENCES model_versions(model_version_id),
  UNIQUE(archive_certification_run_id,archive_historical_reconstruction_id)
);
CREATE TABLE backtest_dataset_rows_v3 (
  backtest_dataset_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_dataset_build_id INTEGER NOT NULL,
  dataset_version TEXT NOT NULL DEFAULT 'historical-dataset-v3',
  source_provenance TEXT NOT NULL CHECK(source_provenance IN ('NATIVE','RECONSTRUCTED_A','RECONSTRUCTED_B','ARCHIVE_RECONSTRUCTED_A','ARCHIVE_RECONSTRUCTED_B')),
  prop_feature_snapshot_id INTEGER,
  historical_reconstruction_id INTEGER,
  historical_certification_id INTEGER,
  archive_historical_reconstruction_id INTEGER,
  archive_certification_id INTEGER,
  historical_archive_prop_id INTEGER,
  prop_id INTEGER,
  board_id INTEGER,
  board_date TEXT NOT NULL,
  model_version_id INTEGER NOT NULL,
  model_prediction_id INTEGER,
  pitcher_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  captured_at TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  pitcher_source_cutoff_date TEXT,
  team_source_cutoff_date TEXT,
  snapshot_status TEXT NOT NULL,
  overall_data_quality_score INTEGER,
  data_quality_grade TEXT,
  quality_gate TEXT,
  challenger_eligible INTEGER NOT NULL DEFAULT 0,
  projected_strikeouts REAL,
  raw_more_probability REAL,
  raw_less_probability REAL,
  calibrated_more_probability REAL,
  calibrated_less_probability REAL,
  preferred_side TEXT,
  model_edge REAL,
  model_decision TEXT,
  confidence_score REAL,
  confidence_label TEXT,
  actual_strikeouts INTEGER,
  market_result TEXT,
  graded_at TEXT,
  innings_pitched REAL,
  pitch_count INTEGER,
  batters_faced INTEGER,
  starter INTEGER,
  more_outcome TEXT CHECK(more_outcome IS NULL OR more_outcome IN ('WIN','LOSS','PUSH','VOID')),
  less_outcome TEXT CHECK(less_outcome IS NULL OR less_outcome IN ('WIN','LOSS','PUSH','VOID')),
  preferred_outcome TEXT CHECK(preferred_outcome IS NULL OR preferred_outcome IN ('WIN','LOSS','PUSH','VOID','NONE')),
  feature_cutoff_status TEXT NOT NULL CHECK(feature_cutoff_status IN ('PASS','UNKNOWN','FAIL')),
  certification_status TEXT NOT NULL CHECK(certification_status IN ('CERTIFIED','EXCLUDED')),
  exclusion_reason TEXT,
  backtest_eligible INTEGER NOT NULL DEFAULT 0 CHECK(backtest_eligible IN (0,1)),
  pitcher_features_json TEXT,
  team_features_json TEXT,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  critical_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id) ON DELETE CASCADE,
  FOREIGN KEY(prop_feature_snapshot_id) REFERENCES prop_feature_snapshots(prop_feature_snapshot_id),
  FOREIGN KEY(historical_reconstruction_id) REFERENCES historical_feature_reconstructions(historical_reconstruction_id),
  FOREIGN KEY(historical_certification_id) REFERENCES historical_feature_certifications(historical_certification_id),
  FOREIGN KEY(archive_historical_reconstruction_id) REFERENCES archive_historical_reconstructions(archive_historical_reconstruction_id),
  FOREIGN KEY(archive_certification_id) REFERENCES archive_historical_certifications(archive_historical_certification_id),
  FOREIGN KEY(historical_archive_prop_id) REFERENCES historical_archive_props(historical_archive_prop_id),
  FOREIGN KEY(prop_id) REFERENCES props(prop_id),
  FOREIGN KEY(board_id) REFERENCES boards(board_id),
  FOREIGN KEY(model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(model_prediction_id) REFERENCES model_predictions(model_prediction_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  FOREIGN KEY(opponent_team_id) REFERENCES teams(team_id),
  CHECK(
    (source_provenance='NATIVE' AND prop_feature_snapshot_id IS NOT NULL AND historical_reconstruction_id IS NULL AND archive_historical_reconstruction_id IS NULL AND historical_archive_prop_id IS NULL)
    OR (source_provenance IN ('RECONSTRUCTED_A','RECONSTRUCTED_B') AND prop_feature_snapshot_id IS NULL AND historical_reconstruction_id IS NOT NULL AND archive_historical_reconstruction_id IS NULL)
    OR (source_provenance IN ('ARCHIVE_RECONSTRUCTED_A','ARCHIVE_RECONSTRUCTED_B') AND prop_feature_snapshot_id IS NULL AND historical_reconstruction_id IS NULL AND archive_historical_reconstruction_id IS NOT NULL AND historical_archive_prop_id IS NOT NULL)
  )
);
CREATE TABLE backtest_fold_rows_v3 (
  backtest_fold_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_fold_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK(partition IN ('TRAIN','TEST')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(backtest_fold_id) REFERENCES backtest_folds(backtest_fold_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  UNIQUE(backtest_fold_id,backtest_dataset_row_id,partition)
);
CREATE TABLE mlb_batters (
  mlb_batter_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  bat_side TEXT CHECK (bat_side IN ('L','R','S') OR bat_side IS NULL),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_seen_team_mlb_id INTEGER,
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE game_lineup_snapshots (
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
CREATE TABLE game_lineup_entries (
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
CREATE TABLE batter_k_profiles_daily (
  batter_k_profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  source_cutoff_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  raw_k_rate REAL,
  shrunk_k_rate REAL,
  league_k_rate REAL,
  sample_weight REAL NOT NULL DEFAULT 0,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  profile_version TEXT NOT NULL DEFAULT 'batter-k-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, profile_version)
);
CREATE TABLE lineup_k_features_daily (
  lineup_k_feature_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineup_snapshot_id INTEGER NOT NULL,
  mlb_game_pk INTEGER NOT NULL,
  official_date TEXT NOT NULL,
  batting_team_mlb_id INTEGER NOT NULL,
  opponent_team_mlb_id INTEGER NOT NULL,
  opposing_probable_pitcher_mlb_id INTEGER,
  opposing_probable_pitcher_hand TEXT,
  lineup_size INTEGER NOT NULL,
  profiled_batters INTEGER NOT NULL,
  profile_coverage REAL NOT NULL,
  total_profile_pa INTEGER NOT NULL DEFAULT 0,
  unweighted_lineup_k_rate REAL,
  slot_weighted_lineup_k_rate REAL,
  team_k_rate_reference REAL,
  lineup_vs_team_delta REAL,
  league_k_rate REAL,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  feature_version TEXT NOT NULL DEFAULT 'lineup-k-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, handedness_profiled_batters INTEGER NOT NULL DEFAULT 0, handedness_profile_coverage REAL NOT NULL DEFAULT 0, generic_fallback_batters INTEGER NOT NULL DEFAULT 0, league_fallback_batters INTEGER NOT NULL DEFAULT 0, handedness_total_pa INTEGER NOT NULL DEFAULT 0, generic_total_pa INTEGER NOT NULL DEFAULT 0, profile_method_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (lineup_snapshot_id) REFERENCES game_lineup_snapshots(lineup_snapshot_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (lineup_snapshot_id, feature_version)
);
CREATE TABLE batter_k_profiles_hand_daily (
  batter_k_hand_profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  source_cutoff_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  raw_k_rate REAL,
  shrunk_k_rate REAL,
  league_k_rate REAL,
  sample_weight REAL NOT NULL DEFAULT 0,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_name TEXT NOT NULL DEFAULT 'MLB_STATS_API',
  profile_version TEXT NOT NULL DEFAULT 'batter-k-hand-v1',
  sync_run_id INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, pitcher_hand, profile_version)
);
CREATE TABLE batter_k_profile_backfill_attempts (
  batter_k_profile_backfill_attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mlb_batter_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  status TEXT NOT NULL CHECK (status IN ('FILLED','NO_PRIOR_HAND_PA','RETRYABLE_ERROR','FAILED_PERMANENT')),
  plate_appearances INTEGER NOT NULL DEFAULT 0,
  strikeouts INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  last_sync_run_id INTEGER,
  last_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mlb_batter_id) REFERENCES mlb_batters(mlb_batter_id),
  FOREIGN KEY (last_sync_run_id) REFERENCES sync_runs(sync_run_id) ON DELETE SET NULL,
  UNIQUE (mlb_batter_id, as_of_date, pitcher_hand)
);
CREATE TABLE lineup_challenger_replay_runs (
  lineup_replay_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  replay_version TEXT NOT NULL DEFAULT 'lineup-challenger-replay-v1',
  status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dates_seen INTEGER NOT NULL DEFAULT 0,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_reconstructed INTEGER NOT NULL DEFAULT 0,
  rows_incomplete INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);
CREATE TABLE lineup_challenger_replay_rows (
  lineup_replay_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineup_replay_run_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  mlb_game_pk INTEGER,
  pitcher_id INTEGER NOT NULL,
  pitcher_mlb_id INTEGER,
  pitcher_hand TEXT CHECK(pitcher_hand IN ('L','R') OR pitcher_hand IS NULL),
  opponent_team_id INTEGER,
  opponent_mlb_team_id INTEGER,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('NATIVE_PREGAME','RECONSTRUCTED_ACTUAL','INCOMPLETE')),
  source_note TEXT,
  lineup_size INTEGER NOT NULL DEFAULT 0,
  hand_profiled_batters INTEGER NOT NULL DEFAULT 0,
  hand_profile_coverage REAL NOT NULL DEFAULT 0,
  total_hand_pa INTEGER NOT NULL DEFAULT 0,
  lineup_k_rate REAL,
  team_k_rate_reference REAL,
  lineup_vs_team_delta REAL,
  baseline_projection REAL,
  lineup_projection REAL,
  prop_line REAL NOT NULL,
  baseline_side TEXT,
  lineup_side TEXT,
  baseline_outcome TEXT,
  lineup_outcome TEXT,
  disagreement INTEGER NOT NULL DEFAULT 0 CHECK(disagreement IN (0,1)),
  lineup_hit INTEGER CHECK(lineup_hit IN (0,1) OR lineup_hit IS NULL),
  baseline_hit INTEGER CHECK(baseline_hit IN (0,1) OR baseline_hit IS NULL),
  quality_score INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(lineup_replay_run_id) REFERENCES lineup_challenger_replay_runs(lineup_replay_run_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  UNIQUE(lineup_replay_run_id, backtest_dataset_row_id)
);
CREATE TABLE statcast_source_state (
  source_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NEVER_SYNCED' CHECK(status IN ('NEVER_SYNCED','HEALTHY','STALE','FAILED','PAUSED')),
  last_attempt_at TEXT,
  last_success_at TEXT,
  complete_through_date TEXT,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE statcast_pitch_events (
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
CREATE TABLE statcast_pitcher_game_metrics (
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
CREATE TABLE statcast_pitcher_daily_features (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, games_30d INTEGER NOT NULL DEFAULT 0, pitches_30d INTEGER NOT NULL DEFAULT 0, last_game_date TEXT, recent_fastball_velocity REAL, baseline_fastball_velocity_30d REAL, pitch_mix_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(feature_date, pitcher_mlb_id)
);
CREATE TABLE statcast_backfill_dates (statcast_backfill_date_id INTEGER PRIMARY KEY AUTOINCREMENT,calendar_date TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETE','EMPTY','FAILED')),source_rows INTEGER NOT NULL DEFAULT 0,valid_rows INTEGER NOT NULL DEFAULT 0,stored_pitch_events INTEGER NOT NULL DEFAULT 0,pitcher_games INTEGER NOT NULL DEFAULT 0,last_error TEXT,attempted_at TEXT,completed_at TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE statcast_backfill_certifications (statcast_backfill_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,backtest_run_id INTEGER NOT NULL,backtest_dataset_build_id INTEGER NOT NULL,feature_date TEXT NOT NULL,pitcher_mlb_id INTEGER NOT NULL,certification_status TEXT NOT NULL CHECK(certification_status IN ('RESEARCH_CERTIFIED','EXCLUDED')),source_window_complete INTEGER NOT NULL DEFAULT 0 CHECK(source_window_complete IN (0,1)),games_lookback INTEGER NOT NULL DEFAULT 0,pitches_lookback INTEGER NOT NULL DEFAULT 0,feature_quality_score INTEGER NOT NULL DEFAULT 0,max_source_game_date TEXT,reasons_json TEXT NOT NULL DEFAULT '[]',evidence_json TEXT NOT NULL DEFAULT '{}',certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id),UNIQUE(backtest_run_id,feature_date,pitcher_mlb_id));
CREATE TABLE statcast_challenger_replay_runs (
  statcast_replay_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  replay_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dates_completed INTEGER NOT NULL DEFAULT 0,
  rows_scored INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);
CREATE TABLE statcast_challenger_replay_dates (
  statcast_replay_date_id INTEGER PRIMARY KEY AUTOINCREMENT,
  statcast_replay_run_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('EXECUTED','SKIPPED','FAILED')),
  train_rows INTEGER NOT NULL DEFAULT 0,
  test_rows INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  disagreements INTEGER NOT NULL DEFAULT 0,
  improved INTEGER NOT NULL DEFAULT 0,
  harmed INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(statcast_replay_run_id) REFERENCES statcast_challenger_replay_runs(statcast_replay_run_id) ON DELETE CASCADE,
  UNIQUE(statcast_replay_run_id,board_date)
);
CREATE TABLE statcast_challenger_replay_rows (
  statcast_replay_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  statcast_replay_run_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  pitcher_id INTEGER NOT NULL,
  pitcher_mlb_id INTEGER NOT NULL,
  pitcher_hand TEXT,
  prop_line REAL NOT NULL,
  model_edge REAL,
  baseline_side TEXT,
  baseline_outcome TEXT,
  baseline_hit INTEGER,
  challenger_side TEXT,
  challenger_probability REAL,
  challenger_outcome TEXT,
  challenger_hit INTEGER,
  challenger_play INTEGER NOT NULL DEFAULT 0,
  disagreement INTEGER NOT NULL DEFAULT 0,
  feature_quality_score REAL,
  games_lookback INTEGER,
  pitches_lookback INTEGER,
  whiff_rate REAL,
  swinging_strike_rate REAL,
  csw_rate REAL,
  chase_rate REAL,
  avg_fastball_velocity REAL,
  velocity_delta_30d REAL,
  avg_fastball_spin REAL,
  fastball_mix_share REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(statcast_replay_run_id) REFERENCES statcast_challenger_replay_runs(statcast_replay_run_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  UNIQUE(statcast_replay_run_id,backtest_dataset_row_id)
);
CREATE TABLE game_context_snapshots (
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
CREATE TABLE game_context_backfill_dates (
  calendar_date TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_games INTEGER NOT NULL DEFAULT 0,
  games_processed INTEGER NOT NULL DEFAULT 0,
  snapshots_stored INTEGER NOT NULL DEFAULT 0,
  weather_rows INTEGER NOT NULL DEFAULT 0,
  umpire_rows INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  attempted_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE game_context_backfill_certifications (
  context_certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  prop_id INTEGER,
  mlb_game_pk INTEGER,
  game_context_snapshot_id INTEGER,
  certification_status TEXT NOT NULL,
  quality_score INTEGER NOT NULL DEFAULT 0,
  weather_available INTEGER NOT NULL DEFAULT 0,
  umpire_available INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL DEFAULT 'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  certified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(game_context_snapshot_id) REFERENCES game_context_snapshots(game_context_snapshot_id) ON DELETE SET NULL,
  UNIQUE(backtest_run_id,backtest_dataset_row_id)
);
CREATE TABLE historical_context_features (
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
CREATE TABLE context_challenger_replay_runs (
  context_replay_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL UNIQUE,
  backtest_run_id INTEGER NOT NULL,
  backtest_dataset_build_id INTEGER NOT NULL,
  replay_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dates_completed INTEGER NOT NULL DEFAULT 0,
  rows_scored INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(backtest_run_id),
  FOREIGN KEY(backtest_dataset_build_id) REFERENCES backtest_dataset_builds(backtest_dataset_build_id)
);
CREATE TABLE context_challenger_replay_dates (
  context_replay_date_id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_replay_run_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('EXECUTED','SKIPPED','FAILED')),
  train_rows INTEGER NOT NULL DEFAULT 0,
  test_rows INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  disagreements INTEGER NOT NULL DEFAULT 0,
  improved INTEGER NOT NULL DEFAULT 0,
  harmed INTEGER NOT NULL DEFAULT 0,
  boost_rows INTEGER NOT NULL DEFAULT 0,
  suppress_rows INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(context_replay_run_id) REFERENCES context_challenger_replay_runs(context_replay_run_id) ON DELETE CASCADE,
  UNIQUE(context_replay_run_id,board_date)
);
CREATE TABLE context_challenger_replay_rows (
  context_replay_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_replay_run_id INTEGER NOT NULL,
  backtest_dataset_row_id INTEGER NOT NULL,
  board_date TEXT NOT NULL,
  pitcher_id INTEGER NOT NULL,
  prop_line REAL NOT NULL,
  model_edge REAL,
  baseline_side TEXT,
  baseline_hit INTEGER,
  challenger_side TEXT,
  challenger_hit INTEGER,
  disagreement INTEGER NOT NULL DEFAULT 0,
  context_expected_baseline_hit REAL,
  prior_global_hit_rate REAL,
  context_signal_count INTEGER NOT NULL DEFAULT 0,
  confidence_class TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(confidence_class IN ('BOOST','NEUTRAL','SUPPRESS')),
  weather_group TEXT,
  wind_direction_group TEXT,
  roof_type TEXT,
  is_roof_closed INTEGER NOT NULL DEFAULT 0,
  day_night TEXT,
  temperature_f REAL,
  temperature_band TEXT,
  home_plate_umpire_mlb_id INTEGER,
  feature_quality_score REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(context_replay_run_id) REFERENCES context_challenger_replay_runs(context_replay_run_id) ON DELETE CASCADE,
  FOREIGN KEY(backtest_dataset_row_id) REFERENCES backtest_dataset_rows_v3(backtest_dataset_row_id),
  FOREIGN KEY(pitcher_id) REFERENCES pitchers(pitcher_id),
  UNIQUE(context_replay_run_id,backtest_dataset_row_id)
);
CREATE TABLE promotion_policies (
  promotion_policy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RETIRED')),
  candidate_version_name TEXT NOT NULL,
  min_historical_paired_rows INTEGER NOT NULL DEFAULT 1000,
  min_live_graded_pairs INTEGER NOT NULL DEFAULT 200,
  min_live_distinct_dates INTEGER NOT NULL DEFAULT 14,
  min_live_hit_delta REAL NOT NULL DEFAULT -0.01,
  max_live_brier_delta REAL NOT NULL DEFAULT 0.0,
  max_abs_live_calibration_gap REAL NOT NULL DEFAULT 0.05,
  require_zero_runtime_failures INTEGER NOT NULL DEFAULT 1 CHECK(require_zero_runtime_failures IN (0,1)),
  require_manual_approval INTEGER NOT NULL DEFAULT 1 CHECK(require_manual_approval IN (0,1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE promotion_readiness_snapshots (
  promotion_readiness_snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_uuid TEXT NOT NULL UNIQUE,
  promotion_policy_id INTEGER NOT NULL,
  production_model_version_id INTEGER NOT NULL,
  candidate_model_version_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gate_status TEXT NOT NULL CHECK(gate_status IN ('OBSERVATION','TECHNICALLY_READY','BLOCKED')),
  historical_paired_rows INTEGER NOT NULL DEFAULT 0,
  historical_distinct_dates INTEGER NOT NULL DEFAULT 0,
  live_paired_predictions INTEGER NOT NULL DEFAULT 0,
  live_graded_pairs INTEGER NOT NULL DEFAULT 0,
  live_distinct_dates INTEGER NOT NULL DEFAULT 0,
  production_live_hit_rate REAL,
  candidate_live_hit_rate REAL,
  live_hit_delta REAL,
  production_live_brier REAL,
  candidate_live_brier REAL,
  live_brier_delta REAL,
  candidate_abs_calibration_gap REAL,
  candidate_runtime_failures INTEGER NOT NULL DEFAULT 0,
  gates_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  captured_by TEXT,
  FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
  FOREIGN KEY(production_model_version_id) REFERENCES model_versions(model_version_id),
  FOREIGN KEY(candidate_model_version_id) REFERENCES model_versions(model_version_id)
);
CREATE TABLE live_shadow_certifications (
 live_shadow_certification_id INTEGER PRIMARY KEY AUTOINCREMENT, certification_uuid TEXT NOT NULL UNIQUE,
 promotion_policy_id INTEGER NOT NULL, production_model_version_id INTEGER NOT NULL, candidate_model_version_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'COLLECTING' CHECK(status IN ('COLLECTING','TECHNICALLY_READY','CERTIFIED','BLOCKED','CLOSED')),
 started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, min_live_graded_pairs INTEGER NOT NULL,
 min_live_distinct_dates INTEGER NOT NULL, require_zero_runtime_failures INTEGER NOT NULL DEFAULT 1 CHECK(require_zero_runtime_failures IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(promotion_policy_id) REFERENCES promotion_policies(promotion_policy_id),
 FOREIGN KEY(production_model_version_id) REFERENCES model_versions(model_version_id), FOREIGN KEY(candidate_model_version_id) REFERENCES model_versions(model_version_id));
CREATE TABLE live_shadow_failure_ledger (
 live_shadow_failure_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER, model_prediction_id INTEGER NOT NULL UNIQUE,
 prop_id INTEGER NOT NULL, board_date TEXT, failed_at TEXT NOT NULL, failure_scope TEXT NOT NULL CHECK(failure_scope IN ('PRE_CERTIFICATION','CERTIFICATION_WINDOW')),
 failure_type TEXT NOT NULL DEFAULT 'SHADOW_RUNTIME', error_message TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id),
 FOREIGN KEY(model_prediction_id) REFERENCES model_predictions(model_prediction_id), FOREIGN KEY(prop_id) REFERENCES props(prop_id));
CREATE TABLE live_shadow_certification_evidence (
 live_shadow_certification_evidence_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL, evidence_uuid TEXT NOT NULL UNIQUE,
 captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, evidence_date TEXT NOT NULL, paired_predictions INTEGER NOT NULL DEFAULT 0, graded_pairs INTEGER NOT NULL DEFAULT 0,
 missing_production_pairs INTEGER NOT NULL DEFAULT 0, missing_candidate_pairs INTEGER NOT NULL DEFAULT 0, runtime_failures INTEGER NOT NULL DEFAULT 0,
 production_hit_rate REAL, candidate_hit_rate REAL, production_brier REAL, candidate_brier REAL, candidate_abs_calibration_gap REAL,
 evidence_json TEXT NOT NULL DEFAULT '{}', captured_by TEXT, FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id));
ANALYZE sqlite_schema;
CREATE TABLE live_shadow_monitor_checkpoints (
 live_shadow_monitor_checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL,
 checkpoint_type TEXT NOT NULL CHECK(checkpoint_type IN ('DAILY','MILESTONE','MANUAL')), checkpoint_key TEXT NOT NULL, checkpoint_label TEXT NOT NULL,
 graded_pairs INTEGER NOT NULL DEFAULT 0, distinct_dates INTEGER NOT NULL DEFAULT 0, runtime_failures INTEGER NOT NULL DEFAULT 0, pair_integrity_failures INTEGER NOT NULL DEFAULT 0,
 hit_delta REAL, brier_delta REAL, abs_calibration_gap REAL, monitor_status TEXT NOT NULL CHECK(monitor_status IN ('COLLECTING','BLOCKED','TECHNICALLY_READY')),
 snapshot_json TEXT NOT NULL DEFAULT '{}', trigger_source TEXT NOT NULL, captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id), UNIQUE(live_shadow_certification_id,checkpoint_key));
CREATE TABLE live_shadow_monitor_alerts (
 live_shadow_monitor_alert_id INTEGER PRIMARY KEY AUTOINCREMENT, live_shadow_certification_id INTEGER NOT NULL, alert_key TEXT NOT NULL,
 alert_type TEXT NOT NULL CHECK(alert_type IN ('RUNTIME_FAILURE','PAIR_INTEGRITY')), severity TEXT NOT NULL DEFAULT 'BLOCKING', observed_value INTEGER NOT NULL DEFAULT 0,
 message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(live_shadow_certification_id) REFERENCES live_shadow_certifications(live_shadow_certification_id), UNIQUE(live_shadow_certification_id,alert_key));
DELETE FROM sqlite_sequence;
CREATE INDEX idx_boards_date
    ON boards(board_date);
CREATE INDEX idx_props_board
    ON props(board_id);
CREATE INDEX idx_props_pitcher
    ON props(pitcher_id);
CREATE INDEX idx_stats_pitcher_date
    ON pitcher_game_stats(pitcher_id, game_date);
CREATE INDEX idx_recommendations_prop
    ON recommendations(prop_id);
CREATE INDEX idx_audit_events_actor_email
  ON audit_events(actor_email);
CREATE INDEX idx_boards_status_date
  ON boards(status, board_date);
CREATE INDEX idx_web_audit_events_created_at
  ON web_audit_events(created_at);
CREATE INDEX idx_web_audit_events_actor_email
  ON web_audit_events(actor_email);
CREATE INDEX idx_team_handedness_lookup
  ON team_handedness_stats(team_id, season, pitcher_hand);
CREATE INDEX idx_team_opponent_trends_lookup
  ON team_opponent_trends(team_id, as_of_date, window_days);
CREATE INDEX idx_recommendations_final_card
  ON recommendations(final_card, actually_played);
CREATE INDEX idx_prop_results_review_status
  ON prop_results(postgame_review_status);
CREATE INDEX idx_automation_runs_board_started
  ON automation_runs(board_id, started_at DESC);
CREATE INDEX idx_recommendations_pregame_status
  ON recommendations(pregame_check_status, scheduled_first_pitch);
CREATE INDEX idx_recommendations_v11_score
  ON recommendations(model_version_id, recommendation_score DESC);
CREATE UNIQUE INDEX ux_boards_historical_import
ON boards(board_date, source) WHERE source = 'historical_chat_import_v2';
CREATE UNIQUE INDEX ux_props_historical_import
ON props(source, source_row) WHERE source = 'historical_chat_import_v2';
CREATE INDEX idx_pitcher_game_stats_opponent_history
  ON pitcher_game_stats(pitcher_id, opponent_team_id, game_date DESC);
CREATE INDEX idx_play_slips_date ON play_slips(entry_date DESC);
CREATE INDEX idx_play_slips_board ON play_slips(board_id);
CREATE INDEX idx_play_slip_legs_prop ON play_slip_legs(prop_id);
CREATE INDEX idx_play_slip_legs_slip ON play_slip_legs(slip_id);
CREATE INDEX idx_bankroll_transactions_date ON bankroll_transactions(transaction_date DESC);
CREATE UNIQUE INDEX idx_model_versions_single_production
  ON model_versions(model_role)
  WHERE model_role = 'PRODUCTION';
CREATE INDEX idx_model_versions_role_status
  ON model_versions(model_role, lifecycle_status, created_at DESC);
CREATE INDEX idx_model_predictions_prop_time
  ON model_predictions(prop_id, predicted_at DESC);
CREATE INDEX idx_model_predictions_version_time
  ON model_predictions(model_version_id, predicted_at DESC);
CREATE INDEX idx_model_predictions_mode_status
  ON model_predictions(prediction_mode, prediction_status, predicted_at DESC);
CREATE INDEX idx_model_predictions_feature_snapshot
  ON model_predictions(feature_snapshot_id);
CREATE INDEX idx_model_feature_values_prediction
  ON model_feature_values(model_prediction_id);
CREATE INDEX idx_model_feature_values_name_real
  ON model_feature_values(feature_name, value_real);
CREATE INDEX idx_model_feature_values_group
  ON model_feature_values(feature_group, feature_name);
CREATE INDEX idx_sync_runs_source_dataset_time
  ON sync_runs(source_name, dataset_name, started_at DESC);
CREATE INDEX idx_sync_runs_status_time
  ON sync_runs(status, started_at DESC);
CREATE INDEX idx_sync_errors_run_time
  ON sync_errors(sync_run_id, occurred_at DESC);
CREATE INDEX idx_sync_errors_unresolved
  ON sync_errors(resolved_at, retryable, occurred_at DESC);
CREATE INDEX idx_data_source_status_health
  ON data_source_status(status, last_success_at);
CREATE INDEX idx_model_versions_execution
  ON model_versions(execution_enabled, model_role, execution_priority, model_version_id);
CREATE INDEX idx_model_predictions_prop_version_mode
  ON model_predictions(prop_id, model_version_id, prediction_mode, predicted_at DESC);
CREATE INDEX idx_model_predictions_version_mode_time
  ON model_predictions(model_version_id, prediction_mode, predicted_at DESC);
CREATE INDEX idx_model_predictions_version_status
  ON model_predictions(model_version_id, prediction_status, predicted_at DESC);
CREATE INDEX idx_games_official_date ON games(official_date, scheduled_start);
CREATE INDEX idx_games_status ON games(game_status, official_date);
CREATE INDEX idx_games_probable_pitchers ON games(away_probable_pitcher_mlb_id, home_probable_pitcher_mlb_id);
CREATE INDEX idx_raw_mlb_schedule_game_time
  ON raw_mlb_schedule_snapshots(mlb_game_pk, captured_at DESC);
CREATE INDEX idx_raw_mlb_schedule_date
  ON raw_mlb_schedule_snapshots(official_date, captured_at DESC);
CREATE INDEX idx_raw_pitcher_logs_pitcher_date
  ON raw_pitcher_game_logs(mlb_pitcher_id, game_date DESC);
CREATE INDEX idx_raw_pitcher_logs_local_pitcher_date
  ON raw_pitcher_game_logs(pitcher_id, game_date DESC);
CREATE INDEX idx_raw_pitcher_logs_game
  ON raw_pitcher_game_logs(mlb_game_pk, starter);
CREATE INDEX idx_raw_pitcher_logs_date
  ON raw_pitcher_game_logs(game_date DESC, starter);
CREATE INDEX idx_raw_boxscore_game_time
  ON raw_mlb_boxscore_snapshots(mlb_game_pk, captured_at DESC);
CREATE INDEX idx_team_k_splits_lookup
  ON team_strikeout_splits_daily(team_id, as_of_date DESC, pitcher_hand, window_days);
CREATE INDEX idx_team_k_splits_freshness
  ON team_strikeout_splits_daily(as_of_date DESC, window_days, pitcher_hand);
CREATE INDEX idx_team_game_hand_batting_lookup
  ON team_game_handedness_batting(batting_team_mlb_id, official_date, pitcher_hand);
CREATE INDEX idx_pitcher_daily_features_date
  ON pitcher_daily_features(as_of_date DESC, mlb_pitcher_id);
CREATE INDEX idx_pitcher_daily_features_pitcher_date
  ON pitcher_daily_features(mlb_pitcher_id, as_of_date DESC);
CREATE INDEX idx_pitcher_daily_features_local_pitcher_date
  ON pitcher_daily_features(pitcher_id, as_of_date DESC);
CREATE INDEX idx_team_daily_features_date_hand
  ON team_daily_features(as_of_date DESC, pitcher_hand, team_id);
CREATE INDEX idx_team_daily_features_team_date
  ON team_daily_features(team_id, as_of_date DESC, pitcher_hand);
CREATE INDEX idx_prop_feature_snapshots_prop_time
  ON prop_feature_snapshots(prop_id, captured_at DESC);
CREATE INDEX idx_prop_feature_snapshots_board
  ON prop_feature_snapshots(board_id, captured_at DESC);
CREATE INDEX idx_prop_feature_snapshots_model
  ON prop_feature_snapshots(model_version_id, captured_at DESC);
CREATE INDEX idx_prop_feature_snapshots_status
  ON prop_feature_snapshots(snapshot_status, captured_at DESC);
CREATE INDEX idx_model_predictions_prop_feature_snapshot
  ON model_predictions(prop_feature_snapshot_id);
CREATE INDEX idx_prop_feature_snapshots_quality_gate
  ON prop_feature_snapshots(quality_gate, overall_data_quality_score DESC, captured_at DESC);
CREATE INDEX idx_prop_feature_snapshots_challenger_eligible
  ON prop_feature_snapshots(challenger_eligible, board_date DESC, captured_at DESC);
CREATE INDEX idx_backtest_dataset_rows_build_eligible
  ON backtest_dataset_rows(backtest_dataset_build_id, backtest_eligible, board_date);
CREATE INDEX idx_backtest_dataset_rows_prop
  ON backtest_dataset_rows(prop_id, backtest_dataset_build_id DESC);
CREATE INDEX idx_backtest_dataset_rows_model_date
  ON backtest_dataset_rows(model_version_id, board_date, certification_status);
CREATE INDEX idx_backtest_dataset_builds_time
  ON backtest_dataset_builds(started_at DESC);
CREATE INDEX idx_backtest_runs_dataset_time ON backtest_runs(backtest_dataset_build_id, started_at DESC);
CREATE INDEX idx_backtest_folds_run_status ON backtest_folds(backtest_run_id, status, fold_index);
CREATE INDEX idx_backtest_fold_rows_fold_partition ON backtest_fold_rows(backtest_fold_id, partition);
CREATE INDEX idx_backtest_fold_rows_dataset_row ON backtest_fold_rows(backtest_dataset_row_id);
CREATE INDEX idx_backtest_performance_runs_backtest_time
  ON backtest_performance_runs(backtest_run_id, started_at DESC);
CREATE INDEX idx_backtest_performance_windows_run
  ON backtest_performance_windows(backtest_performance_run_id, window_name);
CREATE INDEX idx_backtest_calibration_bins_run_window
  ON backtest_calibration_bins(backtest_performance_run_id, window_name, bucket_index);
CREATE INDEX idx_historical_reconstruction_prop
  ON historical_feature_reconstructions(prop_id, historical_reconstruction_id DESC);
CREATE INDEX idx_historical_reconstruction_class_date
  ON historical_feature_reconstructions(reconstruction_class, board_date, prop_id);
CREATE INDEX idx_historical_reconstruction_runs_time
  ON historical_feature_reconstruction_runs(started_at DESC);
CREATE INDEX idx_historical_certification_prop
  ON historical_feature_certifications(prop_id, historical_certification_id DESC);
CREATE INDEX idx_historical_certification_class_date
  ON historical_feature_certifications(certification_class, board_date, prop_id);
CREATE INDEX idx_backtest_dataset_rows_v2_build_eligible
  ON backtest_dataset_rows_v2(backtest_dataset_build_id, backtest_eligible, board_date);
CREATE INDEX idx_backtest_dataset_rows_v2_prop
  ON backtest_dataset_rows_v2(prop_id, backtest_dataset_build_id DESC);
CREATE INDEX idx_backtest_dataset_rows_v2_provenance
  ON backtest_dataset_rows_v2(source_provenance, board_date, backtest_eligible);
CREATE INDEX idx_backtest_fold_rows_v2_fold_partition ON backtest_fold_rows_v2(backtest_fold_id, partition);
CREATE INDEX idx_backtest_fold_rows_v2_dataset_row ON backtest_fold_rows_v2(backtest_dataset_row_id);
CREATE INDEX idx_historical_certification_cutoff
  ON historical_feature_certifications(certification_version, certification_class, information_cutoff_at);
CREATE INDEX idx_independent_reconstruction_prop
  ON independent_historical_reconstructions(prop_id, independent_reconstruction_id DESC);
CREATE INDEX idx_independent_reconstruction_status_date
  ON independent_historical_reconstructions(reconstruction_status, board_date, prop_id);
CREATE INDEX idx_independent_reconstruction_runs_time
  ON independent_historical_reconstruction_runs(started_at DESC);
CREATE INDEX idx_hist_opp_recon_prop
  ON historical_opponent_reconstructions(prop_id, historical_opponent_reconstruction_id DESC);
CREATE INDEX idx_hist_opp_recon_status_date
  ON historical_opponent_reconstructions(reconstruction_status, board_date, prop_id);
CREATE INDEX idx_hist_opp_recon_runs_time
  ON historical_opponent_reconstruction_runs(started_at DESC);
CREATE INDEX idx_historical_archive_props_date
  ON historical_archive_props(board_date,historical_archive_prop_id);
CREATE INDEX idx_historical_archive_props_eligible
  ON historical_archive_props(eligible_for_reconstruction,board_date);
CREATE INDEX idx_archive_recon_prop
  ON archive_historical_reconstructions(historical_archive_prop_id,archive_historical_reconstruction_id);
CREATE INDEX idx_archive_recon_status
  ON archive_historical_reconstructions(reconstruction_status,board_date);
CREATE INDEX idx_archive_cert_prop ON archive_historical_certifications(historical_archive_prop_id,archive_historical_certification_id DESC);
CREATE INDEX idx_archive_cert_class_date ON archive_historical_certifications(certification_class,board_date,historical_archive_prop_id);
CREATE UNIQUE INDEX uq_backtest_v3_native_reconstructed_prop ON backtest_dataset_rows_v3(backtest_dataset_build_id,prop_id,model_version_id) WHERE prop_id IS NOT NULL;
CREATE UNIQUE INDEX uq_backtest_v3_archive_prop ON backtest_dataset_rows_v3(backtest_dataset_build_id,historical_archive_prop_id,model_version_id) WHERE historical_archive_prop_id IS NOT NULL;
CREATE INDEX idx_backtest_v3_build_eligible ON backtest_dataset_rows_v3(backtest_dataset_build_id,backtest_eligible,board_date);
CREATE INDEX idx_backtest_v3_provenance ON backtest_dataset_rows_v3(source_provenance,board_date,backtest_eligible);
CREATE INDEX idx_backtest_fold_rows_v3_fold_partition ON backtest_fold_rows_v3(backtest_fold_id,partition);
CREATE INDEX idx_backtest_fold_rows_v3_dataset_row ON backtest_fold_rows_v3(backtest_dataset_row_id);
CREATE INDEX idx_mlb_batters_hand ON mlb_batters(bat_side);
CREATE INDEX idx_mlb_batters_team ON mlb_batters(last_seen_team_mlb_id);
CREATE INDEX idx_lineup_snapshot_game_team_time
  ON game_lineup_snapshots(mlb_game_pk, batting_team_mlb_id, captured_at DESC);
CREATE INDEX idx_lineup_snapshot_date_status
  ON game_lineup_snapshots(official_date, lineup_status, captured_at DESC);
CREATE INDEX idx_lineup_entries_batter ON game_lineup_entries(mlb_batter_id);
CREATE INDEX idx_batter_k_profile_date ON batter_k_profiles_daily(as_of_date DESC, mlb_batter_id);
CREATE INDEX idx_batter_k_profile_player ON batter_k_profiles_daily(mlb_batter_id, as_of_date DESC);
CREATE INDEX idx_lineup_k_feature_date ON lineup_k_features_daily(official_date DESC, batting_team_mlb_id);
CREATE INDEX idx_lineup_k_feature_game ON lineup_k_features_daily(mlb_game_pk, batting_team_mlb_id);
CREATE INDEX idx_batter_k_hand_date ON batter_k_profiles_hand_daily(as_of_date DESC,pitcher_hand,mlb_batter_id);
CREATE INDEX idx_batter_k_hand_player ON batter_k_profiles_hand_daily(mlb_batter_id,as_of_date DESC,pitcher_hand);
CREATE INDEX idx_batter_k_profile_backfill_date ON batter_k_profile_backfill_attempts(as_of_date DESC,pitcher_hand,status);
CREATE INDEX idx_lineup_replay_rows_date ON lineup_challenger_replay_rows(lineup_replay_run_id,board_date);
CREATE INDEX idx_lineup_replay_rows_source ON lineup_challenger_replay_rows(lineup_replay_run_id,source_mode,quality_score);
CREATE INDEX idx_statcast_pitch_events_pitcher_date
  ON statcast_pitch_events(pitcher_mlb_id, game_date);
CREATE INDEX idx_statcast_pitch_events_game
  ON statcast_pitch_events(game_pk, at_bat_number, pitch_number);
CREATE INDEX idx_statcast_pitcher_game_metrics_pitcher_date
  ON statcast_pitcher_game_metrics(pitcher_mlb_id, game_date);
CREATE INDEX idx_statcast_pitcher_daily_features_date
  ON statcast_pitcher_daily_features(feature_date, pitcher_mlb_id);
CREATE INDEX idx_statcast_daily_pitcher_date
  ON statcast_pitcher_daily_features(pitcher_mlb_id, feature_date);
CREATE INDEX idx_statcast_backfill_dates_status_date ON statcast_backfill_dates(status,calendar_date);
CREATE INDEX idx_statcast_cert_run_date ON statcast_backfill_certifications(backtest_run_id,feature_date,certification_status);
CREATE INDEX idx_statcast_replay_rows_run_date ON statcast_challenger_replay_rows(statcast_replay_run_id,board_date);
CREATE INDEX idx_statcast_replay_dates_run_date ON statcast_challenger_replay_dates(statcast_replay_run_id,board_date);
CREATE INDEX idx_game_context_date ON game_context_snapshots(official_date,scheduled_start);
CREATE INDEX idx_game_context_umpire ON game_context_snapshots(home_plate_umpire_mlb_id,official_date);
CREATE INDEX idx_context_cert_date ON game_context_backfill_certifications(backtest_run_id,board_date,certification_status);
CREATE INDEX idx_context_cert_game ON game_context_backfill_certifications(mlb_game_pk,board_date);
CREATE INDEX idx_hist_context_features_date ON historical_context_features(backtest_run_id,board_date,feature_status);
CREATE INDEX idx_hist_context_features_game ON historical_context_features(mlb_game_pk,board_date);
CREATE INDEX idx_hist_context_features_umpire ON historical_context_features(home_plate_umpire_mlb_id,board_date);
CREATE INDEX idx_context_replay_rows_run_date ON context_challenger_replay_rows(context_replay_run_id,board_date);
CREATE INDEX idx_context_replay_rows_confidence ON context_challenger_replay_rows(context_replay_run_id,confidence_class);
CREATE INDEX idx_context_replay_dates_run_date ON context_challenger_replay_dates(context_replay_run_id,board_date);
CREATE INDEX idx_promotion_snapshots_candidate_time ON promotion_readiness_snapshots(candidate_model_version_id,captured_at DESC);
CREATE INDEX idx_promotion_snapshots_status_time ON promotion_readiness_snapshots(gate_status,captured_at DESC);
CREATE INDEX idx_live_shadow_cert_status ON live_shadow_certifications(status,started_at DESC);
CREATE INDEX idx_live_shadow_failure_cert_time ON live_shadow_failure_ledger(live_shadow_certification_id,failed_at DESC);
CREATE INDEX idx_live_shadow_evidence_cert_date ON live_shadow_certification_evidence(live_shadow_certification_id,evidence_date,captured_at DESC);
CREATE INDEX idx_model_predictions_certification_lookup
  ON model_predictions(model_version_id, prediction_mode, prediction_status, prop_id, predicted_at DESC, model_prediction_id DESC);
CREATE INDEX idx_live_shadow_monitor_checkpoint_cert ON live_shadow_monitor_checkpoints(live_shadow_certification_id,captured_at DESC);
CREATE INDEX idx_live_shadow_monitor_alert_cert ON live_shadow_monitor_alerts(live_shadow_certification_id,created_at DESC);
CREATE INDEX idx_feature_snapshots_prop_model_latest ON feature_snapshots(prop_id,model_version_id,snapshot_time DESC,feature_snapshot_id DESC);
