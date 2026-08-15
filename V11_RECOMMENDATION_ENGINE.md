# V11 Ranked Decision Board

V11 creates a new active model version: `v11-ranked-decision-board`.

Each processed prop receives a transparent 0-100 score:

- Projection edge: 30
- Recent form: 15
- Volume stability: 15
- Opponent matchup: 20
- Role stability: 10
- Data completeness: 10

Bands:

- 85-100: Core Candidate
- 75-84: Strong Lean
- 65-74: Lean
- 50-64: Watch
- Below 50: Pass
- Hard market/sample conflict: Auto Pass

Initial Classification is model-generated. Final Classification, Final Card, and Actually Played remain manual. Existing V8/V10 recommendation history is preserved because V11 writes rows under a new model version.

## Deploy

```powershell
npm ci
npx tsc --noEmit
node --check .\public\board-editor.js
npx wrangler d1 migrations apply mlb-k-prop-prod --local
npx wrangler d1 migrations apply mlb-k-prop-prod --remote
npx wrangler deploy
```

After deployment, click **Refresh Data & Process** on the board to generate V11 rankings.
