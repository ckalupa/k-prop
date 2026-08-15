MLB K-Prop Release 3.1 - Build 2.3.1
Team Strikeout Split Correctness Hotfix

Fixes:
- Build 2.3 used byDateRange with sitCodes. MLB Stats API ignored sitCodes for that stat type, so L/R rows were identical.
- Canonicalizes team aliases so rows such as '@ AZ', AZ/ARI, OAK/ATH, etc. do not create duplicate team batches.
- Season L/R uses stats=statSplits with vl/vr.
- Recent 30/14/7-day L/R is aggregated from final-game MLB play-by-play and cached per game.
- Clears invalid Build 2.3 daily rows and deletes only provably-invalid identical L/R season pairs.
- Reduces rotating batch size from 5 teams to 2 because play-by-play backfill is heavier.

No production model logic is changed by this hotfix.
