MLB K-Prop Release 3.3 - Build 4.1.1
Historical Feature Reconstruction

Purpose
- Recover useful historical pre-3.3 props without contaminating native forward snapshots.
- Reconstruct pitcher features strictly from pitcher_game_stats rows with game_date < board_date.
- Reuse legacy feature snapshots and recommendations as historical evidence when they exist.
- Classify rows as RECONSTRUCTED_A_CANDIDATE, RECONSTRUCTED_B_CANDIDATE, or INCOMPLETE.

Safety
- Does NOT write to prop_feature_snapshots.
- Does NOT alter native snapshot provenance.
- Does NOT make reconstructed rows backtest eligible yet.
- Build 4.1.2 will certify candidates and integrate approved rows into historical-dataset-v2.

Admin
https://admin.mlb.kalupa.net/backtest-reconstruction.html

Use "Reconstruct next 25" repeatedly until the candidate count is covered.
