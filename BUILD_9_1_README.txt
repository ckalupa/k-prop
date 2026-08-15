MLB K-Prop App — Release 3.8 Build 9.1
Promotion Governance Foundation

Purpose
- Begin Release 3.8 without changing production behavior.
- Define explicit promotion gates for v14-baseline-challenger.
- Show current historical/live evidence and whether each gate is evaluable/pass/fail.
- Allow immutable readiness snapshots for audit/history.
- No endpoint in Build 9.1 can promote, demote, swap roles, or disable v13.

Promotion Gate v1
- >=1000 certified historical paired rows.
- >=200 live graded production/shadow pairs.
- >=14 distinct live graded dates.
- v14 live hit rate no more than 1.0 percentage point below v13 after minimum live sample.
- v14 live Brier no worse than v13 after minimum live sample.
- |v14 live calibration gap| <=5 percentage points after minimum live sample.
- zero challenger runtime failures.
- explicit manual approval remains required even after every technical gate passes.

Admin page
https://admin.mlb.kalupa.net/promotion-readiness.html

Important
- Build 9.1 is observation-only.
- Production v13 and live v14 runtime roles are unchanged.
- Historical lineup/Statcast/context research-only evidence is not silently promoted into live promotion evidence.
