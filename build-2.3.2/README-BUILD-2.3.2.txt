MLB K-Prop Release 3.1 - Build 2.3.2
Team Split Subrequest Safety Hotfix

Changes:
- Forces one canonical MLB team per team-split Worker invocation.
- Admin control now syncs one team at a time.
- Cron processes one team every 10 minutes using the existing */5 trigger.
- Prevents the initial 30-day play-by-play cache warmup from exceeding Cloudflare's per-invocation subrequest limit.
- No database migration is required.
