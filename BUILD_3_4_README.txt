MLB K-Prop Release 3.2 - Build 3.4
Data Quality Scoring

Purpose
- Standardize the quality of each immutable prop feature snapshot before v14/backtesting consumes it.
- Keep v13 production decisions unchanged.

Quality policy v1
- Starts at 100 and applies deterministic penalties for missing or weak inputs.
- Critical blockers: missing pitcher hand, pitcher features, or team features.
- Pitcher penalties: underlying pitcher feature quality, small season/recent samples, stale feature date.
- Team penalties: underlying team feature quality, small 30d/7d PA samples, LOW/MEDIUM split stability, stale feature date.
- Missing legacy context is a small non-critical penalty.

Outputs stored on every new snapshot
- overall_data_quality_score (0-100)
- data_quality_grade (A-F)
- quality_gate (PASS / CAUTION / BLOCK)
- challenger_eligible (0/1)
- quality_flags_json
- critical_quality_flags_json
- quality_policy_version

Gate policy
- PASS: score >= 85 and no critical flags
- CAUTION: score 60-84 and no critical flags
- BLOCK: score < 60 or any critical flag
- Challenger eligible: not BLOCK and score >= 75

Important
- v13 recommendation math is NOT changed by this build.
- Missing pitcher hand is no longer silently treated as RHP for snapshot/team-feature lookup.
- Existing pre-3.4 snapshots are conservatively backfilled using only the quality data frozen on those rows.
