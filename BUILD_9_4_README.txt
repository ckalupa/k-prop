MLB K-Prop Release 3.8 - Build 9.4
Final Technical Readiness Freeze - rebased on Build 9.3.2

- Preserves the Build 9.3.2 research-only Tracked Plays vs v14 replay and its admin page/API.
- Adds an immutable one-per-certification technical_readiness_freezes record.
- Adds an explicit admin action to freeze the completed certification decision.
- The freeze records policy/model IDs, gates, sample counts, safety metrics, performance metrics, and evidence JSON.
- Freeze is idempotent and cannot be overwritten or deleted.
- No model-role change, promotion endpoint, tuning, or certification reset.
- v13 remains production; v14 remains shadow candidate.
