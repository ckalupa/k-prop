MLB K-Prop Release 3.6 - Build 7.4.3

Statcast backfill feature/certification resilience hotfix.

- Backfill daily feature generation now targets only pitchers present in that walk-forward TEST date instead of every Statcast pitcher in the prior 30 days.
- Removes one per-pitcher existence query from feature generation to stay under Worker/D1 subrequest limits.
- Certification now processes one feature date per Worker request so Run all remaining can advance incrementally without a giant single invocation.
- Existing 118/118 Statcast ingestion and completed feature dates are preserved.
- Anti-lookahead rules are unchanged.
- Production v13 and live v14 remain unchanged.
