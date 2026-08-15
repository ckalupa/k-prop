# Plays page board-loading fix

This build fixes `/api/plays` so board selection is not blocked by an error in slip history, bankroll totals, or one optional query.

Changes:
- board list query is isolated and uses explicit GROUP BY columns
- selected-board recommendations use a compatibility-safe result status
- tracking history, totals, and bankroll queries fail independently and return warnings instead of a page-wide 500
- `admin.mlb.kalupa.net` remains configured as a Worker custom domain
- historical boards remain available for backfilled entries and immediate settlement

No database migration is required.
