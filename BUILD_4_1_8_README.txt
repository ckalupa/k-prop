MLB K-Prop Release 3.3 - Build 4.1.8
Historical Archive Expansion

Purpose
- Expand the separate backtest-only historical archive from the audited master tracker ledger.
- Adds the full usable ledger span from 2026-05-08 through 2026-07-18.
- Existing archive rows are preserved via INSERT OR IGNORE.
- Void/DNP rows remain stored for provenance but are excluded from reconstruction.
- The Build 4.1.7.2 sequential reconstruction runner remains unchanged.
- Production v13, production props, native feature snapshots, and production predictions are untouched.

Expected after migration
- 1,625 unique archive ledger rows from 64 historical dates in the source ledger, subject to existing unique-key dedupe.
- Existing 109 archive rows remain and deduplicate naturally.
- Reconstruction queue grows substantially; use Run all remaining on Archive Reconstruction.
