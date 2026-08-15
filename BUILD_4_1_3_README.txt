MLB K-Prop Release 3.3 - Build 4.1.3
Independent Historical Model Reconstruction

Purpose
- Salvage older graded props without trusting postgame legacy feature snapshots or recommendations.
- Reconstruct only from pregame-safe pitcher_game_stats rows with game_date < board_date.
- Use the original prop line/context, hydrated scheduled first-pitch cutoff, and final result.
- Produce a research-only pitcher baseline projection and edge for historical analysis.

Safety
- Legacy feature_snapshots used: NO.
- Legacy recommendations used: NO.
- Native prop_feature_snapshots modified: NO.
- No reconstructed row is promoted into STRICT or CERTIFIED backtests by this build.
- Team/opponent historical feature reconstruction is intentionally deferred to a follow-up build.

Admin
https://admin.mlb.kalupa.net/backtest-independent-reconstruction.html
