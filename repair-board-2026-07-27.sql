DELETE FROM play_slip_legs
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN boards b ON b.board_id = p.board_id
  JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
  WHERE b.board_date = '2026-07-27'
    AND pi.canonical_name LIKE '%Gallen%'
);

DELETE FROM prop_results
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN boards b ON b.board_id = p.board_id
  JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
  WHERE b.board_date = '2026-07-27'
    AND pi.canonical_name LIKE '%Gallen%'
);

DELETE FROM recommendations
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN boards b ON b.board_id = p.board_id
  JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
  WHERE b.board_date = '2026-07-27'
    AND pi.canonical_name LIKE '%Gallen%'
);

DELETE FROM feature_snapshots
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN boards b ON b.board_id = p.board_id
  JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
  WHERE b.board_date = '2026-07-27'
    AND pi.canonical_name LIKE '%Gallen%'
);

DELETE FROM props
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN boards b ON b.board_id = p.board_id
  JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
  WHERE b.board_date = '2026-07-27'
    AND pi.canonical_name LIKE '%Gallen%'
);

UPDATE boards
SET status = 'CLOSED',
    updated_at = CURRENT_TIMESTAMP
WHERE board_id = 128;

INSERT INTO boards (
  board_date,
  board_name,
  status,
  source,
  created_at,
  updated_at
)
SELECT
  '2026-07-28',
  'PrizePicks 2026-07-28',
  'DRAFT',
  'AUTO_CRON',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM boards
  WHERE board_date = '2026-07-28'
);
