MLB K-Prop Release 3.3 - Build 4.1.7.1
Archive Reconstruction Empty PBP Resilience

Fixes archive reconstruction HTTP 500 when MLB schedule marks a historical game Final but the play-by-play endpoint contains no usable plate appearances.

Behavior:
- Skip only the unusable historical game.
- Continue reconstructing from the rest of the pre-board-date window.
- Record skipped games in sync_runs details_json and rows_rejected.
- Let normal sample/confidence gates determine RESEARCH_READY vs INCOMPLETE.
- Does not modify native snapshots or production predictions.
- No schema migration.
