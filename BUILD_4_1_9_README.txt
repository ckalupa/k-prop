MLB K-Prop Release 3.3 - Build 4.1.9
Archive Reconstruction Certification + Dataset v3

- Adds archive-certification-v1 for pregame-only archive reconstructions.
- A tier: research-ready, >=5 prior starts, reconstruction score >=90, HIGH opponent sample confidence.
- B tier: research-ready, >=3 prior starts, reconstruction score >=70, HIGH/MEDIUM/LOW opponent confidence.
- Incomplete rows remain excluded.
- Adds historical-dataset-v3 with explicit ARCHIVE_RECONSTRUCTED_A/B provenance.
- CERTIFIED: native + independent A + archive A.
- EXPANDED: native + independent A/B + archive A/B.
- Walk-forward and performance now read dataset-v3/fold-row-v3 storage.
- Production v13 decisions and native snapshots are unchanged.
