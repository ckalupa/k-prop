Release 3.2 - Build 3.3.1: Prop Feature Snapshot Safety Hotfix

- Snapshot bookkeeping can no longer fail production board processing.
- Legacy/orphaned opponent_team_id values are not written into the strict snapshot FK column.
- Raw opponent IDs are preserved in context_json for reproducibility.
- No schema migration.
