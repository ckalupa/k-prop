MLB K-PROP PLATFORM - RELEASE 3.8 BUILD 9.6.2

Purpose
- Make MORNING_GRADE bounded, resumable, and self-retrying.
- Prevent orphaned RUNNING automation rows from remaining indefinitely.
- Auto-generate board names as PrizePicks YYYY-MM-DD from board_date.

Automation changes
- Cron grading runs every 10 minutes from 6:00 through 10:50 AM America/Chicago while the prior board remains open.
- Each scheduled pass processes at most 6 pending pitchers/props.
- The cron grading loop is truly bounded; pending props outside the current batch cannot trigger game-feed fallback calls in that invocation.
- RUNNING MORNING_GRADE rows older than 8 minutes are marked FAILED with STALE_RUNNING_REAPED details before retry.
- A non-stale RUNNING row blocks overlapping work.
- Successful partial passes remain SUCCESS and the next cron tick resumes automatically until pending reaches zero.
- Manual Grade Results remains an unbounded fallback path.

Board naming changes
- Server derives board_name from board_date for create and update.
- Board Editor shows the generated name read-only and updates it when board date changes.

Safety
- No migration.
- No model-role change.
- No v14 calibration/recommendation logic change.
- No promotion or rollback.
- No guardrail reset.
- v14 remains PRODUCTION and v13 remains the preserved rollback target.
