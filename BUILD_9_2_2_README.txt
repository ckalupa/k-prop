MLB K-Prop Release 3.8 — Build 9.2.2
Promotion Readiness Mobile Formatting Hotfix

Scope
- UI-only hotfix for promotion-readiness.html.
- Removes horizontal scrolling on phone-width layouts.
- Promotion gates, certification daily evidence, and failure ledger render as stacked key/value cards on mobile.
- Header, buttons, status grids, evidence cards, and policy JSON wrap within the viewport.
- Desktop table layout is unchanged.

Safety
- No D1 migration.
- No Worker/model logic changes.
- Existing 9.2 certification session and evidence are untouched.
- v13 remains production; v14 remains shadow-only.
- No promotion/demotion endpoint is added.
