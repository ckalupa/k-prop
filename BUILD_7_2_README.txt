MLB K-Prop Release 3.6 - Build 7.2
Statcast One-Date Ingestion

Adds:
- POST /api/statcast/sync-date for a deliberately bounded one-date validation ingest.
- Official MLB Baseball Savant Statcast Search CSV as the source.
- Immutable INSERT OR IGNORE pitch-event persistence keyed by game/AB/pitch.
- Pitcher-game aggregates: whiff%, swinging-strike%, CSW%, chase%, FF/SI/FC velocity and spin, pitch mix, quality score.
- Source health/cursor/error tracking in statcast_source_state.
- Updated /statcast-sync.html with date picker, sync button, source details, and recent pitcher-game metrics.

Validation definitions:
- Swing: swinging strike, foul, foul tip, ball put in play, and bunt swing outcomes.
- Whiff: swinging_strike, swinging_strike_blocked, missed_bunt.
- In-zone: Statcast zone 1 through 9.
- Chase: swing on a pitch with a Statcast zone outside 1 through 9.
- Whiff rate: whiffs / swings.
- Swinging-strike rate: whiffs / all pitches.
- CSW rate: (called strikes + whiffs) / all pitches.
- Fastball family: FF, SI, FC.

Safety:
- Build 7.2 does not populate daily model features.
- No backfill is started automatically.
- No production v13 or live v14 behavior changes.
- Run one completed date first and inspect the metrics before broadening ingestion in Build 7.3/7.4.
