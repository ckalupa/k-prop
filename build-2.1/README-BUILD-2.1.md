# Release 3.1 — Build 2.1

Adds a controlled MLB Stats API schedule/game ingestion pipeline beside the existing board workflow.

- Safe upserts into the existing `games` table
- Immutable raw snapshots only when source payload changes
- Probable starter identity and handedness
- Final scores and detailed game states
- `sync_runs`, `sync_errors`, and `data_source_status` integration
- Manual admin sync/status API and page
- Cron execution every 30 minutes through the existing 5-minute trigger

The current recommendation and grading paths are unchanged.
