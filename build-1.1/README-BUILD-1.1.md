# MLB K-Prop Release 3.0 — Build 1.1

## Purpose

Build 1.1 adds the controlled model-versioning foundation without changing current v13 calculations, grading, Board Editor behavior, or user-facing recommendations.

## Added

- Extended `model_versions` registry with production/challenger lifecycle metadata
- `model_predictions`: immutable production, shadow, and backtest prediction ledger
- `model_feature_values`: exact feature values associated with each prediction
- `sync_runs`: generalized ingestion run history
- `sync_errors`: row/run-level ingestion errors
- `data_source_status`: current health and freshness by source/dataset
- Supporting indexes and an audit marker

## Preserved

- Existing `recommendations` remains the production-facing current-state record
- Existing `feature_snapshots` remains untouched
- Existing `automation_runs` remains untouched
- v13 remains active and is labeled `PRODUCTION`
- No Worker or front-end behavior changes are included

## Deployment

Run `Deploy-Build-1.1.ps1` from PowerShell. It creates a timestamped remote D1 export before applying migrations, then runs validation.

## Rollback

The preferred rollback is importing the timestamped pre-build export created in the `backups` folder. The included logical rollback SQL removes the additive tables, but it cannot remove columns added to `model_versions`; a database restore is the complete rollback.
