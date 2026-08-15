-- Cloudflare D1-compatible cleanup for exact historical cross-source duplicates.
--
-- Keeps historical_chat_import_v2.
-- Removes matching MIGRATED_LEDGER rows where board date, pitcher, and line match.
-- Copies a missing result to the retained row before removing the duplicate.
--
-- This version intentionally avoids PRAGMA statements and TEMP tables because
-- Cloudflare D1 may reject them with SQLITE_AUTH.

-- 1. Preview duplicate count.
SELECT 'duplicate_props_to_remove' AS metric, COUNT(*) AS value
FROM props oldp
JOIN boards oldb
  ON oldb.board_id = oldp.board_id
WHERE oldp.source = 'MIGRATED_LEDGER'
  AND EXISTS (
    SELECT 1
    FROM props keepp
    JOIN boards keepb
      ON keepb.board_id = keepp.board_id
    WHERE keepp.source = 'historical_chat_import_v2'
      AND keepb.board_date = oldb.board_date
      AND keepp.pitcher_id = oldp.pitcher_id
      AND keepp.strikeout_line = oldp.strikeout_line
  );

-- 2. Preserve a result when the retained prop does not already have one.
INSERT OR IGNORE INTO prop_results (
  prop_id,
  actual_strikeouts,
  result,
  result_status,
  source,
  graded_at,
  created_at,
  innings_pitched,
  pitch_count,
  batters_faced,
  starter,
  suggested_reason_code,
  postgame_reason_code,
  early_exit_reason,
  postgame_review_status
)
SELECT
  keepp.prop_id,
  oldr.actual_strikeouts,
  oldr.result,
  oldr.result_status,
  oldr.source,
  oldr.graded_at,
  oldr.created_at,
  oldr.innings_pitched,
  oldr.pitch_count,
  oldr.batters_faced,
  oldr.starter,
  oldr.suggested_reason_code,
  oldr.postgame_reason_code,
  oldr.early_exit_reason,
  oldr.postgame_review_status
FROM props oldp
JOIN boards oldb
  ON oldb.board_id = oldp.board_id
JOIN prop_results oldr
  ON oldr.prop_id = oldp.prop_id
JOIN props keepp
  ON keepp.pitcher_id = oldp.pitcher_id
 AND keepp.strikeout_line = oldp.strikeout_line
JOIN boards keepb
  ON keepb.board_id = keepp.board_id
 AND keepb.board_date = oldb.board_date
WHERE oldp.source = 'MIGRATED_LEDGER'
  AND keepp.source = 'historical_chat_import_v2'
  AND NOT EXISTS (
    SELECT 1
    FROM prop_results existing
    WHERE existing.prop_id = keepp.prop_id
  );

-- 3. Record each merge for traceability.
INSERT INTO audit_events (
  event_type,
  entity_type,
  entity_id,
  event_details,
  created_at
)
SELECT
  'HISTORICAL_DUPLICATE_MERGED',
  'prop',
  keepp.prop_id,
  '{"removed_prop_id":' || oldp.prop_id ||
  ',"retained_prop_id":' || keepp.prop_id ||
  ',"board_date":"' || oldb.board_date ||
  '","strikeout_line":' || oldp.strikeout_line ||
  ',"removed_source":"MIGRATED_LEDGER"' ||
  ',"retained_source":"historical_chat_import_v2"}',
  CURRENT_TIMESTAMP
FROM props oldp
JOIN boards oldb
  ON oldb.board_id = oldp.board_id
JOIN props keepp
  ON keepp.pitcher_id = oldp.pitcher_id
 AND keepp.strikeout_line = oldp.strikeout_line
JOIN boards keepb
  ON keepb.board_id = keepp.board_id
 AND keepb.board_date = oldb.board_date
WHERE oldp.source = 'MIGRATED_LEDGER'
  AND keepp.source = 'historical_chat_import_v2'
  AND NOT EXISTS (
    SELECT 1
    FROM audit_events ae
    WHERE ae.event_type = 'HISTORICAL_DUPLICATE_MERGED'
      AND ae.entity_type = 'prop'
      AND ae.entity_id = keepp.prop_id
      AND ae.event_details LIKE '%"removed_prop_id":' || oldp.prop_id || '%'
  );

-- 4. Remove dependent records attached to duplicate MIGRATED_LEDGER props.
DELETE FROM recommendations
WHERE prop_id IN (
  SELECT oldp.prop_id
  FROM props oldp
  JOIN boards oldb
    ON oldb.board_id = oldp.board_id
  WHERE oldp.source = 'MIGRATED_LEDGER'
    AND EXISTS (
      SELECT 1
      FROM props keepp
      JOIN boards keepb
        ON keepb.board_id = keepp.board_id
      WHERE keepp.source = 'historical_chat_import_v2'
        AND keepb.board_date = oldb.board_date
        AND keepp.pitcher_id = oldp.pitcher_id
        AND keepp.strikeout_line = oldp.strikeout_line
    )
);

DELETE FROM feature_snapshots
WHERE prop_id IN (
  SELECT oldp.prop_id
  FROM props oldp
  JOIN boards oldb
    ON oldb.board_id = oldp.board_id
  WHERE oldp.source = 'MIGRATED_LEDGER'
    AND EXISTS (
      SELECT 1
      FROM props keepp
      JOIN boards keepb
        ON keepb.board_id = keepp.board_id
      WHERE keepp.source = 'historical_chat_import_v2'
        AND keepb.board_date = oldb.board_date
        AND keepp.pitcher_id = oldp.pitcher_id
        AND keepp.strikeout_line = oldp.strikeout_line
    )
);

DELETE FROM prop_results
WHERE prop_id IN (
  SELECT oldp.prop_id
  FROM props oldp
  JOIN boards oldb
    ON oldb.board_id = oldp.board_id
  WHERE oldp.source = 'MIGRATED_LEDGER'
    AND EXISTS (
      SELECT 1
      FROM props keepp
      JOIN boards keepb
        ON keepb.board_id = keepp.board_id
      WHERE keepp.source = 'historical_chat_import_v2'
        AND keepb.board_date = oldb.board_date
        AND keepp.pitcher_id = oldp.pitcher_id
        AND keepp.strikeout_line = oldp.strikeout_line
    )
);

DELETE FROM web_audit_events
WHERE entity_type = 'PROP'
  AND entity_id IN (
    SELECT oldp.prop_id
    FROM props oldp
    JOIN boards oldb
      ON oldb.board_id = oldp.board_id
    WHERE oldp.source = 'MIGRATED_LEDGER'
      AND EXISTS (
        SELECT 1
        FROM props keepp
        JOIN boards keepb
          ON keepb.board_id = keepp.board_id
        WHERE keepp.source = 'historical_chat_import_v2'
          AND keepb.board_date = oldb.board_date
          AND keepp.pitcher_id = oldp.pitcher_id
          AND keepp.strikeout_line = oldp.strikeout_line
      )
  );

DELETE FROM audit_events
WHERE entity_type = 'prop'
  AND event_type <> 'HISTORICAL_DUPLICATE_MERGED'
  AND entity_id IN (
    SELECT oldp.prop_id
    FROM props oldp
    JOIN boards oldb
      ON oldb.board_id = oldp.board_id
    WHERE oldp.source = 'MIGRATED_LEDGER'
      AND EXISTS (
        SELECT 1
        FROM props keepp
        JOIN boards keepb
          ON keepb.board_id = keepp.board_id
        WHERE keepp.source = 'historical_chat_import_v2'
          AND keepb.board_date = oldb.board_date
          AND keepp.pitcher_id = oldp.pitcher_id
          AND keepp.strikeout_line = oldp.strikeout_line
      )
  );

-- 5. Remove duplicate props.
DELETE FROM props
WHERE source = 'MIGRATED_LEDGER'
  AND EXISTS (
    SELECT 1
    FROM boards oldb
    WHERE oldb.board_id = props.board_id
      AND EXISTS (
        SELECT 1
        FROM props keepp
        JOIN boards keepb
          ON keepb.board_id = keepp.board_id
        WHERE keepp.source = 'historical_chat_import_v2'
          AND keepb.board_date = oldb.board_date
          AND keepp.pitcher_id = props.pitcher_id
          AND keepp.strikeout_line = props.strikeout_line
      )
  );

-- 6. Verify cleanup.
SELECT 'remaining_cross_source_duplicates' AS metric, COUNT(*) AS value
FROM (
  SELECT
    b.board_date,
    p.pitcher_id,
    p.strikeout_line
  FROM props p
  JOIN boards b
    ON b.board_id = p.board_id
  WHERE p.source IN ('MIGRATED_LEDGER', 'historical_chat_import_v2')
  GROUP BY b.board_date, p.pitcher_id, p.strikeout_line
  HAVING COUNT(DISTINCT p.source) > 1
);
