Release 3.7 - Build 8.1.2
Game Context Status Update Hotfix

Fixes the post-batch HTTP 500 caused by Build 8.1.1 attempting to update a nonexistent data_source_status.last_error column.

The context rows and sync_runs were already being stored correctly. This hotfix updates only valid data_source_status fields, records last_sync_run_id and metadata_json, and preserves staged four-game batches.

No schema changes. No production model changes. Existing context snapshots are preserved.
