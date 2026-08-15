SELECT
  p.prop_id,
  b.board_id,
  b.board_date,
  b.status AS board_status,
  pi.canonical_name,
  t.abbreviation AS opponent,
  p.strikeout_line,
  COALESCE(pr.result_status, 'NO RESULT') AS result_status
FROM props p
JOIN boards b ON b.board_id = p.board_id
JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
LEFT JOIN teams t ON t.team_id = p.opponent_team_id
LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
WHERE b.board_date = '2026-07-27'
  AND pi.canonical_name LIKE '%Gallen%';
