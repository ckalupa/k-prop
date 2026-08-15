MLB K-Prop Release 3.7 - Build 8.2.4
Historical Context Matchup Metadata + Certification Repair

- Enriches HISTORICAL_BACKFILL snapshots with MLB home/away team identity in details_json.
- Maps historical TEST rows directly by archived date + team/opponent matchup to context snapshots.
- Avoids legacy games/probable-pitcher bridges.
- Excludes ambiguous pitcher/date rows with conflicting opponents rather than guessing.
- Reprocesses completed dates missing matchup metadata in the same four-game batches.
- Keeps historical context retrospective/research-only.
- Production v13 and live v14 unchanged.
