MLB K-Prop Release 3.3 - Build 4.1.6
Historical Archive Intake

Purpose
- Seed audited historical prop lines/results into a backtest-only archive.
- Add 2026-07-08, 2026-07-09, 2026-07-17, and 2026-07-18.
- 109 archived rows total.
- Keep these rows separate from production boards, props, native snapshots, and predictions.
- Preserve workbook provenance.

This build DOES NOT:
- modify native prop_feature_snapshots
- add historical rows to production props
- change v13 production model behavior
- certify or backtest archive rows yet

Next build:
- Map archive pitcher/team identities to production IDs.
- Run pregame-safe independent pitcher/opponent reconstruction on the archive.
