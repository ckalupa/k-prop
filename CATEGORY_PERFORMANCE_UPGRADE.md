# Category Performance Upgrade v3

Fixes the Yesterday by Category cards by returning `yesterday.category_records` from the dashboard API.

The records use the latest stored recommendation per prop and group by `decision_tier`:
- CORE
- SECONDARY
- LEAN

Wins and losses are based on the saved recommendation side. Pushes are retained in W-L-P.

No database migration is required.
