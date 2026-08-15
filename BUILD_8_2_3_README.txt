MLB K-Prop Release 3.7 - Build 8.2.3

Historical Context Certification Correlated-Join Hotfix

- Fixes SQLite correlation failure in the 8.2.2 pitcher/date mapping query.
- Moves the raw_pitcher_game_logs lookup into scalar SELECT expressions where outer backtest row columns are valid.
- Re-runs legacy/8.2.2 certifications using mapping_version pitcher-game-log-v2.
- Preserves all historical context snapshots and backfill progress.
- Research-only. Production v13 and live v14 unchanged.
