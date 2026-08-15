Release 3.7 Build 8.2.2 — Historical Game Mapping Fix

- Maps historical walk-forward TEST rows to MLB games by pitcher + board date using raw_pitcher_game_logs starter records.
- Falls back to legacy prop -> game mapping only when available.
- One-time re-certifies completed dates created by Build 8.2/8.2.1 using mapping_version pitcher-game-log-v1.
- Preserves historical context snapshots and completed backfill work.
- Updates Context Backfill UI/API build label to 8.2.2.
- Research-only. Production v13 and live v14 remain unchanged.
