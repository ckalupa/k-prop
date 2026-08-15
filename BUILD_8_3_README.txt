MLB K-Prop Release 3.7 - Build 8.3
Context Feature Engineering

Purpose
- Convert Build 8.2 historical context certifications into immutable replay-ready feature rows.
- Preserve strict provenance separation between structural pregame context and retrospectively reconstructed observed context.
- Do not alter production v13 or the live v14 calibrated challenger.

Feature version: context-v1

Derived fields
- venue / roof type
- day/night and is_night
- temperature and temperature_delta_70
- weather group: CLEAR, CLOUDY, WET, WINTER, ROOF_CLOSED, OTHER, UNKNOWN
- wind direction group: OUT, IN, CROSS, CALM, VARIABLE, OTHER, UNKNOWN
- roof-closed flag
- home-plate umpire identity
- source and feature quality
- explicit retrospective provenance and promotion_eligible=0

Historical exclusions from Build 8.2 are retained as SOURCE_EXCLUDED feature rows. They are not guessed or repaired.
No game outcomes are used to derive context features.

Admin page:
https://admin.mlb.kalupa.net/context-features.html

Next planned step: Build 8.4 context challenger replay.
