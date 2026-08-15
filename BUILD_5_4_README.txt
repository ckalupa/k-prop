MLB K-Prop Release 3.4 / Build 5.4
Feature & Error Diagnostics + v14 Baseline Restore

Why this build exists
- Build 5.3 adaptive selection hit 52.2% on 159 historical PLAYs versus 54.4% overall.
- LESS adaptive PLAYs were especially weak (42.3%).
- Build 5.4 therefore rejects the 5.3 adaptive policy for live use and restores v14 to the Build 5.1 calibrated baseline.

Changes
- v13 remains the sole production model.
- v14 remains shadow-only and returns to shadow-adapter:v14-baseline-calibrated-v1.
- Live v14 prediction capture again uses the Build 5.1 probability and PLAY/WATCH rules.
- Adds /feature-diagnostics.html and /api/backtests/feature-diagnostics.
- Diagnostics analyze executed walk-forward TEST rows only and compare winner vs loser feature distributions plus quartile hit rates.
- Build 5.3 replay remains visible on the comparison page as rejected research evidence.

Safety
- No automatic model promotion.
- No production v13 scoring changes.
- Diagnostics are retrospective/read-only and never alter thresholds or predictions.
