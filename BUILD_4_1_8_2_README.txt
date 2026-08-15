MLB K-Prop Release 3.3 - Build 4.1.8.2

Archive Reconstruction Cloudflare Resilience

- No schema or model changes.
- Keeps one archived prop per Worker invocation.
- Adds slower pacing between reconstruction requests.
- Adds longer exponential retry/backoff for Cloudflare 503/429/5xx/52x responses.
- After an exhausted transient retry window, verifies whether the row committed before retrying.
- If no row committed, performs progressively longer cooldown cycles and retries the same row instead of immediately stopping.
- Refreshes the heavy status view only every 10 completed rows.
- Native snapshots and production v13 predictions remain untouched.
