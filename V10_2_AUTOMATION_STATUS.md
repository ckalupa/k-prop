# V10.2 Automation Status & Audit

## What changed

- Adds migration `0010_automation_status_audit.sql`.
- Stores MLB game ID, scheduled first pitch, last check time, last successful refresh, per-prop status, and status message.
- Adds an `automation_runs` audit table for pregame checks and morning grading.
- Retries official MLB pregame checks every five minutes from 30 minutes to 5 minutes before first pitch.
- Flags incomplete rows as `STALE` inside 10 minutes of first pitch.
- Displays a board-level automation panel with Ready, Partial, Pending, Stale, timestamps, and recent runs.
- Displays per-prop pregame status and first-pitch time.
- Runs pregame checking and morning grading from the same five-minute cron.
- Morning grading attempts occur at the first five-minute boundary of 6:00, 7:00, and 8:00 AM America/Chicago.

## Safe deployment

```powershell
cd C:\Cloudflare\mlb-k-prop-app
npm ci
npx tsc --noEmit
node --check .\public\board-editor.js
npx wrangler d1 migrations apply mlb-k-prop-prod --local
npx wrangler d1 migrations apply mlb-k-prop-prod --remote
npx wrangler deploy
```

## Verification

1. Open an active board and click **Refresh Pregame Checks**.
2. Confirm the Automation Status panel appears.
3. Refresh the browser and confirm timestamps persist.
4. Use `npx wrangler tail` near first pitch and look for `AUTO_PREGAME`.
5. Confirm `0010_automation_status_audit.sql` is applied with:

```powershell
npx wrangler d1 migrations list mlb-k-prop-prod --remote
```
