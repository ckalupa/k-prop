MLB K-Prop Release 3.5 - Build 6.3.1
Lineup Replay Resilience Hotfix

- Keeps the Build 6.3 replay model and provenance rules unchanged.
- Adds automatic retries for transient HTTP 502/503/504 responses.
- Run all remaining now processes one date at a time with retry/backoff.
- Completed dates remain persisted in D1; rerunning resumes at the next unfinished date.
- No schema migration.
- Production v13 and live v14 remain unchanged.
