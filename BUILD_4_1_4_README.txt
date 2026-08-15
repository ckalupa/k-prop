MLB K-Prop Release 3.3 - Build 4.1.4
Historical Opponent Reconstruction

Purpose
- Extend Build 4.1.3's pregame-safe pitcher reconstruction with opponent strikeout context.
- Reconstruct only completed games before the historical board date.
- Use actual opposing pitcher handedness from MLB play-by-play.
- Preserve native forward snapshots and legacy postgame records without consuming them.

Historical features
- Opponent K rate vs pitcher handedness over trailing 7 days.
- Opponent K rate vs pitcher handedness over trailing 14 days.
- Opponent K rate vs pitcher handedness over trailing 30 days.
- Shrunk/weighted recent K rate, trend, sample confidence, handedness edge.
- v13-style matchup multiplier applied to the Build 4.1.3 pitcher-only projection.
- Research-only adjusted projection, edge, over probability, and preferred side.

Subrequest safety
- API processes exactly one historical opponent per Worker invocation.
- Admin page can chain up to 10 sequential invocations (default 5).
- Missing play-by-play is cached in team_game_handedness_batting.
- Already-cached games are reused without another MLB play-by-play request.

Trust boundary
- Native prop_feature_snapshots modified: NO.
- Legacy feature_snapshots used: NO.
- Legacy recommendations used: NO.
- Current/future team_daily_features used: NO.
- Current season handedness stats used: NO.
- Only games with official_date < historical board_date are eligible.
- Season-long historical handedness is intentionally NOT reconstructed in this build.

Status
- RESEARCH_READY: valid opponent/team/hand context plus at least 50 trailing-30-day PA vs that hand.
- INCOMPLETE: hard context missing or trailing handedness sample too small.
- This build remains research-only and does not auto-promote rows into CERTIFIED backtests.

Admin
https://admin.mlb.kalupa.net/backtest-opponent-reconstruction.html
