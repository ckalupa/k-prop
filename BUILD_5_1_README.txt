MLB K-Prop Release 3.4 - Build 5.1
v14 Baseline Challenger

Purpose
- Register v14-baseline-challenger as an enabled SHADOW model.
- Keep v13 as the sole production-facing model.
- Reuse the current production projection/ranking signal, but replace its badly overconfident probability scale with a conservative empirical calibration layer.

Leakage controls
- Calibration training rows come only from the latest successful CERTIFIED historical-dataset-v3 build.
- Only rows with board_date strictly before the target board date are eligible for calibration.
- Calibration is side-specific (MORE / LESS).
- Narrow 5-point probability buckets are preferred; 10-point buckets and side-pooled history are fallbacks.
- Minimum 40 graded historical rows per bucket.
- Beta-binomial shrinkage toward 50%.
- Preferred probability capped at 70%; pooled fallback capped at 62%.

Important
- This is a BASELINE challenger, not a promotion candidate yet.
- No retrospective edge bucket is hard-coded as a good/bad rule.
- v13 production recommendations are unchanged.
- v14 writes only to immutable model_predictions/model_feature_values in SHADOW mode.
- Promotion remains manual.
