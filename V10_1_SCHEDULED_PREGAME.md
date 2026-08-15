# V10.1 Scheduled Pregame Automation

## What it does

- Runs a Cloudflare Cron Trigger every five minutes.
- Finds today's DRAFT or ACTIVE board using America/Chicago calendar dates.
- Reads the official MLB schedule and identifies games 12-18 minutes from first pitch.
- Refreshes only props belonging to those games.
- Updates official starter, lineup, weather, and home-plate umpire availability.
- Captures the latest stored prop line as `closing_line` near first pitch.
- Fills `final_classification` from `initial_classification` only when no manual final classification exists.
- Preserves Final Card, Played, and all manual overrides.
- Keeps the existing morning auto-grading cron schedules unchanged.

## Deploy

```powershell
npm ci
npx tsc --noEmit
node --check .\public\board-editor.js
npx wrangler deploy
```

Cron Trigger changes may take several minutes to become active after deployment.

## Verify

```powershell
npx wrangler triggers
npx wrangler tail
```

The tail output will include `AUTO_PREGAME` when a game is within the target window.
