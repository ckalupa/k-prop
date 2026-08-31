MLB K-Prop Release 3.8 - Build 9.6
Post-Promotion Guardrail Window

- Anchors the v14 guardrail window to immutable Promotion #1 promoted_at.
- Monitors new v14 PRODUCTION ledger rows only after that boundary.
- Tracks graded sample, dates, hit rate, Brier, calibration, ledger integrity, and runtime/ledger failures.
- Uses frozen certification v14 performance as the comparison baseline.
- States: COLLECTING, HEALTHY, WATCH, ROLLBACK_RECOMMENDED.
- Rollback remains manual. Build 9.6 has no rollback endpoint and never auto-rolls back.
- Cleans the post-promotion header so v14 is not displayed as both Production and Candidate.
- Preserves Build 9.3.2 tracked-play replay, Build 9.4 immutable readiness freeze, and Build 9.5 promotion audit.
