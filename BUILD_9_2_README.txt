MLB K-Prop Release 3.8 - Build 9.2 — Live Shadow Certification

Creates an explicit certification window beginning at migration time. Only native paired predictions created at or after session.started_at qualify. The 10 prior shadow failures are preserved in an immutable PRE_CERTIFICATION ledger and do not count against the new window. New shadow runtime failures are automatically attached to the active certification. The readiness page displays certification counts, per-date evidence, pairing integrity, failure details, and immutable evidence capture.

SAFETY: no promotion, demotion, model-role swap, execution toggle, or rollback action is added. v13 remains production; v14 remains shadow-only.
