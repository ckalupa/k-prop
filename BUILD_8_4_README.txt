MLB K-Prop App — Release 3.7 Build 8.4
Context Challenger Replay / Diagnostics

Purpose
- Chronological, anti-lookahead replay over Build 8.3 context-v1 features.
- Evaluate directional context changes separately from confidence/filter utility.
- Production v13 and live v14 remain unchanged.

Method
- Every target date trains only on FEATURE_READY context rows with board_date strictly before the target date.
- At least 80 prior rows are required before a date is scored.
- Baseline-correctness estimates use prior-only day/night, roof, weather, wind, temperature-band and umpire segments with minimum-sample shrinkage.
- BOOST / SUPPRESS requires >=2 qualifying segments and a >=3.5 percentage point shift from the prior global baseline hit rate.
- Direction flips require >=3 qualifying segments and estimated baseline correctness <=46%.
- Historical context remains retrospective reconstruction and research-only.

Admin page
https://admin.mlb.kalupa.net/context-challenger.html
