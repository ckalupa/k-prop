MLB K-Prop Release 3.6 - Build 7.5
Statcast Challenger Replay

- Research-only chronological challenger using certified Statcast daily features.
- Training uses only certified rows with board_date strictly before each target test date.
- Ridge logistic model combines baseline projection context with Whiff%, SwStr%, CSW%, Chase%, velocity/trend, spin, fastball mix, and sample quality.
- Persists one replay date at a time and resumes safely.
- Scorecard includes baseline vs challenger hit rate, disagreements, improved vs harmed, PLAY subset, month, side, quality, and velocity-trend segments.
- v13 production and live v14 remain unchanged.
