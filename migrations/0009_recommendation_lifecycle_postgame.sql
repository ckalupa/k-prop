PRAGMA foreign_keys = ON;

-- Preserve the complete decision lifecycle so model qualification, final
-- recommendation, and an actually submitted entry are never conflated.
ALTER TABLE recommendations ADD COLUMN initial_classification TEXT;
ALTER TABLE recommendations ADD COLUMN final_classification TEXT;
ALTER TABLE recommendations ADD COLUMN final_card INTEGER NOT NULL DEFAULT 0 CHECK (final_card IN (0, 1));
ALTER TABLE recommendations ADD COLUMN actually_played INTEGER NOT NULL DEFAULT 0 CHECK (actually_played IN (0, 1));
ALTER TABLE recommendations ADD COLUMN opening_line REAL;
ALTER TABLE recommendations ADD COLUMN recommended_line REAL;
ALTER TABLE recommendations ADD COLUMN closing_line REAL;
ALTER TABLE recommendations ADD COLUMN market_type TEXT;
ALTER TABLE recommendations ADD COLUMN finalized_at TEXT;
ALTER TABLE recommendations ADD COLUMN change_reason TEXT;
ALTER TABLE recommendations ADD COLUMN completeness_score INTEGER CHECK (completeness_score BETWEEN 0 AND 100);
ALTER TABLE recommendations ADD COLUMN starter_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (starter_confirmed IN (0, 1));
ALTER TABLE recommendations ADD COLUMN lineup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (lineup_confirmed IN (0, 1));
ALTER TABLE recommendations ADD COLUMN weather_checked INTEGER NOT NULL DEFAULT 0 CHECK (weather_checked IN (0, 1));
ALTER TABLE recommendations ADD COLUMN umpire_checked INTEGER NOT NULL DEFAULT 0 CHECK (umpire_checked IN (0, 1));

-- Copy official workload into the settled result row so historical reporting
-- does not have to reconstruct the game-stat join later.
ALTER TABLE prop_results ADD COLUMN innings_pitched REAL;
ALTER TABLE prop_results ADD COLUMN pitch_count INTEGER;
ALTER TABLE prop_results ADD COLUMN batters_faced INTEGER;
ALTER TABLE prop_results ADD COLUMN starter INTEGER CHECK (starter IN (0, 1));
ALTER TABLE prop_results ADD COLUMN suggested_reason_code TEXT;
ALTER TABLE prop_results ADD COLUMN postgame_reason_code TEXT;
ALTER TABLE prop_results ADD COLUMN early_exit_reason TEXT;
ALTER TABLE prop_results ADD COLUMN postgame_review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
  CHECK (postgame_review_status IN ('UNREVIEWED', 'REVIEWED', 'NOT_REQUIRED'));

CREATE INDEX IF NOT EXISTS idx_recommendations_final_card
  ON recommendations(final_card, actually_played);

CREATE INDEX IF NOT EXISTS idx_prop_results_review_status
  ON prop_results(postgame_review_status);
