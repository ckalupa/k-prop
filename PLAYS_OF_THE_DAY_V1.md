# Private Plays of the Day tracker

## Included

- Cloudflare Access-protected `/plays.html` page and API routes.
- Select any processed recommendation from a board and snapshot the exact line, side, confidence, decision, and model version.
- Power and Flex entries.
- Amount wagered and full-hit multiplier.
- Editable payout rules for partial Flex results and reduced-leg outcomes.
- Automatic return, net profit/loss, ROI, and bankroll calculations.
- Automatic morning settlement from `prop_results` after the existing board grader completes.
- Push/void leg reduction with `NEEDS_REVIEW` whenever no exact saved multiplier rule exists.
- Automatic postgame diagnosis for losing legs, plus manual category/narrative review.
- Audit events and duplicate-leg protection.
- Optional starting balance, deposits, withdrawals, and bankroll adjustments.

## Deployment

```powershell
npx wrangler d1 migrations apply mlb-k-prop-prod --remote
npx tsc --noEmit
npx wrangler deploy
```

Run the migration before deploying the Worker.

## Access

Like the Board Editor, `/plays.html`, `/plays.js`, `/plays.css`, and all write/read APIs are unavailable on the public custom hostname and require the Cloudflare Access-protected Worker hostname.

## Settlement behavior

- Each leg is linked to its original `prop_id`.
- Morning grading updates `prop_results`, then tracked slips are settled.
- WIN/LOSS is calculated from the saved side and the official market result.
- PUSH and VOID are removed from the eligible-leg count.
- The exact saved `(eligible legs, hits)` multiplier is used when present.
- Missing reduced-leg or Flex rules produce `NEEDS_REVIEW`; the system does not guess.
- Losing legs receive a bounded automatic explanation based on workload and projection misses. Manual edits are preserved as `REVIEWED`.
