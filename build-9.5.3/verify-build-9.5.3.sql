SELECT name, sql
FROM sqlite_master
WHERE type='index'
  AND name IN (
    'idx_sync_runs_dataset_status_started_id',
    'idx_sync_runs_dataset_trigger_cursor_id',
    'idx_sync_runs_dataset_id'
  )
ORDER BY name;

SELECT dataset_name, status, COUNT(*) AS n
FROM sync_runs
WHERE dataset_name IN (
  'MLB_SCHEDULE_GAMES',
  'PITCHER_GAME_LOGS',
  'TEAM_STRIKEOUT_SPLITS',
  'PITCHER_DAILY_FEATURES',
  'TEAM_DAILY_FEATURES'
)
  AND status='RUNNING'
GROUP BY dataset_name, status
ORDER BY dataset_name;

EXPLAIN QUERY PLAN
SELECT sync_run_id
FROM sync_runs
WHERE dataset_name='PITCHER_GAME_LOGS'
  AND status='RUNNING'
  AND started_at >= datetime('now','-15 minutes')
ORDER BY started_at DESC, sync_run_id DESC
LIMIT 1;

EXPLAIN QUERY PLAN
SELECT details_json
FROM sync_runs
WHERE dataset_name='PITCHER_GAME_LOGS'
  AND trigger_source='CRON'
  AND source_cursor_start='2026-08-31'
  AND source_cursor_end='2026-09-02'
  AND completed_at IS NOT NULL
  AND status IN ('SUCCEEDED','PARTIAL')
ORDER BY sync_run_id DESC
LIMIT 1;
