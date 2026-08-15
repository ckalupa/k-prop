Release 3.6 - Build 7.4.1
Statcast Historical Backfill pacing hotfix

- Preserves all Build 7.4 data and completed dates.
- Slows Baseball Savant historical ingestion to one date every 20 seconds.
- Adds long retry backoff for transient HTTP 429/5xx responses: 60s, 180s, 600s.
- Shows a live cooldown countdown in the admin page.
- Feature building and certification remain fast once source ingestion is complete.
- No migration. No model changes. v13 production and live v14 are unchanged.
