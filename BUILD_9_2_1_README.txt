MLB K-Prop Release 3.8 — Build 9.2.1
Live Shadow Certification source-eligibility hotfix

- Keeps the existing 9.2 certification session and its original started_at boundary.
- Non-directional v13 source rows are certification-ineligible, not v14 runtime failures.
- Future non-directional source rows create immutable WITHHELD v14 shadow ledger entries instead of FAILED entries.
- Pair-integrity checks require a v14 COMPLETE counterpart only for directional v13 production predictions.
- Existing 9.2 non-directional failure rows remain preserved in the audit ledger but are excluded from the certification runtime-failure gate.
- Adds source exclusion count to Promotion Readiness.
- No promotion/demotion endpoint. v13 remains production; v14 remains shadow-only.
- No migration. No certification clock reset.
