Release 3.1 - Build 2.4: Sync Health Dashboard

Adds a unified Access-protected ingestion dashboard at:
https://admin.mlb.kalupa.net/sync-health.html

Includes:
- Overall ingestion health
- Schedule, pitcher-log, and team-split source cards
- Freshness-aware effective status
- Stored row counts and consecutive failures
- Team split rotation progress
- Recent sync runs across all three datasets
- Recent sync errors
- Safe Run now controls that call the existing sync endpoints
- Navigation links from the existing ingestion/admin pages

This build is code/assets only. No D1 migration is required.
