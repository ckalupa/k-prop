K-PROP BUILD 9.5.2 - PITCHER GAME LOG BOUNDED RESUME

Scope:
- PITCHER_GAME_LOGS only.
- Cron batches are limited to 6 games.
- Cron resumes from next_offset every 10 minutes.
- Stale CRON PITCHER_GAME_LOGS RUNNING rows older than 15 minutes are recovered as FAILED.
- Existing Build 9.5.1 unchanged-row UPSERT guard is preserved.
- ADMIN/API/MANUAL full-range behavior is preserved when no batch options are supplied.
- Other production sync jobs are unchanged.

No D1 migration.
No model, calibration, promotion, rollback, guardrail, or model-role changes.
