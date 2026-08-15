MLB K-Prop Platform — Release 3.4 / Build 5.2
v13 vs v14 Comparison Dashboard

Adds /model-comparison.html and /api/models/comparison.

Historical mode:
- Uses TEST rows from the latest executed walk-forward-v2 run.
- Replays v14-baseline-calibrated-v1 using only eligible historical rows with board_date strictly before each target row.
- Compares v13 vs v14 probability calibration and Brier on identical outcomes.
- Shows v14 PLAY-only subset, side splits, and absolute-edge splits.

Live mode:
- Pairs latest v13 PRODUCTION and v14 SHADOW model_predictions by prop_id.
- Shows probability deltas and graded live metrics when prop_results are available.

Safety:
- v13 remains the sole production model.
- v14 remains a shadow challenger.
- No prediction, recommendation, board, prop, feature snapshot, or model role is modified by the comparison endpoint.
