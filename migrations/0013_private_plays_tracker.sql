
CREATE TABLE IF NOT EXISTS play_slips (
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
  settled_at TEXT,
  FOREIGN KEY (board_id) REFERENCES boards(board_id)
);

CREATE TABLE IF NOT EXISTS play_slip_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id INTEGER NOT NULL,
  eligible_legs INTEGER NOT NULL CHECK (eligible_legs >= 1),
  hits INTEGER NOT NULL CHECK (hits >= 0),
  multiplier REAL NOT NULL CHECK (multiplier >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slip_id) REFERENCES play_slips(slip_id) ON DELETE CASCADE,
  UNIQUE (slip_id, eligible_legs, hits)
);

CREATE TABLE IF NOT EXISTS play_slip_legs (
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

CREATE TABLE IF NOT EXISTS bankroll_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_date TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('STARTING_BALANCE', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT')),
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS play_audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_id INTEGER,
  event_type TEXT NOT NULL,
  event_details TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slip_id) REFERENCES play_slips(slip_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_play_slips_date ON play_slips(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_play_slips_board ON play_slips(board_id);
CREATE INDEX IF NOT EXISTS idx_play_slip_legs_prop ON play_slip_legs(prop_id);
CREATE INDEX IF NOT EXISTS idx_play_slip_legs_slip ON play_slip_legs(slip_id);
CREATE INDEX IF NOT EXISTS idx_bankroll_transactions_date ON bankroll_transactions(transaction_date DESC);
