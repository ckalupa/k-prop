
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const [sourceDb, outputSql] = process.argv.slice(2);

if (!sourceDb || !outputSql) {
  console.error("Usage: node build_d1_seed.mjs <source.db> <output.sql>");
  process.exit(1);
}

const db = new Database(sourceDb, { readonly: true });

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insert(table, columns, values, mode = "INSERT OR REPLACE") {
  return `${mode} INTO ${table} (${columns.join(", ")}) VALUES (${values.map(sqlValue).join(", ")});`;
}

const lines = [
  "-- Generated D1 seed from the authorized MLB tracker database.",
  "PRAGMA foreign_keys = OFF;",
  "BEGIN TRANSACTION;",
  "",
  "DELETE FROM audit_events;",
  "DELETE FROM prop_results;",
  "DELETE FROM recommendations;",
  "DELETE FROM feature_snapshots;",
  "DELETE FROM pitcher_game_stats;",
  "DELETE FROM props;",
  "DELETE FROM games;",
  "DELETE FROM boards;",
  "DELETE FROM pitcher_aliases;",
  "DELETE FROM pitchers;",
  "DELETE FROM teams;",
  "DELETE FROM model_versions;",
  "",
];

for (const r of db.prepare("SELECT * FROM teams ORDER BY team_id").all()) {
  lines.push(insert("teams",
    ["team_id","abbreviation","full_name","league","division"],
    [r.team_id,r.abbreviation,r.full_name,r.league,null]
  ));
}

for (const r of db.prepare("SELECT * FROM pitchers ORDER BY pitcher_id").all()) {
  const hand = ["R","L"].includes(r.throws) ? r.throws : null;
  lines.push(insert("pitchers",
    ["pitcher_id","canonical_name","mlb_id","throws_hand","active"],
    [r.pitcher_id,r.canonical_name,r.mlb_id,hand,r.active]
  ));
}

let aliasId = 0;
for (const r of db.prepare("SELECT alias, pitcher_id, source FROM pitcher_aliases ORDER BY alias").all()) {
  aliasId += 1;
  lines.push(insert("pitcher_aliases",
    ["alias_id","pitcher_id","alias_name","source"],
    [aliasId,r.pitcher_id,r.alias,r.source]
  ));
}

const sourceModel = db.prepare("SELECT * FROM model_versions ORDER BY model_version_id LIMIT 1").get();
lines.push(insert("model_versions",
  ["model_version_id","version_name","description","is_active","created_at"],
  [
    sourceModel.model_version_id,
    "v5-parity",
    `${sourceModel.model_name} — ${sourceModel.engine_version}. ${sourceModel.notes ?? ""}`.trim(),
    1,
    sourceModel.effective_from,
  ]
));

const boardStatusMap = {
  OPEN: "ACTIVE",
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
  ARCHIVED: "ARCHIVED",
  DRAFT: "DRAFT",
};

for (const r of db.prepare("SELECT * FROM boards ORDER BY board_id").all()) {
  const createdAt = r.snapshot_at ?? `${r.board_date}T00:00:00Z`;
  lines.push(insert("boards",
    ["board_id","board_date","board_name","status","source","created_at","updated_at"],
    [
      r.board_id,
      r.board_date,
      `${r.source} ${r.board_date}`,
      boardStatusMap[r.status] ?? "ARCHIVED",
      r.source,
      createdAt,
      createdAt,
    ]
  ));
}

for (const r of db.prepare("SELECT * FROM games ORDER BY game_id").all()) {
  lines.push(insert("games",
    ["game_id","mlb_game_pk","game_date","away_team_id","home_team_id","scheduled_start","game_status"],
    [r.game_id,r.mlb_game_pk,r.game_date,r.away_team_id,r.home_team_id,null,r.status]
  ));
}

const boardSources = new Map(
  db.prepare("SELECT board_id, source FROM boards").all().map(r => [r.board_id, r.source])
);

for (const r of db.prepare("SELECT * FROM props ORDER BY prop_id").all()) {
  lines.push(insert("props",
    ["prop_id","board_id","game_id","pitcher_id","opponent_team_id","strikeout_line",
     "available_side","prop_type","source","source_row","status"],
    [
      r.prop_id,r.board_id,r.game_id,r.pitcher_id,r.opponent_team_id,r.strikeout_line,
      r.available_sides,r.line_type,boardSources.get(r.board_id),r.source_row,"ACTIVE"
    ]
  ));
}

for (const r of db.prepare("SELECT * FROM pitcher_game_stats ORDER BY pitcher_game_stat_id").all()) {
  const innings = r.outs_recorded == null ? null : r.outs_recorded / 3;
  const role = String(r.role ?? "").toUpperCase();
  const starter = ["STARTER","SP",""].includes(role) ? 1 : 0;
  lines.push(insert("pitcher_game_stats",
    ["pitcher_game_stat_id","pitcher_id","game_id","game_date","opponent_team_id",
     "innings_pitched","strikeouts","batters_faced","pitch_count","starter","source"],
    [
      r.pitcher_game_stat_id,r.pitcher_id,r.game_id,r.game_date,r.opponent_team_id,
      innings,r.strikeouts,r.batters_faced,r.pitch_count,starter,r.source_url ?? r.source_sheet
    ]
  ));
}

const featureRows = db.prepare(`
  SELECT prop_id, model_version_id, feature_name, feature_value_numeric,
         feature_value_text, source_name, as_of_at
  FROM feature_snapshots
  ORDER BY prop_id, model_version_id, feature_snapshot_id
`).all();

const groups = new Map();
for (const r of featureRows) {
  const key = `${r.prop_id}:${r.model_version_id}`;
  if (!groups.has(key)) groups.set(key, { prop_id: r.prop_id, model_version_id: r.model_version_id, as_of_at: r.as_of_at, f: {} });
  groups.get(key).f[r.feature_name] = r.feature_value_numeric ?? r.feature_value_text;
  groups.get(key).as_of_at = r.as_of_at;
}

let snapshotId = 0;
for (const g of [...groups.values()].sort((a,b) => a.prop_id - b.prop_id)) {
  snapshotId += 1;
  const f = g.f;
  lines.push(insert("feature_snapshots",
    ["feature_snapshot_id","prop_id","model_version_id","snapshot_time","last_3_k_avg",
     "last_5_k_avg","career_k_avg","average_ip_last_3","projection_sd","opponent_k_rate",
     "handedness_edge","recent_form_gate","volume_gate","role_gate","health_gate",
     "matchup_gate","data_freshness","source_quality"],
    [
      snapshotId,g.prop_id,g.model_version_id,g.as_of_at,
      f.l3_avg,f.l5_avg,f.career_tracked_avg_k,f.avg_ip_l3,f.projection_sd,
      f.opponent_hand_shrunk_rate ?? f.opponent_over_rate,
      f.hand_matchup_edge,f.recent_form_gate,f.volume_gate,null,null,
      f.matchup_gate,f.data_freshness,f.data_source
    ]
  ));
}

for (const r of db.prepare("SELECT * FROM recommendations ORDER BY recommendation_id").all()) {
  lines.push(insert("recommendations",
    ["recommendation_id","prop_id","model_version_id","projected_strikeouts","model_edge",
     "estimated_over_rate","preferred_side","market_value_band","projection_status",
     "confidence_score","confidence_band","confidence_cap","core_block_count","decision_tier",
     "model_decision","final_decision","positive_factors","negative_factors","final_reason","generated_at"],
    [
      r.recommendation_id,r.prop_id,r.model_version_id,r.projected_strikeouts,r.model_edge,
      r.estimated_over_rate,r.preferred_side,r.market_value_band,r.projection_status,
      r.confidence_score,r.confidence_band,r.confidence_cap,r.core_block_count,r.decision_tier,
      r.model_decision,r.final_decision,r.positive_factors,r.negative_factors,r.final_reason,r.created_at
    ]
  ));
}

const validResults = new Set(["OVER","UNDER","PUSH","VOID"]);
for (const r of db.prepare("SELECT * FROM prop_results ORDER BY prop_result_id").all()) {
  const raw = String(r.result ?? "").toUpperCase();
  const result = validResults.has(raw) ? raw : null;
  lines.push(insert("prop_results",
    ["prop_result_id","prop_id","actual_strikeouts","result","result_status","source","graded_at"],
    [r.prop_result_id,r.prop_id,r.actual_strikeouts,result,result ? "FINAL" : "PENDING",r.source_url,r.finalized_at]
  ));
}

lines.push(insert("audit_events",
  ["audit_event_id","event_type","entity_type","entity_id","event_details"],
  [1,"SEED_IMPORT","DATABASE",null,"Imported from mlb_tracker_platform_phase5_authorized.db"]
));

lines.push(
  "",
  "COMMIT;",
  "PRAGMA foreign_keys = ON;",
  "",
  "SELECT 'teams' AS table_name, COUNT(*) AS row_count FROM teams",
  "UNION ALL SELECT 'pitchers', COUNT(*) FROM pitchers",
  "UNION ALL SELECT 'pitcher_aliases', COUNT(*) FROM pitcher_aliases",
  "UNION ALL SELECT 'games', COUNT(*) FROM games",
  "UNION ALL SELECT 'boards', COUNT(*) FROM boards",
  "UNION ALL SELECT 'props', COUNT(*) FROM props",
  "UNION ALL SELECT 'prop_results', COUNT(*) FROM prop_results",
  "UNION ALL SELECT 'pitcher_game_stats', COUNT(*) FROM pitcher_game_stats",
  "UNION ALL SELECT 'feature_snapshots', COUNT(*) FROM feature_snapshots",
  "UNION ALL SELECT 'recommendations', COUNT(*) FROM recommendations;"
);

fs.mkdirSync(path.dirname(outputSql), { recursive: true });
fs.writeFileSync(outputSql, lines.join("\n"), "utf8");

console.log(`Created: ${outputSql}`);
console.log(`Statements: ${lines.length}`);
