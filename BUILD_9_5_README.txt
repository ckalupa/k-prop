MLB K-Prop Release 3.8 - Build 9.5
Guarded Manual Promotion Control

- Requires immutable TECHNICALLY_READY freeze.
- Deployment alone never promotes a model.
- Promotion requires exact typed confirmation and rollback acknowledgement.
- Promotion transition is atomic through D1 batch: v13 -> ARCHIVED rollback target, v14 -> PRODUCTION.
- Immutable manual_model_promotions record captures frozen evidence linkage and rollback metadata.
- Production board processing detects certified v14 and applies v14-baseline-calibrated-v1 before publishing the recommendation.
- v13/v14 historical evidence and the Build 9.3.2 tracked-play replay remain preserved.
- Build 9.6 will add post-promotion guardrails and controlled rollback.
