# V12 bounded history calibration

This upgrade keeps the V11 projection engine intact and adds two bounded layers.

## Same-opponent context

- Uses only starts before the board date.
- Requires at least two prior starts before changing a projection.
- Recency-weighted using the five most recent qualifying starts.
- Reliability is reduced for small samples.
- Final projection adjustment is capped at +/-0.25 strikeouts.
- Zero or one prior start is displayed but produces no adjustment.

## Historical calibration

- Historical results never directly change projected strikeouts.
- Calibration changes the 0-100 recommendation score only.
- Uses results strictly before the current board date.
- Searches hierarchical samples: side + prop type + nearby line, then side + nearby line, then side.
- Requires 20, 30, or 40 settled results depending on scope.
- Applies Bayesian shrinkage toward 50% using 30 prior observations.
- Score adjustment is capped at +/-4 points.
- Existing role, volume, sample, and side-availability blockers remain enforced.

## Deployment

From the project root:

```powershell
npx wrangler d1 migrations apply mlb-k-prop-prod --remote
npx tsc --noEmit
npx wrangler deploy
```

Do the migration before deploying the Worker because the new Worker reads and writes the new columns.

## Validation

Check the active model:

```powershell
npx wrangler d1 execute mlb-k-prop-prod --remote --command "SELECT model_version_id, version_name, is_active FROM model_versions ORDER BY model_version_id DESC LIMIT 5;"
```

Expected active version: `v12-bounded-history-calibration`.

Process or refresh a DRAFT board, then inspect the Scorecard. It now shows base projection, matchup projection, same-opponent adjustment, and historical calibration sample.
