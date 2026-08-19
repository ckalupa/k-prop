MLB K-Prop Release 3.8 - Build 9.3.1
Automatic Certification Checkpoint + Encoding Hotfix

- Hooks certification monitoring directly into gradeBoardResults so manual and scheduled grading both capture checkpoints.
- Adds idempotent readiness reconciliation to backfill missed DAILY/MILESTONE checkpoints (including the already-crossed 50-pair milestone).
- Uses the latest graded certification date for automatic daily checkpoint keys.
- Replaces the Unicode minus in promotion gate labels with an ASCII hyphen to prevent mojibake on mobile/legacy decoding paths.
- No migration. Existing certification session, evidence, v13/v14 roles, model behavior, and promotion lock are unchanged.
