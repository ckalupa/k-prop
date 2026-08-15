MLB K-Prop Release 3.3 - Build 4.1.2.6
Historical Duplicate GamePk Safety Fix

- Fixes certification failures caused by UNIQUE constraint on games.mlb_game_pk.
- Legacy imported game rows can duplicate newer canonical Schedule Sync rows.
- Certification now hydrates the exact scheduled_start cutoff onto the legacy row without copying the unique gamePk.
- Exact MLB schedule matching remains date +/- 1 day plus strict away/home team match.
- Certification policy version: backfill-certification-v7.
- Native prop feature snapshots are not modified.
- No D1 migration is required.
