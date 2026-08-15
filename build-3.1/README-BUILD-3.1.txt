MLB K-Prop Release 3.2 - Build 3.1
Pitcher Daily Features

Adds pitcher_daily_features and a controlled derived-feature build pipeline.
Features are computed using only starts with game_date earlier than as_of_date.
The pipeline prefers raw_pitcher_game_logs and falls back to the existing pitcher_game_stats history when raw ingestion has not yet backfilled the full season.
No production v13 recommendation logic is changed by this build.
