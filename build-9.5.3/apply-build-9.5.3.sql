CREATE INDEX IF NOT EXISTS idx_sync_runs_dataset_status_started_id
ON sync_runs(dataset_name, status, started_at DESC, sync_run_id DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_dataset_trigger_cursor_id
ON sync_runs(dataset_name, trigger_source, source_cursor_start, source_cursor_end, sync_run_id DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_dataset_id
ON sync_runs(dataset_name, sync_run_id DESC);

UPDATE sync_runs
SET status='FAILED',
    completed_at=CURRENT_TIMESTAMP,
    rows_rejected=CASE WHEN rows_rejected < 1 THEN 1 ELSE rows_rejected END,
    details_json=json_object(
      'error','STALE_CRON_RUNNING_REAPED',
      'message','Stale production sync RUNNING row recovered by Build 9.5.3',
      'dataset_name',dataset_name
    )
WHERE trigger_source='CRON'
  AND status='RUNNING'
  AND dataset_name IN (
    'MLB_SCHEDULE_GAMES',
    'PITCHER_GAME_LOGS',
    'TEAM_STRIKEOUT_SPLITS',
    'PITCHER_DAILY_FEATURES',
    'TEAM_DAILY_FEATURES'
  )
  AND started_at < datetime('now','-15 minutes');
