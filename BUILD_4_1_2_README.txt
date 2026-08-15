MLB K-Prop Release 3.3 - Build 4.1.2
Backfill Certification

Adds a separate certification ledger for historical reconstructions and keeps native forward snapshots untouched.

Certification classes:
- RECONSTRUCTED_A: clean reconstructed pitcher history plus usable dated opponent/model context.
- RECONSTRUCTED_B: useful reconstructed history with weaker legacy context; retained only for expanded sensitivity testing.
- INCOMPLETE: excluded from backtesting.

Historical dataset modes:
- STRICT: NATIVE only.
- CERTIFIED: NATIVE + RECONSTRUCTED_A.
- EXPANDED: NATIVE + RECONSTRUCTED_A + RECONSTRUCTED_B.

The dataset table records source_provenance and uses either a native prop_feature_snapshot_id or a historical_reconstruction_id. Reconstructed history is never inserted into prop_feature_snapshots.

Admin page:
https://admin.mlb.kalupa.net/backtest-certification.html

Workflow:
1. Finish/re-run historical reconstruction as needed.
2. Open Backfill Certification and click Certify latest reconstructions.
3. Open Backtest Dataset and build CERTIFIED first.
4. Re-run Walk-Forward against the newest dataset.
5. Use EXPANDED as a sensitivity comparison; do not treat it as equivalent to NATIVE.
