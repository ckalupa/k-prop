Release 3.7 - Build 8.1.1
Game Context Staged Sync Hotfix

Fixes one-date context sync by processing at most four MLB games per Worker request, avoiding Cloudflare subrequest/runtime exhaustion. The admin page chains batches automatically and handles non-JSON HTTP failures cleanly.

No schema changes. No production model changes.
