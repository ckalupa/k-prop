MLB K-Prop Release 3.3 - Build 4.1.5
Historical Reconstruction Certification

Purpose
- Certify historical rows reconstructed independently from pregame-safe pitcher history and opponent play-by-play context.
- Do not use legacy postgame feature snapshots or recommendations.
- Keep native prop_feature_snapshots untouched.

Certification policy
- RECONSTRUCTED_A: pitcher reconstruction RESEARCH_READY, opponent reconstruction RESEARCH_READY, >=5 prior starts, pitcher score >=85, opponent score >=90, HIGH opponent confidence.
- RECONSTRUCTED_B: core reconstruction complete, >=3 prior starts, pitcher score >=75, opponent score >=65, opponent confidence HIGH/MEDIUM/LOW.
- INCOMPLETE: otherwise excluded.
- CERTIFIED dataset mode = NATIVE + RECONSTRUCTED_A.
- EXPANDED dataset mode = NATIVE + RECONSTRUCTED_A + RECONSTRUCTED_B.

Implementation notes
- Reuses the existing historical_feature_certification ledger for compatibility with backtest_dataset_rows_v2 foreign keys.
- historical_reconstruction_id is used only as a legacy FK anchor. Certified pitcher features come from independent_historical_reconstructions; certified opponent/model output comes from the new pregame reconstruction path.
- Certification version: independent-certification-v1.
- No D1 schema migration is required.

After deployment
1. Open https://admin.mlb.kalupa.net/backtest-certification.html
2. Click "Certify independent reconstructions" once.
3. Confirm the policy is independent-certification-v1 and review A/B/Incomplete counts.
4. Then build CERTIFIED and EXPANDED datasets from Backtest Dataset.
