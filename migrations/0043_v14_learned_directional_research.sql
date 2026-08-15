PRAGMA foreign_keys = ON;
-- Release 3.4 / Build 5.5: research-only learned directional challenger replay.
-- Live v14 intentionally remains Build 5.1 until chronological replay proves the candidate.
INSERT INTO audit_events(event_type,entity_type,event_details)
VALUES('BUILD_5_5_INSTALLED','SYSTEM','{"release":"3.4","build":"5.5","feature":"regularized learned directional challenger replay","live_v14":"v14-baseline-calibrated-v1","candidate":"research_only","anti_lookahead":"board_date strictly before target"}');
