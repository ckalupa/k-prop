Fixes included
==============

1. Closed/archived boards now load the latest recommendation actually generated
   for each prop rather than filtering to only the currently active model.
2. The board editor displays the recommendation model version below the decision.
3. The grader now checks the official final game feed when the player game-log
   endpoint has no row.
4. A final game with no matched local pitching row is no longer automatically
   treated as proof of DNP. It remains pending for review unless the game itself
   was postponed/cancelled.

Validation completed
====================

npx tsc --noEmit
node --check public/board-editor.js

Deployment
==========

Copy these files into the matching project locations:
  src/index.ts
  public/board-editor.js

Then run:
  npx tsc --noEmit
  npx wrangler deploy

Repair board 72
===============

Place repair_board_72_false_dnp.sql in the project root and run:
  npx wrangler d1 execute mlb-k-prop-prod --remote --file ".\repair_board_72_false_dnp.sql"

Then open board 72 in Board Editor and click Grade Results. The final game-feed
fallback should recover pitching lines that the game-log endpoint missed. Any
truly unresolved player will remain PENDING rather than being falsely voided.
