Release 3.2 - Build 3.3.2
Prop Feature Snapshot Refresh Safety Hotfix

Fixes a foreign-key regression introduced by immutable prediction history.
The production board processor previously deleted the current legacy feature_snapshot
before inserting its refreshed replacement. Once model_predictions began referencing
that snapshot, the delete correctly failed under foreign-key enforcement.

Build 3.3.2 changes feature_snapshots to append-only behavior during board refreshes.
Existing readers already select the newest snapshot by snapshot_time/id, so production
recommendations remain current while historical model_predictions retain valid immutable
references.

No D1 migration is required.
