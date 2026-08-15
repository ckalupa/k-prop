MLB K-Prop Release 3.3 - Build 4.1.4.1
Historical Opponent Reconstruction D1 Bind Hotfix

Fixes HTTP 500 in Historical Opponent Reconstruction caused by a SQL parameter mismatch:
- historical_opponent_reconstructions INSERT had 38 placeholders for 37 bound values.
- Corrected to 37 placeholders.
- No schema changes.
- No model/reconstruction logic changes.
- Native prop snapshots remain untouched.
