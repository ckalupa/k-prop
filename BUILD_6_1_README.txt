MLB K-Prop Platform — Release 3.5 Build 6.1
Lineup Data Foundation

Adds additive, immutable lineup storage:
- mlb_batters
- game_lineup_snapshots
- game_lineup_entries
- MLB_STATS_API / LINEUP_SNAPSHOTS source health

Adds /lineup-sync.html and authenticated APIs:
- GET /api/data-sources/lineups?date=YYYY-MM-DD
- POST /api/data-sources/lineups/sync {"date":"YYYY-MM-DD"}

The sync reads already-known games for the target date, fetches each MLB live feed,
captures the latest official batting order when available, stores batter handedness,
and records UNAVAILABLE snapshots when MLB has not posted a lineup yet.

Build 6.1 is storage/ingestion only. It does not modify production v13, live v14,
feature scoring, recommendations, or grading.
