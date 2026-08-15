MLB K-Prop Release 3.3 - Build 4.1.2.3
Historical Game Match + Cutoff Hydration

- Fixes legacy boards whose board_date is the day before linked game_date.
- Resolves missing MLB gamePk using games.game_date + away/home teams.
- Persists exact MLB gamePk and scheduled first pitch on legacy games.
- Certification then requires legacy snapshots/recommendations to predate exact first pitch.
- Certification policy version: backfill-certification-v4.
- Native prop_feature_snapshots are not modified.
- No D1 migration is required.
