# Flex payout matrix + boost upgrade

- Replaces the single full-hit input with Power Play multiplier, Flex full-hit multiplier, and Boost percentage.
- Auto-generates editable Flex partial-hit rows from selected legs.
- Requires 2/3 for 3-pick Flex, 3/4 for 4-pick Flex, and both 4/5 and 3/5 for 5-pick Flex.
- Applies boost percentage to the payout multiplier actually earned.
- Stores base and boosted settlement multipliers separately.
- All-void refunds remain 1x and are not boosted.

Deploy:
1. `npx wrangler d1 migrations apply mlb-k-prop-prod --remote`
2. `npx tsc --noEmit`
3. `npx wrangler deploy`
