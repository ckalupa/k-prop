MLB K-Prop Release 3.5 - Build 6.4
Lineup Signal Diagnostics

Purpose
- Diagnose why Build 6.3 lineup substitution underperformed before any further tuning.
- Uses the persisted chronological 6.3 replay only; makes no new historical MLB requests.

Diagnostics
- Decision-change audit: improved vs harmed disagreements.
- Historical hand-profile coverage buckets: 0-2/9, 3-4/9, 5-6/9, 7-8/9, 9/9.
- Coverage x baseline-side disagreement performance.
- Pitcher-hand splits.
- Baseline MORE/LESS splits.
- Signed lineup-vs-team K-rate delta buckets.

Safety
- No schema migration.
- No model parameter or threshold changes.
- Production v13 unchanged.
- Live v14 unchanged.
- Reconstructed historical lineups remain research-only and are not promotion evidence.
