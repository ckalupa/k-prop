MLB K-Prop Release 3.3 - Build 4.1.7
Archive Historical Reconstruction

Purpose
- Reconstruct archived July 8, July 9, July 17, and July 18 props using only information available before each board date.
- Combine pre-date pitcher history with opponent strikeout context versus pitcher handedness.
- Keep all reconstructed archive history isolated from native prop_feature_snapshots and production model decisions.

Safety
- Pitcher history uses pitcher_game_stats.game_date < board_date.
- Opponent windows use official MLB game dates strictly before board_date.
- No legacy postgame model snapshots or recommendations are read.
- Native props/snapshots are not modified.
- One archive prop is processed per Worker invocation to avoid Cloudflare subrequest limits; the admin page chains requests sequentially.
