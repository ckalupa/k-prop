MLB K-Prop Release 3.8 — Build 9.2.5
Promotion Readiness Query Hardening

Purpose
- Fix Promotion Readiness HTTP 500s caused by repeated/correlated certification ledger scans as the live prediction ledger grows.
- Preserve the existing certification window and all evidence.
- Preserve SOURCE_NON_DIRECTIONAL accounting introduced in 9.2.1.

Changes
- Adds composite model_predictions certification lookup index (migration 0059).
- Replaces multiple correlated certification pair/integrity queries with one indexed ledger query.
- Computes paired, missing-production, missing-candidate, and source-excluded counts from that single result set.
- Promotion Readiness now returns the governance portion with certification status QUERY_ERROR if certification collection itself fails, rather than blanking the whole page with HTTP 500.
- UI surfaces the underlying certification query error if that fallback is ever used.

Safety
- No promotion/demotion endpoint.
- No model role changes.
- No recommendation/model scoring changes.
- No grading changes.
- Certification start time is NOT reset.
- Existing evidence/failure ledger is untouched.
