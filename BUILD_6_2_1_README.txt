MLB K-Prop Release 3.5 - Build 6.2.1
Lineup Feature Hardening

- Resolves opposing probable-pitcher hand from the MLB live feed when the games table is missing it.
- Re-syncs lineup snapshots before feature construction so new immutable snapshots carry L/R pitcher context.
- Adds prior-day batter strikeout profiles split by opposing pitcher hand (vs LHP / vs RHP).
- Adds lineup-k-v2 with explicit handedness coverage, generic-profile fallbacks, league fallbacks, PA counts, and quality flags.
- Keeps v13 production and live v14 unchanged.
- Research/data only. Build 6.3 will test whether these features improve chronological out-of-sample performance.
