MLB K-Prop Release 3.3 - Build 4.1.2.2
Historical Schedule Cutoff Hydration

- Hydrates missing games.scheduled_start from the MLB Stats API schedule using existing mlb_game_pk values.
- Certification still uses exact scheduled first pitch as the hard cutoff.
- No inferred midnight/noon cutoff is used.
- Native prop_feature_snapshots are never modified.
- Certification policy version: backfill-certification-v3.
- Re-run Backfill Certification after deployment.
