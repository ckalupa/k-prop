MLB K-Prop Release 3.6 - Build 7.3
Statcast Daily Features

- Builds model-ready rolling Statcast features from pitcher-game metrics.
- Strict anti-lookahead: only game_date < feature_date is eligible.
- Rolling rates are numerator/denominator weighted across up to the last 5 games.
- Velocity trend compares recent 2-game fastball velocity with the available 30-day baseline.
- Pitch mix is aggregated across the same last-5-game window.
- Sample-size quality is explicit; sparse samples remain research-only.
- Production v13 and live v14 are unchanged.
