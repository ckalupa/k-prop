MLB K-Prop Release 3.3 - Build 4.2
Walk-Forward Backtesting

Adds a chronological, leakage-safe backtest engine. Each test fold uses only certified/eligible dataset rows from dates strictly before the test date. Folds that do not meet minimum prior-date and prior-row requirements are stored as SKIPPED rather than producing misleading metrics.

Default minimums: 5 prior dates and 50 prior rows.
No production model behavior changes.
