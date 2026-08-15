# V10 Automation Upgrade

V10 turns lifecycle fields into automated status wherever official data is available.

## Automated during Refresh Data & Process

- Initial classification from model decision/tier
- Suggested final classification (preserved if manually overridden)
- Opening line from imported prop line
- Recommended line initialized from the processed line
- Market type from Standard / Green Goblin / Red Goblin
- Server-calculated completeness score

Reprocessing refreshes model-derived values without clearing Final Card, Played, a manual final-classification override, or a saved closing line.

## Refresh Pregame Checks

The new button calls official MLB schedule and live-feed endpoints to update:

- Probable-starter confirmation
- Official lineup availability
- Weather availability
- Home-plate umpire availability
- Completeness score

Pregame information appears at different times. Run the button again nearer first pitch when a status is still pending.

## Manual fields retained

- Final classification override
- Final Card
- Played
- Closing line, because MLB does not provide PrizePicks closing markets

## Postgame automation

Official MLB game logs continue to populate Ks, innings, pitches, batters faced, and starter status. Postgame review is automatically marked NOT_REQUIRED for:

- Props not marked Final Card
- Winning final-card recommendations
- Pushes

A losing Final Card remains UNREVIEWED for diagnosis.

## Deployment

V10 uses the existing 0009 schema and has no new migration.

1. Replace the project files.
2. Run `npm ci`.
3. Run `npx tsc --noEmit`.
4. Run `node --check .\public\board-editor.js`.
5. Run `npx wrangler deploy`.
6. Open the board editor and click Refresh Data & Process once on the current board.
