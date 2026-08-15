Release 3.4 / Build 5.5.1 — Learned Challenger Fold-Date Hotfix

Purpose
- Fix Build 5.5 API failure caused by querying backtest_folds.test_date, a column that does not exist.
- The canonical fold date column is backtest_folds.test_date_min.
- Preserve the research model, anti-lookahead rules, v13 production, and live v14 5.1 baseline unchanged.

Fixes
- Manifest query now selects test_date_min AS test_date.
- Per-date fold lookup now matches test_date_min.
- Learned challenger UI now surfaces non-JSON API failures more clearly.

No D1 migration is required.
