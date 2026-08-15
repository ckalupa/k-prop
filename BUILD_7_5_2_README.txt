MLB K-Prop Release 3.6 - Build 7.5.2
Statcast Challenger first-executed-date SQL hotfix

Fixes a deterministic HTTP 500 when the replay reaches its first EXECUTED date.
The statcast_challenger_replay_dates INSERT had 11 SQL placeholders but only 10 bound values.
Build 7.5.2 removes the extra placeholder.

Existing SKIPPED dates and any partially inserted replay rows are preserved. Row writes are INSERT OR REPLACE, so rerunning the failed date is safe.
No migration. Production v13 and live v14 remain unchanged.
