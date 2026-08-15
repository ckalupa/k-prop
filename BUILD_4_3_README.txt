Release 3.3 - Build 4.3 - Performance Metrics

Adds aggregate metrics on the TEST rows of EXECUTED walk-forward folds only.
No skipped fold contributes to performance.

Metrics:
- Hit rate excluding pushes
- Brier score
- 10-bin expected calibration error
- More and Less hit rates
- Average predicted probability
- Picks/day and qualified PLAYs/day
- Max drawdown in one-unit individual-pick units
- Longest losing streak
- 7/14/30-day windows relative to latest executed test date
- Configurable Power/Flex ROI simulations using qualified PLAY rows only

ROI simulation policy:
- Within each test date, qualified PLAY rows are sorted by confidence descending.
- Non-overlapping chunks are formed at the configured leg count.
- Entries containing PUSH/VOID are skipped rather than assuming a payout rule.
- Power: full-win multiplier or zero.
- Flex: full-win multiplier; one configured partial-hit tier; otherwise zero.
- $1 stake per simulated entry, ROI = net / stake.

Defaults are simulation assumptions, not claims about current PrizePicks payouts:
Power: 2 legs, 3.0x full hit
Flex: 3 legs, 2.25x full hit, 1.25x for 2/3
