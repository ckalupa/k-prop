MLB K-Prop Release 3.8 — Build 9.2.3

Promotion Readiness true mobile viewport hotfix.

Fixes the remaining horizontal overflow caused by the global styles.css rule `table { min-width: 1120px; }`, which survived the 9.2.2 stacked-card treatment. This build explicitly resets minimum widths for Promotion Readiness mobile tables and hardens the page shell, cards, buttons, badges, messages, and top navigation against viewport overflow.

No D1 migration. No model logic changes. No certification-window reset. No promotion/demotion endpoint. v13 remains production and v14 remains shadow-only.
