# MLB K-Prop Release 3.0 — Build 1.2

## Purpose

Build 1.2 adds the controlled shadow-prediction execution framework while preserving v13 as the only production-facing model.

## Runtime behavior

- The enabled `PRODUCTION` model continues to populate `recommendations` and `feature_snapshots` exactly as before.
- Each production refresh is also appended to the immutable `model_predictions` ledger.
- Enabled `CHALLENGER` models run after production and write only to `model_predictions` and `model_feature_values`.
- Shadow failures are captured independently and cannot block or overwrite production recommendations.
- Models can be enabled or disabled using the runtime API.

## Shadow plumbing model

The migration creates `v13-shadow-plumbing`, an enabled challenger using `production_mirror_v1`.

This is intentionally **not v14** and is not presented as a better model. It validates:

- parallel production/shadow execution
- immutable prediction capture
- exact feature-value capture
- independent error records
- enable/disable controls

A future challenger adapter can replace the mirror adapter without changing the production-facing tables.

## Runtime API

- `GET /api/models/runtime`
- `PATCH /api/models/{model_version_id}/runtime`

PATCH body:

```json
{ "execution_enabled": false }
```

The production model cannot be disabled through this endpoint.

## Deployment

Use `Install-MLB-Build-1.2.ps1` beside the release ZIP. It extracts, backs up source and D1, installs files, applies migration 0017, validates, and deploys the Worker.
