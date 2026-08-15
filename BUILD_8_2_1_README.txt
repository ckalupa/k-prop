Release 3.7 Build 8.2.1 — Context Backfill Sync Mode Hotfix

- Fixes GAME_CONTEXT_BACKFILL sync_runs.sync_mode from invalid HISTORICAL to allowed BACKFILL.
- No migration.
- No reset.
- Preserves any existing context snapshots and certification state.
- v13 and live v14 remain unchanged.
