# v9 Recommendation Lifecycle + Postgame Upgrade

## What changed

- Added migration `0009_recommendation_lifecycle_postgame.sql`.
- Added recommendation lifecycle fields for initial/final classification, final-card inclusion, actually played, line movement, finalization time, completeness, and pregame checks.
- Automatic grading now copies official MLB workload into `prop_results`: innings pitched, pitch count, batters faced, and starter status.
- Automatic grading stores a suggested postgame diagnosis while leaving the final diagnosis reviewable.
- Board Editor now supports lifecycle editing, final-card/played flags, line tracking, completeness checks, workload display, and postgame review.
- Added API endpoints:
  - `PATCH /api/props/:propId/lifecycle`
  - `PATCH /api/props/:propId/postgame-review`

## Safe deployment order

1. Back up/export the remote D1 database.
2. Inspect the current schema before applying the migration:

   ```powershell
   npx wrangler d1 execute mlb-k-prop-prod --remote --command "PRAGMA table_info(recommendations);"
   npx wrangler d1 execute mlb-k-prop-prod --remote --command "PRAGMA table_info(prop_results);"
   ```

3. Install dependencies on the machine where you will run Wrangler:

   ```powershell
   npm ci
   ```

4. Apply and test locally:

   ```powershell
   npx wrangler d1 migrations apply mlb-k-prop-prod --local
   npx tsc --noEmit
   npx wrangler dev
   ```

5. Apply remotely only after local validation:

   ```powershell
   npx wrangler d1 migrations apply mlb-k-prop-prod --remote
   npx wrangler deploy
   ```

## Validation performed in the build environment

- TypeScript compilation passed after the Worker/API changes.
- `public/board-editor.js` passed `node --check` after the UI changes.
- Migration 0009 applied successfully to a fresh SQLite schema built from migrations 0001 and 0003–0008.
- A full Wrangler local run could not be completed in the build environment because the uploaded `node_modules` contained Windows-native Cloudflare binaries, and the environment could not redownload Linux-native dependencies.

## Suggested reason-code behavior

The grader proposes one of these values:

- `ROLE_CHANGE`
- `LOW_PITCH_COUNT`
- `LOW_BATTERS_FACED`
- `POOR_COMMAND`
- `BLOWUP_OUTING`
- `LINE_ACCURATE`
- `NORMAL_VARIANCE_REVIEW`

The suggestion is deliberately not treated as the final diagnosis. The editor requires a separate saved postgame review.
