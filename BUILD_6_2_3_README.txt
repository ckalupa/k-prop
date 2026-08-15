MLB K-Prop Release 3.5 - Build 6.2.3
Batter Profile Coverage

Purpose
- Improve confirmed-lineup handedness-profile coverage before lineup intelligence is backtested.
- Target only hitters missing from the bulk MLB hand-split feed.
- Cache targeted attempts so no-prior-PA hitters are not fetched repeatedly for the same date/hand.

Adds
- Migration 0047_lineup_profile_coverage_backfill.sql
- batter_k_profile_backfill_attempts cache/audit table
- GET /api/features/lineup-k/coverage
- POST /api/features/lineup-k/coverage-backfill
- Small targeted batches of up to 10 hitters per Worker request (UI uses 6)
- Explicit missing-hitter status/reason display on Lineup K Features
- Four-stage admin flow: bulk L, bulk R, targeted gaps, final feature rebuild

Safety
- All stats cut off at the prior calendar date.
- v13 production is unchanged.
- live v14 remains the Build 5.1 calibrated baseline.
- This build remains research/data foundation only.
