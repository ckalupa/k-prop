PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    abbreviation TEXT NOT NULL UNIQUE,
    full_name TEXT,
    league TEXT,
    division TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pitchers (
    pitcher_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    mlb_id INTEGER UNIQUE,
    throws_hand TEXT CHECK (throws_hand IN ('R', 'L')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pitcher_aliases (
    alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pitcher_id INTEGER NOT NULL,
    alias_name TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pitcher_id) REFERENCES pitchers(pitcher_id)
);

CREATE TABLE IF NOT EXISTS model_versions (
    model_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS boards (
    board_id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_date TEXT NOT NULL,
    board_name TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED')),
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS games (
    game_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mlb_game_pk INTEGER UNIQUE,
    game_date TEXT NOT NULL,
    away_team_id INTEGER,
    home_team_id INTEGER,
    scheduled_start TEXT,
    game_status TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (away_team_id) REFERENCES teams(team_id),
    FOREIGN KEY (home_team_id) REFERENCES teams(team_id)
);

CREATE TABLE IF NOT EXISTS props (
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

CREATE TABLE IF NOT EXISTS pitcher_game_stats (
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

CREATE TABLE IF NOT EXISTS feature_snapshots (
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
    source_quality TEXT,
    FOREIGN KEY (prop_id) REFERENCES props(prop_id),
    FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id)
);

CREATE TABLE IF NOT EXISTS recommendations (
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
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prop_id) REFERENCES props(prop_id),
    FOREIGN KEY (model_version_id) REFERENCES model_versions(model_version_id),
    UNIQUE (prop_id, model_version_id)
);

CREATE TABLE IF NOT EXISTS prop_results (
    prop_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    prop_id INTEGER NOT NULL UNIQUE,
    actual_strikeouts INTEGER,
    result TEXT CHECK (result IN ('OVER', 'UNDER', 'PUSH', 'VOID')),
    result_status TEXT NOT NULL DEFAULT 'PENDING',
    source TEXT,
    graded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prop_id) REFERENCES props(prop_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
    audit_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    event_details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_boards_date
    ON boards(board_date);

CREATE INDEX IF NOT EXISTS idx_props_board
    ON props(board_id);

CREATE INDEX IF NOT EXISTS idx_props_pitcher
    ON props(pitcher_id);

CREATE INDEX IF NOT EXISTS idx_stats_pitcher_date
    ON pitcher_game_stats(pitcher_id, game_date);

CREATE INDEX IF NOT EXISTS idx_recommendations_prop
    ON recommendations(prop_id);

INSERT OR IGNORE INTO model_versions (
    version_name,
    description,
    is_active
)
VALUES (
    'v5-parity',
    'Excel Decision Engine v5 parity baseline',
    1
);