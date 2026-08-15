Release 3.6 - Build 7.4.2
Statcast Header-Only CSV Hotfix

- Preserves all Build 7.4 / 7.4.1 backfill progress.
- Accepts a valid Baseball Savant header-only CSV as an EMPTY date.
- Handles quoted CSV headers such as "pitch_type","game_date",... correctly.
- Keeps 7.4.1 Savant pacing and 1/3/10-minute transient retry behavior.
- No migration.
- Production v13 and live v14 remain unchanged.
