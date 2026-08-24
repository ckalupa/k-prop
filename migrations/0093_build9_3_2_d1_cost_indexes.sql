-- K-Prop Build 9.3.2
-- D1 cost optimization for play-slip settlement.
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_prop_model_latest
ON feature_snapshots(prop_id,model_version_id,snapshot_time DESC,feature_snapshot_id DESC);
