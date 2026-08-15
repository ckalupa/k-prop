Release 3.7 - Build 8.2
Historical Game Context Backfill + Certification

- Backfills game context for the executed walk-forward-v2 TEST dates only.
- Processes four MLB games per Worker request and is safely resumable.
- Reuses the Build 8.1 context schema and records source_mode=HISTORICAL_BACKFILL.
- Certifies each eligible historical backtest row against its MLB game context snapshot.
- Historical context is explicitly labeled retrospective reconstruction; it is research-only evidence.
- Production v13 and live v14 are unchanged.
- New admin page: /context-backfill.html
