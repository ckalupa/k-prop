-- Reopen board 72 and reset automated DNP voids for re-grading with the
-- final-box-score fallback. Safe to run once after deploying the code fix.

UPDATE prop_results
SET actual_strikeouts = NULL,
    result = NULL,
    result_status = 'PENDING',
    source = 'RESET_FALSE_DNP_FOR_REGRADE',
    innings_pitched = NULL,
    pitch_count = NULL,
    batters_faced = NULL,
    starter = NULL,
    suggested_reason_code = NULL,
    postgame_reason_code = NULL,
    early_exit_reason = NULL,
    postgame_review_status = 'UNREVIEWED',
    graded_at = NULL
WHERE prop_id IN (
  SELECT p.prop_id
  FROM props p
  JOIN prop_results pr ON pr.prop_id = p.prop_id
  WHERE p.board_id = 72
    AND pr.result = 'VOID'
    AND pr.suggested_reason_code = 'DNP_OR_STARTER_CHANGE'
);

UPDATE boards
SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
WHERE board_id = 72;

SELECT
  p.prop_id,
  pi.canonical_name AS pitcher,
  pr.result,
  pr.result_status,
  pr.source
FROM props p
JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
WHERE p.board_id = 72
  AND pi.canonical_name IN ('Peter Lambert', 'Sandy Alcantara', 'Colin Rea')
ORDER BY pi.canonical_name;
