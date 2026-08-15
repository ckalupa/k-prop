ALTER TABLE play_slips ADD COLUMN power_multiplier REAL CHECK (power_multiplier >= 0);
ALTER TABLE play_slips ADD COLUMN flex_full_multiplier REAL CHECK (flex_full_multiplier >= 0);
ALTER TABLE play_slips ADD COLUMN boost_percent REAL NOT NULL DEFAULT 0 CHECK (boost_percent >= 0 AND boost_percent <= 1000);
ALTER TABLE play_slips ADD COLUMN actual_base_multiplier REAL;

UPDATE play_slips
SET power_multiplier = CASE WHEN entry_type = 'POWER' THEN full_hit_multiplier ELSE power_multiplier END,
    flex_full_multiplier = CASE WHEN entry_type = 'FLEX' THEN full_hit_multiplier ELSE flex_full_multiplier END
WHERE power_multiplier IS NULL OR flex_full_multiplier IS NULL;
