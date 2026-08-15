MLB K-Prop Release 3.5 - Build 6.3
Chronological Lineup Challenger Replay

Purpose
- Test whether actual nine-hitter lineup strikeout propensity adds predictive value beyond the existing team-level matchup rate.
- Keep production v13 and live v14 unchanged.

Research provenance
- NATIVE_PREGAME: only a stored lineup snapshot captured at or before scheduled game start. Timestamp-certified.
- RECONSTRUCTED_ACTUAL: actual batting order recovered from the MLB game feed. Useful for research but NOT independently timestamp-certified as pregame; never promotion evidence by itself.

Replay method
- Uses TEST rows from the latest walk-forward-v2 run only.
- Processes one unseen test date per request.
- Batter handedness profiles use stats through the prior day only.
- Replaces the old team matchup multiplier with the lineup-specific multiplier while leaving the pitcher-side projection signal intact.
- Reports overall performance, disagreement performance, monthly stability, and lineup-vs-team delta buckets.

Admin page
https://admin.mlb.kalupa.net/lineup-challenger.html
