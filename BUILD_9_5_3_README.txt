K-Prop Build 9.5.3 - D1 Read Efficiency + Sync Run Hygiene

Scope
- Adds composite sync_runs indexes matching production cron overlap/resume/status lookups.
- Reaps stale CRON RUNNING rows older than 15 minutes for the five production sync datasets.
- Centralizes ongoing stale-run recovery inside kpropCronSyncMayStart.
- Preserves Build 9.5.1 no-op UPSERT write guards.
- Preserves Build 9.5.2 bounded/resumable PITCHER_GAME_LOGS behavior.

Not changed
- Pitcher/stat parsing or stored baseball-stat semantics.
- Model logic, v14 calibration, promotion/rollback, or post-promotion guardrail.
- Board grading/closing/creation logic.
- Provider schedules/cadences.

The one-time stale-row update changes only sync_runs operational audit state from RUNNING to FAILED for abandoned CRON rows. It does not delete data or alter baseball stats.
