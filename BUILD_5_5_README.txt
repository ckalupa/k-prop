Release 3.4 / Build 5.5 — Regularized Directional Challenger

Purpose
- Test a genuinely independent directional v14 candidate instead of filtering the v13 direction.
- Train a ridge-regularized logistic model separately for every historical test date using only earlier certified rows.
- Preserve v13 production and the live v14 Build 5.1 calibrated baseline until the learned candidate proves itself.

Features
- raw MORE probability
- signed / absolute / curved projection margin
- prop line and pitcher hand
- L3/L5/L10 strikeout form and L3-L10 delta
- K per batter faced, batters faced, innings, pitch count, prior-start sample
- opponent weighted/30-day K rate and matchup multiplier

Safeguards
- chronological anti-lookahead: board_date strictly before target
- standardized features with prior-only mean imputation
- ridge regularization
- conservative probability shrinkage and 38%-62% cap
- minimum 100 training rows
- research-only 55% PLAY threshold
- no production or live challenger behavior changes

Admin page
https://admin.mlb.kalupa.net/learned-challenger.html
