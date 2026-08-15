SELECT 'quality_columns' AS check_name,
       COUNT(*) AS column_count
FROM pragma_table_info('prop_feature_snapshots')
WHERE name IN (
  'overall_data_quality_score','data_quality_grade','quality_gate','challenger_eligible',
  'quality_flags_json','critical_quality_flags_json','quality_policy_version'
);

SELECT 'quality_rows' AS check_name,
       COUNT(*) AS total,
       SUM(CASE WHEN overall_data_quality_score BETWEEN 0 AND 100 THEN 1 ELSE 0 END) AS scored,
       SUM(CASE WHEN quality_gate IN ('PASS','CAUTION','BLOCK') THEN 1 ELSE 0 END) AS gated,
       SUM(CASE WHEN data_quality_grade IN ('A','B','C','D','F') THEN 1 ELSE 0 END) AS graded
FROM prop_feature_snapshots;

SELECT 'quality_gate_distribution' AS check_name,
       quality_gate,
       COUNT(*) AS rows
FROM prop_feature_snapshots
GROUP BY quality_gate
ORDER BY quality_gate;
