MLB K-Prop Release 3.6 - Build 7.1
Statcast Data Foundation

Adds, without changing production v13 or live v14:
- statcast_pitch_events: immutable pitch-level storage keyed by game/AB/pitch.
- statcast_pitcher_game_metrics: per-game whiff, swinging-strike, CSW, chase, velocity, spin, and pitch-mix metrics.
- statcast_pitcher_daily_features: anti-lookahead daily feature store for future challenger research.
- statcast_source_state: source freshness/cursor/failure state.
- /statcast-sync.html admin foundation status page.
- /api/statcast/foundation read-only status endpoint.

Build 7.1 intentionally does NOT ingest an external Statcast source yet. Build 7.2 will add bounded ingestion after source behavior is validated. This prevents us from coupling model logic to an unverified feed.

Safety:
- Additive migration only.
- No v13 changes.
- No live v14 changes.
- No prediction or board-processing changes.
- Future daily Statcast features must use only pitches before feature_date.
