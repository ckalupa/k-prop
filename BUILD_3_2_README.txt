MLB K-Prop Release 3.2 - Build 3.2
Team Daily Features

Adds a model-ready daily team feature store derived from corrected handedness splits.
The live v13 recommendation path is unchanged.

Key rules:
- One row per team/date/pitcher-hand.
- Uses the latest completed split snapshot strictly BEFORE the feature date.
- Preserves season, 30-day, 14-day, and 7-day K rates and sample sizes.
- Computes a weighted recent K rate (50% L7, 30% L14, 20% L30).
- Adds recent-vs-season deviation, trend direction, stability, sample-size score, and data-quality flags.
- Runs after pitcher feature generation on the existing cron.
