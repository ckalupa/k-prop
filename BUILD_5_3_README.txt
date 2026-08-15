MLB K-Prop Platform — Release 3.4 / Build 5.3
Adaptive Challenger Selection

Goal
- Improve v14 PLAY/WATCH selection without fitting rules to the completed backtest.
- Keep v13 as the sole production model.
- Keep v14 shadow-only.

Build 5.3 policy
1. Build 5.1 side-specific leakage-safe calibration remains the probability anchor.
2. For every target date, adaptive evidence uses only eligible rows with board_date strictly before that target.
3. Four segment families are considered:
   - side × absolute-edge bucket
   - side × prop-line bucket
   - absolute-edge bucket
   - pitcher hand
4. Each segment must clear a minimum historical sample before it can contribute.
5. Segment hit rates use Beta(25,25) shrinkage toward 50%.
6. Segment evidence is reliability-weighted and only partially blended into the calibrated baseline.
7. Adaptive probability is capped at 62%.
8. Sparse evidence receives an uncertainty penalty.
9. PLAY requires an adaptive selection score of at least 55%; otherwise WATCH.
10. No direction is flipped in this build. Selection is the only behavioral target.

Comparison dashboard
/model-comparison.html now reports:
- v13 all rows
- Build 5.1 calibrated all rows
- Build 5.1 PLAY subset
- Build 5.3 adaptive PLAY subset
- side and edge breakdowns
- monthly stability
- unit drawdown and longest losing streak
- live v13/v14 shadow pairs

Safety
- v13 model role is untouched.
- v14 remains CHALLENGER / SHADOW.
- No historical rows are mutated by the comparison endpoint.
- Promotion remains manual.
