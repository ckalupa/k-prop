MLB K-Prop Release 3.3 - Build 4.1.2.1
Historical Cutoff Certification Fix

Changes:
- Uses each prop's scheduled MLB game start as the historical information cutoff.
- Selects the latest legacy feature snapshot created at or before first pitch.
- Selects the latest legacy recommendation created at or before first pitch.
- Stores the exact certified source IDs, model version, cutoff timestamp, opponent context, and model context.
- Reconstructed A requires strong pitcher history plus pregame model and opponent context.
- Reconstructed B may have weaker/missing opponent context but still requires a pregame model output and at least 3 prior starts.
- Native prop_feature_snapshots are never modified.
- CERTIFIED and EXPANDED dataset builds consume the latest certification run and its validated pregame context.
