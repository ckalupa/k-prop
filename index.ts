import { createRemoteJWKSet, jwtVerify } from "jose";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
}

interface AccessIdentity {
  email: string | null;
  subject: string;
  issuer: string;
}

type JsonValue = Record<string, unknown> | unknown[];

function json(data: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function notFound(path: string): Response {
  return json({ error: "Not found", path }, { status: 404 });
}


async function requireAccessIdentity(request: Request, env: Env): Promise<AccessIdentity> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    throw new Error("TEAM_DOMAIN or POLICY_AUD is not configured.");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new Response(
      JSON.stringify({ error: "Missing Cloudflare Access JWT" }),
      {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const issuer = env.TEAM_DOMAIN.replace(/\/+$/, "");
  const jwks = createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );

  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: env.POLICY_AUD,
  });

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) {
    throw new Response(
      JSON.stringify({ error: "Access JWT has no subject" }),
      {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  return {
    email: typeof payload.email === "string" ? payload.email : null,
    subject,
    issuer,
  };
}

async function getCurrentUser(request: Request, env: Env): Promise<Response> {
  const identity = await requireAccessIdentity(request, env);

  return json({
    authenticated: true,
    email: identity.email,
    subject: identity.subject,
    issuer: identity.issuer,
  });
}

async function getHealth(env: Env): Promise<Response> {
  const databaseCheck = await env.DB
    .prepare("SELECT 1 AS connected")
    .first<{ connected: number }>();

  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM teams) AS teams,
      (SELECT COUNT(*) FROM pitchers) AS pitchers,
      (SELECT COUNT(*) FROM boards) AS boards,
      (SELECT COUNT(*) FROM props) AS props,
      (SELECT COUNT(*) FROM prop_results) AS results
  `).first();

  return json({
    application: "mlb-k-prop-api",
    status: "ok",
    databaseConnected: databaseCheck?.connected === 1,
    counts,
  });
}

async function getCurrentBoard(env: Env): Promise<Response> {
  const board = await env.DB.prepare(`
   SELECT board_id, board_date, board_name, status, source, created_at, updated_at
    FROM boards
    ORDER BY
      CASE status
        WHEN 'ACTIVE' THEN 0
        WHEN 'DRAFT' THEN 1
        WHEN 'CLOSED' THEN 2
        ELSE 3
      END,
      board_date DESC,
      board_id DESC
    LIMIT 1
  `).first();

  if (!board) {
    return json({ board: null, rows: [] });
  }

  const result = await env.DB.prepare(`
    SELECT
      p.prop_id,
      p.source_row,
      p.strikeout_line,
      p.available_side,
      p.prop_type,
      p.status AS prop_status,
      pi.pitcher_id,
      pi.canonical_name AS pitcher,
      pi.throws_hand,
      t.abbreviation AS opponent,
      r.projected_strikeouts,
      r.model_edge,
      r.estimated_over_rate,
      r.preferred_side,
      r.market_value_band,
      r.projection_status,
      r.confidence_score,
      r.confidence_band,
      r.confidence_cap,
      r.core_block_count,
      r.decision_tier,
      r.model_decision,
      r.final_decision,
      r.positive_factors,
      r.negative_factors,
      r.final_reason
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    LEFT JOIN recommendations r ON r.prop_id = p.prop_id
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
    ORDER BY COALESCE(p.source_row, p.prop_id), p.prop_id
  `).bind((board as { board_id: number }).board_id).all();

  return json({
    board,
    rows: result.results,
  });
}

async function getDashboard(env: Env, url: URL): Promise<Response> {
  const requestedBoardIdRaw = Number(url.searchParams.get("board_id") ?? "0");
  const requestedBoardId =
    Number.isInteger(requestedBoardIdRaw) && requestedBoardIdRaw > 0
      ? requestedBoardIdRaw
      : null;

  const board = requestedBoardId
    ? await env.DB.prepare(`
        SELECT board_id, board_date, board_name, status, updated_at
        FROM boards
        WHERE board_id = ?
        LIMIT 1
      `).bind(requestedBoardId).first<{
        board_id: number;
        board_date: string;
        board_name: string;
        status: string;
        updated_at: string | null;
      }>()
    : await env.DB.prepare(`
        SELECT board_id, board_date, board_name, status, updated_at
        FROM boards
        ORDER BY
          CASE status
            WHEN 'ACTIVE' THEN 0
            WHEN 'DRAFT' THEN 1
            WHEN 'CLOSED' THEN 2
            WHEN 'ARCHIVED' THEN 3
            ELSE 4
          END,
          board_date DESC,
          board_id DESC
        LIMIT 1
      `).first<{
        board_id: number;
        board_date: string;
        board_name: string;
        status: string;
        updated_at: string | null;
      }>();

  const workflowBoardsPromise = env.DB.prepare(`
    SELECT
      b.board_id,
      b.board_date,
      b.board_name,
      b.status,
      COUNT(DISTINCT p.prop_id) AS prop_count,
      COUNT(DISTINCT r.prop_id) AS processed_count,
      SUM(CASE WHEN pr.result_status IS NOT NULL AND pr.result_status <> 'PENDING' THEN 1 ELSE 0 END) AS settled_count,
      SUM(CASE WHEN p.prop_id IS NOT NULL AND (pr.result_status IS NULL OR pr.result_status = 'PENDING') THEN 1 ELSE 0 END) AS pending_count
    FROM boards b
    LEFT JOIN props p ON p.board_id = b.board_id
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    GROUP BY b.board_id
    ORDER BY b.board_date DESC, b.board_id DESC
    LIMIT 60
  `).all();

  const modelRecordsPromise = env.DB.prepare(`
    SELECT
      mv.version_name,
      mv.is_active,
      COUNT(DISTINCT r.recommendation_id) AS recommendations,
      SUM(CASE WHEN pr.result IN ('OVER', 'UNDER') THEN 1 ELSE 0 END) AS settled,
      SUM(CASE
        WHEN pr.result IN ('OVER', 'UNDER') AND (
          (r.preferred_side = 'More' AND pr.result = 'OVER') OR
          (r.preferred_side = 'Less' AND pr.result = 'UNDER')
        ) THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN pr.result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN pr.result = 'VOID' THEN 1 ELSE 0 END) AS voids
    FROM model_versions mv
    LEFT JOIN recommendations r ON r.model_version_id = mv.model_version_id
    LEFT JOIN prop_results pr ON pr.prop_id = r.prop_id AND pr.result_status <> 'PENDING'
    GROUP BY mv.model_version_id
    ORDER BY mv.is_active DESC, mv.model_version_id DESC
    LIMIT 8
  `).all();

  const yesterdayBoardPromise = env.DB.prepare(`
    SELECT board_id, board_date, board_name, status
    FROM boards
    WHERE board_date < COALESCE(?, '9999-12-31')
      AND status IN ('CLOSED', 'ARCHIVED')
    ORDER BY board_date DESC, board_id DESC
    LIMIT 1
  `).bind(board?.board_date ?? null).first<{
    board_id: number;
    board_date: string;
    board_name: string;
    status: string;
  }>();

  const lifetimeRecordsPromise = env.DB.prepare(`
    SELECT
      'MORE' AS record_group,
      SUM(CASE WHEN pr.result = 'OVER' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN pr.result = 'UNDER' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN pr.result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN pr.result = 'VOID' THEN 1 ELSE 0 END) AS voids
    FROM recommendations r
    JOIN prop_results pr ON pr.prop_id = r.prop_id
    WHERE pr.result_status <> 'PENDING'
      AND r.model_decision IN ('PLAY', 'LEAN')
      AND r.preferred_side = 'More'

    UNION ALL

    SELECT
      'PLAY' AS record_group,
      SUM(CASE
        WHEN pr.result IN ('OVER', 'UNDER')
         AND ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
        THEN 1 ELSE 0 END) AS wins,
      SUM(CASE
        WHEN pr.result IN ('OVER', 'UNDER')
         AND NOT ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
        THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN pr.result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN pr.result = 'VOID' THEN 1 ELSE 0 END) AS voids
    FROM recommendations r
    JOIN prop_results pr ON pr.prop_id = r.prop_id
    WHERE pr.result_status <> 'PENDING'
      AND r.model_decision = 'PLAY'

    UNION ALL

    SELECT
      'LEAN' AS record_group,
      SUM(CASE
        WHEN pr.result IN ('OVER', 'UNDER')
         AND ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
        THEN 1 ELSE 0 END) AS wins,
      SUM(CASE
        WHEN pr.result IN ('OVER', 'UNDER')
         AND NOT ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
        THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN pr.result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
      SUM(CASE WHEN pr.result = 'VOID' THEN 1 ELSE 0 END) AS voids
    FROM recommendations r
    JOIN prop_results pr ON pr.prop_id = r.prop_id
    WHERE pr.result_status <> 'PENDING'
      AND r.model_decision = 'LEAN'
  `).all();

  const recentResultsPromise = env.DB.prepare(`
    SELECT
      b.board_date,
      pi.canonical_name AS pitcher,
      t.abbreviation AS opponent,
      p.strikeout_line,
      r.preferred_side,
      r.model_decision,
      pr.actual_strikeouts,
      pr.result,
      CASE
        WHEN pr.result = 'PUSH' THEN 'PUSH'
        WHEN pr.result = 'VOID' THEN 'VOID'
        WHEN r.model_decision NOT IN ('PLAY', 'LEAN') THEN 'NO PLAY'
        WHEN r.preferred_side = 'More' AND pr.result = 'OVER' THEN 'WIN'
        WHEN r.preferred_side = 'Less' AND pr.result = 'UNDER' THEN 'WIN'
        WHEN pr.result IN ('OVER', 'UNDER') THEN 'LOSS'
        ELSE pr.result_status
      END AS model_outcome
    FROM prop_results pr
    JOIN props p ON p.prop_id = pr.prop_id
    JOIN boards b ON b.board_id = p.board_id
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    WHERE pr.result_status <> 'PENDING'
    ORDER BY COALESCE(pr.graded_at, pr.created_at) DESC, p.prop_id DESC
    LIMIT 12
  `).all();

  if (!board) {
    const [workflowBoards, modelRecords, recentResults, yesterdayBoard, lifetimeRecords] = await Promise.all([
      workflowBoardsPromise,
      modelRecordsPromise,
      recentResultsPromise,
      yesterdayBoardPromise,
      lifetimeRecordsPromise,
    ]);
    return json({
      board: null,
      summary: { props: 0, plays: 0, leans: 0, watches: 0, passes: 0 },
      recommendations: [],
      workflow_boards: workflowBoards.results,
      model_records: modelRecords.results,
      recent_results: recentResults.results,
      yesterday: yesterdayBoard ? { board: yesterdayBoard, rows: [], summary: {} } : null,
      lifetime_records: lifetimeRecords.results,
      dashboard_meta: {
        generated_at: new Date().toISOString(),
        last_updated_at: null,
        grading_status: "NO BOARD",
        settled: 0,
        pending: 0,
      },
    });
  }

  const summaryPromise = env.DB.prepare(`
    SELECT
      COUNT(*) AS props,
      SUM(CASE WHEN r.model_decision = 'PLAY' THEN 1 ELSE 0 END) AS plays,
      SUM(CASE WHEN r.model_decision = 'LEAN' THEN 1 ELSE 0 END) AS leans,
      SUM(CASE WHEN r.model_decision = 'WATCH' THEN 1 ELSE 0 END) AS watches,
      SUM(CASE WHEN r.model_decision IN ('PASS', 'AUTO PASS') THEN 1 ELSE 0 END) AS passes,
      SUM(CASE WHEN r.recommendation_id IS NOT NULL THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN pr.result_status IS NOT NULL AND pr.result_status <> 'PENDING' THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN pr.result_status IS NULL OR pr.result_status = 'PENDING' THEN 1 ELSE 0 END) AS pending
    FROM props p
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
  `).bind(board.board_id).first();

  const recommendationsPromise = env.DB.prepare(`
    SELECT
      p.prop_id,
      p.prop_type,
      pi.canonical_name AS pitcher,
      pi.current_team AS pitcher_team,
      t.abbreviation AS opponent,
      p.strikeout_line,
      r.projected_strikeouts,
      r.model_edge,
      r.estimated_over_rate,
      r.preferred_side,
      r.confidence_score,
      r.confidence_band,
      r.recommendation_score,
      r.recommendation_band,
      r.score_projection,
      r.score_recent_form,
      r.score_volume,
      r.score_matchup,
      r.score_role,
      r.score_completeness,
      r.score_explanation,
      r.decision_tier,
      r.model_decision,
      r.final_decision,
      r.final_reason,
      r.initial_classification,
      r.final_classification,
      r.final_card,
      r.actually_played,
      r.opening_line,
      r.recommended_line,
      r.closing_line,
      r.market_type,
      r.finalized_at,
      r.change_reason,
      r.completeness_score,
      r.starter_confirmed,
      r.lineup_confirmed,
      r.weather_checked,
      r.umpire_checked,
      r.game_pk,
      r.scheduled_first_pitch,
      r.last_pregame_checked_at,
      r.last_successful_refresh_at,
      r.pregame_check_status,
      r.pregame_check_message,
      fs.opponent_k_rate,
      fs.handedness_edge,
      fs.last_3_k_avg,
      fs.last_5_k_avg,
      fs.last_10_k_avg,
      fs.average_bf_last_5,
      fs.average_pitch_count_last_5,
      fs.starter_rate_last_10,
      fs.recent_form_gate,
      fs.volume_gate,
      fs.role_gate,
      fs.matchup_gate,
      pr.actual_strikeouts,
      pr.result,
      pr.result_status,
      pr.innings_pitched,
      pr.pitch_count,
      pr.batters_faced,
      pr.starter AS result_starter,
      pr.suggested_reason_code,
      pr.postgame_reason_code,
      pr.early_exit_reason,
      pr.postgame_review_status,
      pr.graded_at
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    LEFT JOIN feature_snapshots fs ON fs.feature_snapshot_id = (
      SELECT fs2.feature_snapshot_id
      FROM feature_snapshots fs2
      WHERE fs2.prop_id = p.prop_id
        AND (r.model_version_id IS NULL OR fs2.model_version_id = r.model_version_id)
      ORDER BY fs2.snapshot_time DESC, fs2.feature_snapshot_id DESC
      LIMIT 1
    )
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
    ORDER BY
      CASE WHEN r.recommendation_score IS NULL THEN 1 ELSE 0 END,
      r.recommendation_score DESC,
      CASE r.model_decision
        WHEN 'PLAY' THEN 0
        WHEN 'LEAN' THEN 1
        WHEN 'WATCH' THEN 2
        WHEN 'PASS' THEN 3
        WHEN 'AUTO PASS' THEN 4
        ELSE 5
      END,
      ABS(COALESCE(r.model_edge, 0)) DESC,
      pi.canonical_name
  `).bind(board.board_id).all();

  const [summary, recommendations, workflowBoards, modelRecords, recentResults, yesterdayBoard, lifetimeRecords] = await Promise.all([
    summaryPromise,
    recommendationsPromise,
    workflowBoardsPromise,
    modelRecordsPromise,
    recentResultsPromise,
    yesterdayBoardPromise,
    lifetimeRecordsPromise,
  ]);

  let yesterday: Record<string, unknown> | null = null;

  if (yesterdayBoard) {
    const yesterdayRows = await env.DB.prepare(`
      SELECT
        p.prop_id,
        pi.canonical_name AS pitcher,
        t.abbreviation AS opponent,
        p.strikeout_line,
        r.preferred_side,
        r.model_decision,
        r.confidence_score,
        pr.actual_strikeouts,
        pr.result,
        CASE
          WHEN pr.result = 'PUSH' THEN 'PUSH'
          WHEN pr.result = 'VOID' THEN 'VOID'
          WHEN r.preferred_side = 'More' AND pr.result = 'OVER' THEN 'WIN'
          WHEN r.preferred_side = 'Less' AND pr.result = 'UNDER' THEN 'WIN'
          WHEN pr.result IN ('OVER', 'UNDER') THEN 'LOSS'
          ELSE pr.result_status
        END AS model_outcome
      FROM props p
      JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
      LEFT JOIN teams t ON t.team_id = p.opponent_team_id
      JOIN prop_results pr ON pr.prop_id = p.prop_id
      LEFT JOIN recommendations r ON r.recommendation_id = (
        SELECT r2.recommendation_id
        FROM recommendations r2
        WHERE r2.prop_id = p.prop_id
        ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
        LIMIT 1
      )
      WHERE p.board_id = ?
        AND pr.result_status <> 'PENDING'
        AND r.model_decision IN ('PLAY', 'LEAN')
      ORDER BY
        CASE r.model_decision WHEN 'PLAY' THEN 0 ELSE 1 END,
        pi.canonical_name
    `).bind(yesterdayBoard.board_id).all();

    const yesterdaySummary = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN r.model_decision = 'PLAY'
          AND pr.result IN ('OVER', 'UNDER')
          AND ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
          THEN 1 ELSE 0 END) AS play_wins,
        SUM(CASE WHEN r.model_decision = 'PLAY'
          AND pr.result IN ('OVER', 'UNDER')
          AND NOT ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
          THEN 1 ELSE 0 END) AS play_losses,
        SUM(CASE WHEN r.model_decision = 'PLAY' AND pr.result = 'PUSH' THEN 1 ELSE 0 END) AS play_pushes,

        SUM(CASE WHEN r.model_decision = 'LEAN'
          AND pr.result IN ('OVER', 'UNDER')
          AND ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
          THEN 1 ELSE 0 END) AS lean_wins,
        SUM(CASE WHEN r.model_decision = 'LEAN'
          AND pr.result IN ('OVER', 'UNDER')
          AND NOT ((r.preferred_side = 'More' AND pr.result = 'OVER') OR (r.preferred_side = 'Less' AND pr.result = 'UNDER'))
          THEN 1 ELSE 0 END) AS lean_losses,
        SUM(CASE WHEN r.model_decision = 'LEAN' AND pr.result = 'PUSH' THEN 1 ELSE 0 END) AS lean_pushes,

        SUM(CASE WHEN r.preferred_side = 'More' AND r.model_decision IN ('PLAY', 'LEAN') AND pr.result = 'OVER' THEN 1 ELSE 0 END) AS more_wins,
        SUM(CASE WHEN r.preferred_side = 'More' AND r.model_decision IN ('PLAY', 'LEAN') AND pr.result = 'UNDER' THEN 1 ELSE 0 END) AS more_losses,
        SUM(CASE WHEN r.preferred_side = 'More' AND r.model_decision IN ('PLAY', 'LEAN') AND pr.result = 'PUSH' THEN 1 ELSE 0 END) AS more_pushes
      FROM props p
      JOIN prop_results pr ON pr.prop_id = p.prop_id
      LEFT JOIN recommendations r ON r.recommendation_id = (
        SELECT r2.recommendation_id
        FROM recommendations r2
        WHERE r2.prop_id = p.prop_id
        ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
        LIMIT 1
      )
      WHERE p.board_id = ?
        AND pr.result_status <> 'PENDING'
    `).bind(yesterdayBoard.board_id).first();

    yesterday = {
      board: yesterdayBoard,
      rows: yesterdayRows.results,
      summary: yesterdaySummary ?? {},
    };
  }

  return json({
    board,
    summary,
    recommendations: recommendations.results,
    workflow_boards: workflowBoards.results,
    model_records: modelRecords.results,
    recent_results: recentResults.results,
    yesterday,
    lifetime_records: lifetimeRecords.results,
    dashboard_meta: {
      generated_at: new Date().toISOString(),
      last_updated_at: board.updated_at,
      grading_status:
        board.status === "CLOSED"
          ? "COMPLETE"
          : Number((summary as Record<string, unknown> | null)?.pending ?? 0) > 0
            ? "PENDING RESULTS"
            : board.status,
      settled: Number((summary as Record<string, unknown> | null)?.settled ?? 0),
      pending: Number((summary as Record<string, unknown> | null)?.pending ?? 0),
    },
  });
}

interface CalibrationRow {
  decision: string | null;
  tier: string | null;
  confidence_score: number | null;
  confidence_band: string | null;
  preferred_side: string | null;
  prop_type: string | null;
  model_edge: number | null;
  recent_form_gate: string | null;
  role_gate: string | null;
  matchup_gate: string | null;
  result: string | null;
}

function summarizeCalibration(rows: CalibrationRow[], key: (row: CalibrationRow) => string): Array<Record<string, unknown>> {
  const groups = new Map<string, { graded: number; wins: number; losses: number; pushes: number; voids: number }>();
  for (const row of rows) {
    const label = key(row) || "UNKNOWN";
    const group = groups.get(label) ?? { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0 };
    if (row.result === "PUSH") { group.pushes += 1; groups.set(label, group); continue; }
    if (row.result === "VOID") { group.voids += 1; groups.set(label, group); continue; }
    if (row.result !== "OVER" && row.result !== "UNDER") { groups.set(label, group); continue; }
    group.graded += 1;
    const hit = (row.preferred_side === "More" && row.result === "OVER") ||
      (row.preferred_side === "Less" && row.result === "UNDER");
    if (hit) group.wins += 1; else group.losses += 1;
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, values]) => ({
    label,
    ...values,
    hit_rate: values.graded ? values.wins / values.graded : null,
  })).sort((a, b) => Number(b.graded) - Number(a.graded) || String(a.label).localeCompare(String(b.label)));
}

async function getCalibration(env: Env): Promise<Response> {
  const model = await env.DB.prepare(`
    SELECT model_version_id, version_name, description
    FROM model_versions
    WHERE is_active = 1
    ORDER BY model_version_id DESC
    LIMIT 1
  `).first<{ model_version_id: number; version_name: string; description: string | null }>();

  if (!model) return json({ error: "No active model version." }, { status: 409 });

  const result = await env.DB.prepare(`
    SELECT
      r.model_decision AS decision, r.decision_tier AS tier,
      r.confidence_score, r.confidence_band, r.preferred_side, r.model_edge,
      p.prop_type, fs.recent_form_gate, fs.role_gate, fs.matchup_gate, pr.result
    FROM recommendations r
    JOIN props p ON p.prop_id = r.prop_id
    JOIN prop_results pr ON pr.prop_id = r.prop_id
    LEFT JOIN feature_snapshots fs ON fs.feature_snapshot_id = (
      SELECT fs2.feature_snapshot_id FROM feature_snapshots fs2
      WHERE fs2.prop_id = r.prop_id AND fs2.model_version_id = r.model_version_id
      ORDER BY fs2.snapshot_time DESC, fs2.feature_snapshot_id DESC LIMIT 1
    )
    WHERE r.model_version_id = ?
      AND pr.result_status <> 'PENDING'
  `).bind(model.model_version_id).all<CalibrationRow>();

  const rows = result.results;
  const settled = rows.filter(row => row.result === "OVER" || row.result === "UNDER");
  const wins = settled.filter(row =>
    (row.preferred_side === "More" && row.result === "OVER") ||
    (row.preferred_side === "Less" && row.result === "UNDER")
  ).length;
  const minimumSample = 30;

  return json({
    model,
    summary: {
      recommendations_with_results: rows.length,
      settled: settled.length,
      wins,
      losses: settled.length - wins,
      pushes: rows.filter(row => row.result === "PUSH").length,
      voids: rows.filter(row => row.result === "VOID").length,
      hit_rate: settled.length ? wins / settled.length : null,
      calibration_ready: settled.length >= minimumSample,
      minimum_sample: minimumSample,
    },
    by_decision: summarizeCalibration(rows, row => row.decision ?? "UNSET"),
    by_confidence: summarizeCalibration(rows, row => row.confidence_band ?? "UNSET"),
    by_side: summarizeCalibration(rows, row => row.preferred_side ?? "UNSET"),
    by_prop_type: summarizeCalibration(rows, row => row.prop_type ?? "UNSET"),
    by_form: summarizeCalibration(rows, row => row.recent_form_gate ?? "UNSET"),
    by_role: summarizeCalibration(rows, row => row.role_gate ?? "UNSET"),
  });
}

async function getPitchers(env: Env, url: URL): Promise<Response> {
  const search = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const query = search
    ? `
      SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active
      FROM pitchers
      WHERE canonical_name LIKE ? COLLATE NOCASE
      ORDER BY canonical_name
      LIMIT ?
    `
    : `
      SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active
      FROM pitchers
      ORDER BY canonical_name
      LIMIT ?
    `;

  const statement = search
    ? env.DB.prepare(query).bind(`%${search}%`, limit)
    : env.DB.prepare(query).bind(limit);

  const result = await statement.all();
  return json({ rows: result.results });
}

async function getPitcherHistory(env: Env, pitcherId: number): Promise<Response> {
  const pitcher = await env.DB.prepare(`
    SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active
    FROM pitchers
    WHERE pitcher_id = ?
  `).bind(pitcherId).first();

  if (!pitcher) {
    return json({ error: "Pitcher not found" }, { status: 404 });
  }

  const history = await env.DB.prepare(`
    SELECT
      pgs.game_date,
      t.abbreviation AS opponent,
      pgs.innings_pitched,
      pgs.strikeouts,
      pgs.batters_faced,
      pgs.pitch_count,
      pgs.starter,
      pgs.source
    FROM pitcher_game_stats pgs
    LEFT JOIN teams t ON t.team_id = pgs.opponent_team_id
    WHERE pgs.pitcher_id = ?
    ORDER BY pgs.game_date DESC
    LIMIT 50
  `).bind(pitcherId).all();

  return json({ pitcher, history: history.results });
}

async function getRecentResults(env: Env, url: URL): Promise<Response> {
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const result = await env.DB.prepare(`
    SELECT
      b.board_date,
      pi.canonical_name AS pitcher,
      t.abbreviation AS opponent,
      p.strikeout_line,
      pr.actual_strikeouts,
      pr.result,
      pr.result_status,
      pr.graded_at
    FROM prop_results pr
    JOIN props p ON p.prop_id = pr.prop_id
    JOIN boards b ON b.board_id = p.board_id
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    ORDER BY b.board_date DESC, p.source_row, p.prop_id
    LIMIT ?
  `).bind(limit).all();

  return json({ rows: result.results });
}

interface BoardInput {
  board_date?: string;
  board_name?: string;
}

interface PropInput {
  pitcher_id?: number;
  opponent_team_id?: number | null;
  strikeout_line?: number;
  available_side?: string;
  prop_type?: string;
}

function requireEmail(identity: AccessIdentity): string {
  if (!identity.email) {
    throw new Response(
      JSON.stringify({ error: "Authenticated Access identity has no email claim." }),
      { status: 403, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return identity.email;
}

async function parseJson<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new Response(
      JSON.stringify({ error: "Invalid JSON request body." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}

function validateDate(value: unknown): string {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Response(
      JSON.stringify({ error: "board_date must use YYYY-MM-DD." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return date;
}

function validateLine(value: unknown): number {
  const line = Number(value);
  if (!Number.isFinite(line) || line < 0.5 || line > 15.5 || Math.round(line * 2) !== line * 2) {
    throw new Response(
      JSON.stringify({ error: "strikeout_line must be a half-step from 0.5 through 15.5." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return line;
}

function validateAvailableSide(value: unknown): string {
  const side = String(value ?? "Both");
  if (!["Both", "More only"].includes(side)) {
    throw new Response(
      JSON.stringify({ error: "available_side must be Both or More only." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return side;
}

function validatePropType(value: unknown): string {
  const type = String(value ?? "Standard");
  if (!["Standard", "Green Goblin", "Red Goblin"].includes(type)) {
    throw new Response(
      JSON.stringify({ error: "prop_type must be Standard, Green Goblin, or Red Goblin." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return type;
}

async function assertRefreshableBoard(env: Env, boardId: number): Promise<Record<string, unknown>> {
  const board = await env.DB.prepare(`
    SELECT board_id, board_date, board_name, status, source, created_at, updated_at
    FROM boards
    WHERE board_id = ?
  `).bind(boardId).first<Record<string, unknown>>();

  if (!board) {
    throw new Response(
      JSON.stringify({ error: "Board not found." }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  if (!["DRAFT", "ACTIVE"].includes(String(board.status))) {
    throw new Response(
      JSON.stringify({ error: "Only DRAFT or ACTIVE boards can refresh data." }),
      { status: 409, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  return board;
}

async function assertEditableBoard(env: Env, boardId: number): Promise<Record<string, unknown>> {
  const board = await env.DB.prepare(`
   SELECT board_id, board_date, board_name, status, source, created_at, updated_at
    FROM boards
    WHERE board_id = ?
  `).bind(boardId).first<Record<string, unknown>>();

  if (!board) {
    throw new Response(
      JSON.stringify({ error: "Board not found." }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  if (board.status !== "DRAFT") {
    throw new Response(
      JSON.stringify({ error: "Only DRAFT boards can be edited." }),
      { status: 409, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  return board;
}

async function audit(
  env: Env,
  identity: AccessIdentity,
  eventType: string,
  entityType: string,
  entityId: number | null,
  details: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO web_audit_events (
      event_type, entity_type, entity_id, event_details, actor_email, actor_subject, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    eventType,
    entityType,
    entityId,
    JSON.stringify(details),
    identity.email,
    identity.subject,
  ).run();
}

async function getEditorBootstrap(request: Request, env: Env): Promise<Response> {
  const identity = await requireAccessIdentity(request, env);

  const [pitchers, teams, boards] = await Promise.all([
    env.DB.prepare(`
      SELECT pitcher_id, canonical_name, mlb_id, throws_hand
      FROM pitchers
      WHERE active = 1
      ORDER BY canonical_name
    `).all(),
    env.DB.prepare(`
      SELECT team_id, abbreviation, full_name
      FROM teams
      ORDER BY abbreviation
    `).all(),
    env.DB.prepare(`
      SELECT
        b.board_id, b.board_date, b.board_name, b.status, b.source,
        b.created_at, b.updated_at,
        COUNT(p.prop_id) AS prop_count
      FROM boards b
      LEFT JOIN props p ON p.board_id = b.board_id
      GROUP BY b.board_id
      ORDER BY b.board_date DESC, b.board_id DESC
      LIMIT 100
    `).all(),
  ]);

  return json({
    identity: { email: identity.email, subject: identity.subject },
    pitchers: pitchers.results,
    teams: teams.results,
    boards: boards.results,
  });
}

async function getBoardById(env: Env, boardId: number): Promise<Response> {
const board = await env.DB.prepare(`
  SELECT board_id, board_date, board_name, status, source, created_at, updated_at
  FROM boards
  WHERE board_id = ?
`).bind(boardId).first();

  if (!board) {
    return json({ error: "Board not found." }, { status: 404 });
  }

  const props = await env.DB.prepare(`
    SELECT
      p.prop_id, p.source_row, p.pitcher_id, pi.canonical_name AS pitcher,
      p.opponent_team_id, t.abbreviation AS opponent,
      p.strikeout_line,
      p.available_side,
      p.prop_type,
      r.projected_strikeouts,
      r.model_edge,
      r.estimated_over_rate,
      r.preferred_side,
      r.projection_status,
      r.confidence_score,
      r.confidence_band,
      r.decision_tier,
      r.model_decision,
      r.final_decision,
      r.final_reason,
      r.initial_classification,
      r.final_classification,
      r.final_card,
      r.actually_played,
      r.opening_line,
      r.recommended_line,
      r.closing_line,
      r.market_type,
      r.finalized_at,
      r.change_reason,
      r.completeness_score,
      r.starter_confirmed,
      r.lineup_confirmed,
      r.weather_checked,
      r.umpire_checked,
      r.game_pk,
      r.scheduled_first_pitch,
      r.last_pregame_checked_at,
      r.last_successful_refresh_at,
      r.pregame_check_status,
      r.pregame_check_message,
      fs.opponent_k_rate,
      fs.handedness_edge,
      fs.last_3_k_avg,
      fs.last_5_k_avg,
      fs.last_10_k_avg,
      fs.average_bf_last_5,
      fs.average_pitch_count_last_5,
      fs.starter_rate_last_10,
      fs.recent_form_gate,
      fs.volume_gate,
      fs.role_gate,
      fs.matchup_gate,
      pr.actual_strikeouts,
      pr.result,
      pr.result_status,
      pr.innings_pitched,
      pr.pitch_count,
      pr.batters_faced,
      pr.starter AS result_starter,
      pr.suggested_reason_code,
      pr.postgame_reason_code,
      pr.early_exit_reason,
      pr.postgame_review_status,
      pr.graded_at
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    LEFT JOIN recommendations r
      ON r.prop_id = p.prop_id
     AND r.model_version_id = (
       SELECT model_version_id
       FROM model_versions
       WHERE is_active = 1
       ORDER BY model_version_id DESC
       LIMIT 1
     )
    LEFT JOIN feature_snapshots fs
      ON fs.feature_snapshot_id = (
        SELECT fs2.feature_snapshot_id
        FROM feature_snapshots fs2
        WHERE fs2.prop_id = p.prop_id
          AND fs2.model_version_id = r.model_version_id
        ORDER BY fs2.snapshot_time DESC, fs2.feature_snapshot_id DESC
        LIMIT 1
      )
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
    ORDER BY COALESCE(p.source_row, 99999), p.prop_id
  `).bind(boardId).all();

  const automationSummary = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_props,
      SUM(CASE WHEN r.pregame_check_status = 'READY' THEN 1 ELSE 0 END) AS ready_props,
      SUM(CASE WHEN r.pregame_check_status = 'PARTIAL' THEN 1 ELSE 0 END) AS partial_props,
      SUM(CASE WHEN r.pregame_check_status = 'STALE' THEN 1 ELSE 0 END) AS stale_props,
      SUM(CASE WHEN r.pregame_check_status = 'PENDING' OR r.pregame_check_status IS NULL THEN 1 ELSE 0 END) AS pending_props,
      MAX(r.last_pregame_checked_at) AS last_checked_at,
      MAX(r.last_successful_refresh_at) AS last_successful_refresh_at
    FROM props p
    LEFT JOIN recommendations r ON r.prop_id = p.prop_id
      AND r.model_version_id = (
        SELECT model_version_id FROM model_versions WHERE is_active = 1
        ORDER BY model_version_id DESC LIMIT 1
      )
    WHERE p.board_id = ?
  `).bind(boardId).first<Record<string, unknown>>();

  const automationRuns = await env.DB.prepare(`
    SELECT automation_run_id, run_type, trigger_source, started_at, completed_at, status,
           games_checked, props_matched, starter_confirmed, lineup_confirmed,
           weather_checked, umpire_checked, stale_props, details
    FROM automation_runs
    WHERE board_id = ?
    ORDER BY automation_run_id DESC
    LIMIT 8
  `).bind(boardId).all();

  return json({
    board,
    props: props.results,
    automation: {
      summary: automationSummary ?? {},
      recent_runs: automationRuns.results,
    },
  });
}

async function createBoard(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  const input = await parseJson<BoardInput>(request);
  const boardDate = validateDate(input.board_date);
  const boardName = String(input.board_name ?? `PrizePicks ${boardDate}`).trim().slice(0, 120);

  const existing = await env.DB.prepare(`
    SELECT board_id, status
    FROM boards
    WHERE board_date = ? AND status IN ('DRAFT', 'ACTIVE')
    LIMIT 1
  `).bind(boardDate).first();

  if (existing) {
    return json(
      { error: "A DRAFT or ACTIVE board already exists for this date.", existing },
      { status: 409 },
    );
  }

const result = await env.DB.prepare(`
  INSERT INTO boards (
    board_date, board_name, status, source, created_at, updated_at
  )
  VALUES (?, ?, 'DRAFT', 'WEB_EDITOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).bind(boardDate, boardName).run();

  const boardId = Number(result.meta.last_row_id);
  await audit(env, identity, "BOARD_CREATED", "BOARD", boardId, {
    board_date: boardDate,
    board_name: boardName,
  });

  return json({ board_id: boardId, status: "DRAFT" }, { status: 201 });
}

async function updateBoard(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  const board = await assertEditableBoard(env, boardId);
  const input = await parseJson<BoardInput>(request);
  const boardDate = input.board_date === undefined
    ? String(board.board_date)
    : validateDate(input.board_date);
  const boardName = input.board_name === undefined
    ? String(board.board_name ?? "")
    : String(input.board_name).trim().slice(0, 120);

  await env.DB.prepare(`
    UPDATE boards
    SET board_date = ?, board_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE board_id = ?
  `).bind(boardDate, boardName, boardId).run();

  await audit(env, identity, "BOARD_UPDATED", "BOARD", boardId, {
    board_date: boardDate,
    board_name: boardName,
  });

  return json({ ok: true });
}

async function createProp(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  await assertEditableBoard(env, boardId);
  const input = await parseJson<PropInput>(request);

  const pitcherId = Number(input.pitcher_id);
  const opponentTeamId = input.opponent_team_id == null ? null : Number(input.opponent_team_id);
  const strikeoutLine = validateLine(input.strikeout_line);
  const availableSide = validateAvailableSide(input.available_side);
  const propType = validatePropType(input.prop_type);

  if (!Number.isInteger(pitcherId) || pitcherId < 1) {
    return json({ error: "pitcher_id is required." }, { status: 400 });
  }
  if (opponentTeamId !== null && (!Number.isInteger(opponentTeamId) || opponentTeamId < 1)) {
    return json({ error: "opponent_team_id must be a valid team ID or null." }, { status: 400 });
  }

  const pitcher = await env.DB.prepare(`
    SELECT pitcher_id, canonical_name
    FROM pitchers
    WHERE pitcher_id = ? AND active = 1
  `).bind(pitcherId).first();

  if (!pitcher) {
    return json({ error: "Active pitcher not found." }, { status: 400 });
  }

  if (opponentTeamId !== null) {
    const team = await env.DB.prepare(`
      SELECT team_id FROM teams WHERE team_id = ?
    `).bind(opponentTeamId).first();
    if (!team) {
      return json({ error: "Opponent team not found." }, { status: 400 });
    }
  }

  const duplicate = await env.DB.prepare(`
    SELECT prop_id
    FROM props
    WHERE board_id = ? AND pitcher_id = ? AND strikeout_line = ?
    LIMIT 1
  `).bind(boardId, pitcherId, strikeoutLine).first();

  if (duplicate) {
    return json(
      { error: "That pitcher and line already exist on this board.", duplicate },
      { status: 409 },
    );
  }

  const nextRow = await env.DB.prepare(`
    SELECT COALESCE(MAX(source_row), 0) + 1 AS next_row
    FROM props
    WHERE board_id = ?
  `).bind(boardId).first<{ next_row: number }>();

const result = await env.DB.prepare(`
  INSERT INTO props (
    board_id,
    pitcher_id,
    opponent_team_id,
    strikeout_line,
    available_side,
    prop_type,
    source,
    source_row,
    status,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, 'WEB_EDITOR', NULL, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).bind(
  boardId,
  pitcherId,
  opponentTeamId,
  strikeoutLine,
  availableSide,
  propType,
).run();

  const propId = Number(result.meta.last_row_id);
  await audit(env, identity, "PROP_CREATED", "PROP", propId, {
    board_id: boardId,
    pitcher_id: pitcherId,
    opponent_team_id: opponentTeamId,
    strikeout_line: strikeoutLine,
    available_side: availableSide,
    prop_type: propType,
  });

  return json({ prop_id: propId }, { status: 201 });
}

async function updateProp(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  propId: number,
): Promise<Response> {
  const existing = await env.DB.prepare(`
    SELECT p.*, b.status AS board_status
    FROM props p
    JOIN boards b ON b.board_id = p.board_id
    WHERE p.prop_id = ?
  `).bind(propId).first<Record<string, unknown>>();

  if (!existing) {
    return json({ error: "Prop not found." }, { status: 404 });
  }
  if (existing.board_status !== "DRAFT") {
    return json({ error: "Only props on DRAFT boards can be edited." }, { status: 409 });
  }

  const input = await parseJson<PropInput>(request);
  const pitcherId = input.pitcher_id === undefined ? Number(existing.pitcher_id) : Number(input.pitcher_id);
  const opponentTeamId = input.opponent_team_id === undefined
    ? (existing.opponent_team_id == null ? null : Number(existing.opponent_team_id))
    : (input.opponent_team_id == null ? null : Number(input.opponent_team_id));
  const strikeoutLine = input.strikeout_line === undefined
    ? Number(existing.strikeout_line)
    : validateLine(input.strikeout_line);
  const availableSide = input.available_side === undefined
    ? String(existing.available_side)
    : validateAvailableSide(input.available_side);
  const propType = input.prop_type === undefined
    ? String(existing.prop_type)
    : validatePropType(input.prop_type);

  const duplicate = await env.DB.prepare(`
    SELECT prop_id
    FROM props
    WHERE board_id = ? AND pitcher_id = ? AND strikeout_line = ? AND prop_id <> ?
    LIMIT 1
  `).bind(existing.board_id, pitcherId, strikeoutLine, propId).first();

  if (duplicate) {
    return json({ error: "That pitcher and line already exist on this board." }, { status: 409 });
  }

await env.DB.prepare(`
  UPDATE props
  SET pitcher_id = ?,
      opponent_team_id = ?,
      strikeout_line = ?,
      available_side = ?,
      prop_type = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE prop_id = ?
`).bind(
  pitcherId,
  opponentTeamId,
  strikeoutLine,
  availableSide,
  propType,
  propId,
).run();

  await audit(env, identity, "PROP_UPDATED", "PROP", propId, {
    pitcher_id: pitcherId,
    opponent_team_id: opponentTeamId,
    strikeout_line: strikeoutLine,
    available_side: availableSide,
    prop_type: propType,
  });

  return json({ ok: true });
}

async function deleteProp(
  env: Env,
  identity: AccessIdentity,
  propId: number,
): Promise<Response> {
  const existing = await env.DB.prepare(`
    SELECT p.prop_id, p.board_id, b.status AS board_status,
           EXISTS(SELECT 1 FROM prop_results pr WHERE pr.prop_id = p.prop_id) AS has_result
    FROM props p
    JOIN boards b ON b.board_id = p.board_id
    WHERE p.prop_id = ?
  `).bind(propId).first<Record<string, unknown>>();

  if (!existing) {
    return json({ error: "Prop not found." }, { status: 404 });
  }
  if (existing.board_status !== "DRAFT") {
    return json({ error: "Only props on DRAFT boards can be deleted." }, { status: 409 });
  }
  if (Number(existing.has_result) === 1) {
    return json({ error: "Props with results cannot be deleted." }, { status: 409 });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM recommendations WHERE prop_id = ?").bind(propId),
    env.DB.prepare("DELETE FROM feature_snapshots WHERE prop_id = ?").bind(propId),
    env.DB.prepare("DELETE FROM props WHERE prop_id = ?").bind(propId),
  ]);

  await audit(env, identity, "PROP_DELETED", "PROP", propId, {
    board_id: existing.board_id,
  });

  return json({ ok: true });
}


interface ProcessPropRow {
  prop_id: number;
  pitcher_id: number;
  opponent_team_id: number | null;
  strikeout_line: number;
  available_side: string;
  prop_type: string;
  canonical_name: string;
  mlb_id: number | null;
  throws_hand: string | null;
  board_date: string;
}

interface RecentStartRow {
  game_date: string;
  innings_pitched: number | null;
  strikeouts: number | null;
  batters_faced: number | null;
  pitch_count: number | null;
  starter: number;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = average(values)!;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function estimateOverRate(edge: number, projectionSd: number): number {
  const scale = Math.max(projectionSd, 1.25);
  return clamp(1 / (1 + Math.exp(-(edge / scale) * 1.7)), 0.05, 0.95);
}

function classifyRecommendation(
  edge: number,
  startCount: number,
  roleStable: boolean,
  recentFormGate: string,
  volumeGate: string,
  availableSide: string,
): {
  preferredSide: string;
  modelDecision: string;
  confidenceScore: number;
  confidenceBand: string;
  confidenceCap: number;
  decisionTier: string;
  coreBlockCount: number;
} {
  const preferredSide = edge >= 0 ? "More" : "Less";
  const absoluteEdge = Math.abs(edge);

  let confidenceScore = 35;
  if (absoluteEdge >= 0.5) confidenceScore += 10;
  if (absoluteEdge >= 1.0) confidenceScore += 15;
  if (absoluteEdge >= 1.5) confidenceScore += 10;
  if (startCount >= 5) confidenceScore += 10;
  if (roleStable) confidenceScore += 10;
  if (recentFormGate === "PASS") confidenceScore += 5;
  if (volumeGate === "PASS") confidenceScore += 5;

  let confidenceCap = 95;
  if (startCount === 3) confidenceCap = Math.min(confidenceCap, 55);
  if (startCount === 4) confidenceCap = Math.min(confidenceCap, 65);
  if (!roleStable) confidenceCap = Math.min(confidenceCap, 60);
  if (volumeGate === "FAIL") confidenceCap = Math.min(confidenceCap, 55);
  if (recentFormGate === "FAIL") confidenceCap = Math.min(confidenceCap, 60);

  confidenceScore = clamp(confidenceScore, 25, confidenceCap);

  let modelDecision =
    startCount < 3 || !roleStable ? "WATCH" :
    absoluteEdge >= 1.0 ? "PLAY" :
    absoluteEdge >= 0.5 ? "LEAN" :
    "PASS";

  if (recentFormGate === "FAIL" && modelDecision === "PLAY") {
    modelDecision = "LEAN";
  }
  if (volumeGate === "FAIL" && modelDecision === "PLAY") {
    modelDecision = "WATCH";
  }
  if (volumeGate === "WATCH" && modelDecision === "PLAY" && absoluteEdge < 1.5) {
    modelDecision = "LEAN";
  }
  if (availableSide === "More only" && preferredSide === "Less") {
    modelDecision = "AUTO PASS";
  }

  const confidenceBand =
    confidenceScore >= 80 ? "HIGH" :
    confidenceScore >= 65 ? "MEDIUM" :
    "LOW";

  const coreBlockCount =
    (recentFormGate === "FAIL" ? 1 : 0) +
    (volumeGate === "FAIL" ? 1 : 0) +
    (!roleStable ? 1 : 0);

  const decisionTier =
    modelDecision === "PLAY" && confidenceBand === "HIGH" && coreBlockCount === 0 ? "CORE" :
    modelDecision === "PLAY" ? "SECONDARY" :
    modelDecision === "LEAN" ? "LEAN" :
    modelDecision;

  return {
    preferredSide,
    modelDecision,
    confidenceScore,
    confidenceBand,
    confidenceCap,
    decisionTier,
    coreBlockCount,
  };
}


interface V11ScoreInput {
  modelEdge: number;
  estimatedOverRate: number;
  recentFormGate: string;
  volumeGate: string;
  matchupGate: string;
  roleGate: string;
  completenessScore: number;
  availableSide: string;
  preferredSide: string;
  usableStarts: number;
}

function scoreRecommendationV11(input: V11ScoreInput) {
  const absoluteEdge = Math.abs(input.modelEdge);
  const probabilityEdge = Math.abs(input.estimatedOverRate - 0.5) * 2;
  const projection = clamp((absoluteEdge / 1.5) * 24 + probabilityEdge * 6, 0, 30);
  const recentForm = input.recentFormGate === "PASS" ? 15 : input.recentFormGate === "WATCH" ? 8 : 2;
  const volume = input.volumeGate === "PASS" ? 15 : input.volumeGate === "WATCH" ? 8 : 2;
  const matchup = input.matchupGate === "STRONG PASS" ? 20
    : input.matchupGate === "PASS" ? 17
    : input.matchupGate === "NEUTRAL" ? 12
    : input.matchupGate === "WATCH" ? 6
    : input.matchupGate === "FAIL" ? 2 : 4;
  const role = input.roleGate === "PASS" ? 10 : input.roleGate === "WATCH" ? 6 : 2;
  const completeness = clamp(input.completenessScore / 10, 0, 10);
  let score = projection + recentForm + volume + matchup + role + completeness;

  const blockers: string[] = [];
  if (input.usableStarts < 3) blockers.push("INSUFFICIENT_SAMPLE");
  if (input.roleGate === "FAIL") blockers.push("UNSTABLE_ROLE");
  if (input.volumeGate === "FAIL") blockers.push("FAILED_VOLUME_GATE");
  if (input.availableSide === "More only" && input.preferredSide === "Less") blockers.push("SIDE_UNAVAILABLE");

  const hardConflict = blockers.includes("SIDE_UNAVAILABLE") || blockers.includes("INSUFFICIENT_SAMPLE");
  if (input.roleGate === "FAIL") score = Math.min(score, 49);
  if (input.volumeGate === "FAIL") score = Math.min(score, 59);
  if (input.recentFormGate === "FAIL") score = Math.min(score, 64);
  if (hardConflict) score = Math.min(score, 39);
  score = Math.round(clamp(score, 0, 100));

  const band = hardConflict ? "AUTO PASS"
    : score >= 85 ? "CORE CANDIDATE"
    : score >= 75 ? "STRONG LEAN"
    : score >= 65 ? "LEAN"
    : score >= 50 ? "WATCH"
    : "PASS";
  const modelDecision = band === "CORE CANDIDATE" || band === "STRONG LEAN" ? "PLAY"
    : band === "LEAN" ? "LEAN"
    : band === "WATCH" ? "WATCH"
    : band === "AUTO PASS" ? "AUTO PASS" : "PASS";
  const decisionTier = band === "CORE CANDIDATE" ? "CORE"
    : band === "STRONG LEAN" ? "SECONDARY"
    : band === "LEAN" ? "LEAN" : modelDecision;

  return {
    score, band, modelDecision, decisionTier, blockers,
    components: {
      projection: Math.round(projection * 10) / 10,
      recent_form: recentForm,
      volume,
      matchup,
      role,
      completeness: Math.round(completeness * 10) / 10,
    },
  };
}


function lifecycleClassification(decisionTier: string, modelDecision: string): string {
  if (decisionTier === "CORE") return "CORE CANDIDATE";
  if (decisionTier === "SECONDARY") return "STRONG LEAN";
  if (decisionTier === "LEAN" || modelDecision === "LEAN") return "SHEET LEAN";
  if (modelDecision === "WATCH") return "WATCH";
  if (modelDecision === "PASS" || modelDecision === "AUTO PASS") return "PASS";
  return modelDecision || "WATCH";
}

function lifecycleCompleteness(input: {
  usableStarts: number;
  hasMatchup: boolean;
  hasPitchCount: boolean;
  hasBattersFaced: boolean;
  roleStable: boolean;
  hasOpponent: boolean;
  hasThrowingHand: boolean;
  starterConfirmed?: boolean;
  lineupConfirmed?: boolean;
  weatherChecked?: boolean;
  umpireChecked?: boolean;
}): number {
  let score = 0;
  score += input.usableStarts >= 5 ? 25 : input.usableStarts >= 3 ? 15 : input.usableStarts > 0 ? 5 : 0;
  if (input.hasMatchup) score += 20;
  if (input.hasPitchCount) score += 10;
  if (input.hasBattersFaced) score += 10;
  if (input.roleStable) score += 10;
  if (input.hasOpponent) score += 5;
  if (input.hasThrowingHand) score += 5;
  if (input.starterConfirmed) score += 5;
  if (input.lineupConfirmed) score += 4;
  if (input.weatherChecked) score += 3;
  if (input.umpireChecked) score += 3;
  return Math.min(100, score);
}


interface MlbPerson {
  id?: number;
  fullName?: string;
  active?: boolean;
  pitchHand?: { code?: string; description?: string };
  currentTeam?: { id?: number; name?: string };
  primaryPosition?: {
    type?: string;
    abbreviation?: string;
  };
}

interface MlbGameLogSplit {
  date?: string;
  game?: { gamePk?: number };
  opponent?: { id?: number; name?: string };
  stat?: Record<string, unknown>;
}

interface RefreshPitcherResult {
  pitcher_id: number;
  pitcher: string;
  mlb_id: number | null;
  id_resolved: boolean;
  games_loaded: number;
  warning?: string;
}

function normalizePlayerName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'’\-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inningsToDecimal(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d))?$/);
  if (!match) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const whole = Number(match[1]);
  const outs = Number(match[2] ?? 0);
  if (outs === 1) return whole + 1 / 3;
  if (outs === 2) return whole + 2 / 3;
  return whole;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchMlbJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`MLB Stats API returned HTTP ${response.status}.`);
  }
  return await response.json() as Record<string, unknown>;
}

async function findExactMlbPitcher(canonicalName: string): Promise<MlbPerson> {
  const searchUrl = new URL("https://statsapi.mlb.com/api/v1/people/search");
  searchUrl.searchParams.set("names", canonicalName);
  const payload = await fetchMlbJson(searchUrl.toString());
  const people = Array.isArray(payload.people) ? payload.people as MlbPerson[] : [];
  const target = normalizePlayerName(canonicalName);

  const exact = people.filter((person) =>
    Number.isInteger(Number(person.id)) &&
    normalizePlayerName(person.fullName) === target &&
    (
      person.primaryPosition?.type === "Pitcher" ||
      person.primaryPosition?.abbreviation === "P"
    )
  );

  const activeExact = exact.filter((person) => person.active !== false);
  const candidates = activeExact.length ? activeExact : exact;
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? `MLB pitcher match is ambiguous (${candidates.length} exact matches).`
        : "No exact MLB pitcher match was found.",
    );
  }

  const candidate = candidates[0];
  if (candidate.pitchHand?.code === "R" || candidate.pitchHand?.code === "L") {
    return candidate;
  }

  const personPayload = await fetchMlbJson(
    `https://statsapi.mlb.com/api/v1/people/${Number(candidate.id)}?hydrate=currentTeam`,
  );
  const hydrated = Array.isArray(personPayload.people)
    ? (personPayload.people as MlbPerson[])[0]
    : undefined;
  return hydrated ?? candidate;
}

async function resolveOrCreatePitcher(
  request: Request,
  env: Env,
  identity: AccessIdentity,
): Promise<Response> {
  const input = await parseJson<{ name?: string }>(request);
  const requestedName = String(input.name ?? "").trim().replace(/\s+/g, " ");
  if (!requestedName) return json({ error: "Pitcher name is required." }, { status: 400 });

  const existing = await env.DB.prepare(`
    SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active
    FROM pitchers
    WHERE canonical_name = ? COLLATE NOCASE
    LIMIT 1
  `).bind(requestedName).first<Record<string, unknown>>();

  if (existing) {
    if (Number(existing.active) !== 1) {
      await env.DB.prepare(`
        UPDATE pitchers SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE pitcher_id = ?
      `).bind(existing.pitcher_id).run();
    }
    return json({ pitcher: { ...existing, active: 1 }, created: false });
  }

  const person = await findExactMlbPitcher(requestedName);
  const mlbId = Number(person.id);
  const canonicalName = String(person.fullName ?? requestedName).trim();
  const throwsHand = person.pitchHand?.code === "R" || person.pitchHand?.code === "L"
    ? person.pitchHand.code
    : null;

  if (!throwsHand) {
    return json({ error: `MLB matched ${canonicalName}, but throwing hand could not be resolved.` }, { status: 409 });
  }

  const duplicateByMlbId = await env.DB.prepare(`
    SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active
    FROM pitchers WHERE mlb_id = ? LIMIT 1
  `).bind(mlbId).first<Record<string, unknown>>();

  if (duplicateByMlbId) {
    await env.DB.prepare(`
      UPDATE pitchers SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE pitcher_id = ?
    `).bind(duplicateByMlbId.pitcher_id).run();
    return json({ pitcher: { ...duplicateByMlbId, active: 1 }, created: false });
  }

  const result = await env.DB.prepare(`
    INSERT INTO pitchers (
      canonical_name, mlb_id, throws_hand, current_team, active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    canonicalName,
    mlbId,
    throwsHand,
    person.currentTeam?.id ? (MLB_TEAM_ABBREVIATIONS[Number(person.currentTeam.id)] ?? null) : null,
  ).run();
  const pitcherId = Number(result.meta.last_row_id);

  await audit(env, identity, "PITCHER_AUTO_CREATED", "PITCHER", pitcherId, {
    requested_name: requestedName,
    canonical_name: canonicalName,
    mlb_id: mlbId,
    throws_hand: throwsHand,
  });

  return json({
    pitcher: {
      pitcher_id: pitcherId,
      canonical_name: canonicalName,
      mlb_id: mlbId,
      throws_hand: throwsHand,
      active: 1,
    },
    created: true,
  }, { status: 201 });
}

async function resolveMlbId(
  env: Env,
  pitcherId: number,
  canonicalName: string,
): Promise<number> {
  const person = await findExactMlbPitcher(canonicalName);
  const mlbId = Number(person.id);
  const throwsHand = person.pitchHand?.code === "R" || person.pitchHand?.code === "L"
    ? person.pitchHand.code
    : null;
  await env.DB.prepare(`
    UPDATE pitchers
    SET mlb_id = ?,
        throws_hand = COALESCE(?, throws_hand),
        current_team = COALESCE(?, current_team),
        updated_at = CURRENT_TIMESTAMP
    WHERE pitcher_id = ?
  `).bind(
    mlbId,
    throwsHand,
    person.currentTeam?.id ? (MLB_TEAM_ABBREVIATIONS[Number(person.currentTeam.id)] ?? null) : null,
    pitcherId,
  ).run();
  return mlbId;
}

async function refreshPitcherCurrentTeam(
  env: Env,
  pitcherId: number,
  mlbId: number,
): Promise<void> {
  const payload = await fetchMlbJson(
    `https://statsapi.mlb.com/api/v1/people/${mlbId}?hydrate=currentTeam`,
  );
  const person = Array.isArray(payload.people)
    ? (payload.people as MlbPerson[])[0]
    : undefined;
  const teamId = Number(person?.currentTeam?.id ?? 0);
  const abbreviation = teamId ? MLB_TEAM_ABBREVIATIONS[teamId] : null;

  if (abbreviation) {
    await env.DB.prepare(`
      UPDATE pitchers
      SET current_team = ?, updated_at = CURRENT_TIMESTAMP
      WHERE pitcher_id = ?
    `).bind(abbreviation, pitcherId).run();
  }
}

async function loadPitcherGameLog(
  env: Env,
  pitcherId: number,
  mlbId: number,
  season: number,
): Promise<number> {
  const statsUrl = new URL(`https://statsapi.mlb.com/api/v1/people/${mlbId}/stats`);
  statsUrl.searchParams.set("stats", "gameLog");
  statsUrl.searchParams.set("group", "pitching");
  statsUrl.searchParams.set("season", String(season));

  const payload = await fetchMlbJson(statsUrl.toString());
  const stats = Array.isArray(payload.stats) ? payload.stats as Array<Record<string, unknown>> : [];
  const splits = stats.flatMap((block) =>
    Array.isArray(block.splits) ? block.splits as MlbGameLogSplit[] : []
  );

  let loaded = 0;
  for (const split of splits) {
    if (!split.date || !split.stat) continue;
    const stat = split.stat;
    const gamesStarted = optionalNumber(stat.gamesStarted) ?? 0;
    const starter = gamesStarted > 0 ? 1 : 0;

    await env.DB.prepare(`
      INSERT INTO pitcher_game_stats (
        pitcher_id,
        game_id,
        game_date,
        opponent_team_id,
        innings_pitched,
        strikeouts,
        batters_faced,
        pitch_count,
        earned_runs,
        hits_allowed,
        walks,
        starter,
        source,
        created_at
      )
      VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'MLB Stats API', CURRENT_TIMESTAMP)
      ON CONFLICT(pitcher_id, game_date) DO UPDATE SET
        innings_pitched = excluded.innings_pitched,
        strikeouts = excluded.strikeouts,
        batters_faced = excluded.batters_faced,
        pitch_count = excluded.pitch_count,
        earned_runs = excluded.earned_runs,
        hits_allowed = excluded.hits_allowed,
        walks = excluded.walks,
        starter = excluded.starter,
        source = excluded.source
    `).bind(
      pitcherId,
      split.date,
      inningsToDecimal(stat.inningsPitched),
      optionalNumber(stat.strikeOuts),
      optionalNumber(stat.battersFaced),
      optionalNumber(stat.numberOfPitches ?? stat.pitchesThrown),
      optionalNumber(stat.earnedRuns),
      optionalNumber(stat.hits),
      optionalNumber(stat.baseOnBalls),
      starter,
    ).run();
    loaded += 1;
  }

  return loaded;
}

async function refreshBoardPitcherData(
  env: Env,
  boardId: number,
  boardDate: string,
  offset = 0,
  limit = 5,
): Promise<{ results: RefreshPitcherResult[]; total: number; next_offset: number | null }> {
  const countRow = await env.DB.prepare(`
    SELECT COUNT(DISTINCT pi.pitcher_id) AS total
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    WHERE p.board_id = ?
  `).bind(boardId).first<{ total: number }>();

  const total = Number(countRow?.total ?? 0);
  const pitchers = await env.DB.prepare(`
    SELECT DISTINCT
      pi.pitcher_id,
      pi.canonical_name,
      pi.mlb_id
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    WHERE p.board_id = ?
    ORDER BY pi.canonical_name
    LIMIT ? OFFSET ?
  `).bind(boardId, limit, offset).all<{
    pitcher_id: number;
    canonical_name: string;
    mlb_id: number | null;
  }>();

  const season = Number(String(boardDate).slice(0, 4));
  const results: RefreshPitcherResult[] = [];

  for (const pitcher of pitchers.results) {
    let mlbId = pitcher.mlb_id == null ? null : Number(pitcher.mlb_id);
    let idResolved = false;
    try {
      if (!mlbId) {
        mlbId = await resolveMlbId(env, pitcher.pitcher_id, pitcher.canonical_name);
        idResolved = true;
      }
      await refreshPitcherCurrentTeam(env, pitcher.pitcher_id, mlbId);
      const gamesLoaded = await loadPitcherGameLog(
        env,
        pitcher.pitcher_id,
        mlbId,
        season,
      );
      results.push({
        pitcher_id: pitcher.pitcher_id,
        pitcher: pitcher.canonical_name,
        mlb_id: mlbId,
        id_resolved: idResolved,
        games_loaded: gamesLoaded,
        warning: gamesLoaded ? undefined : `No ${season} pitching game-log rows were returned.`,
      });
    } catch (error) {
      results.push({
        pitcher_id: pitcher.pitcher_id,
        pitcher: pitcher.canonical_name,
        mlb_id: mlbId,
        id_resolved: idResolved,
        games_loaded: 0,
        warning: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nextOffset = offset + pitchers.results.length < total
    ? offset + pitchers.results.length
    : null;

  return { results, total, next_offset: nextOffset };
}


interface TeamHandednessRow {
  opponent_k_rate: number;
  season_opponent_k_rate: number;
  recent_30_k_rate: number | null;
  recent_14_k_rate: number | null;
  handedness_edge: number;
  opponent_trend_delta: number | null;
  opponent_sample_confidence: string;
  plate_appearances: number;
  strikeouts: number;
  refreshed_at: string;
}

interface MatchupRefreshResult {
  team_id: number;
  team: string;
  pitcher_hand: string;
  plate_appearances: number;
  strikeouts: number;
  strikeout_rate: number;
  recent_30_k_rate?: number | null;
  recent_14_k_rate?: number | null;
  blended_k_rate?: number | null;
  sample_confidence?: string;
  warning?: string;
}

const MLB_TEAM_IDS: Record<string, number> = {
  AZ: 109, ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145,
  CIN: 113, CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, KCR: 118,
  LAA: 108, LAD: 119, MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147,
  OAK: 133, ATH: 133, PHI: 143, PIT: 134, SD: 135, SDP: 135, SEA: 136,
  SF: 137, SFG: 137, STL: 138, TB: 139, TBR: 139, TEX: 140, TOR: 141,
  WSH: 120, WAS: 120,
};

const MLB_TEAM_ABBREVIATIONS: Record<number, string> = Object.fromEntries(
  Object.entries(MLB_TEAM_IDS)
    .filter(([abbreviation]) => abbreviation !== "AZ" && abbreviation !== "CHW")
    .map(([abbreviation, teamId]) => [teamId, abbreviation]),
) as Record<number, string>;


const LEAGUE_BASELINE_K_RATE = 0.225;


function isoDateDaysBefore(dateText: string, days: number): string {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function shrinkRate(
  rate: number | null,
  plateAppearances: number | null,
  prior = LEAGUE_BASELINE_K_RATE,
  priorStrength = 250,
): number | null {
  if (rate === null || plateAppearances === null || plateAppearances <= 0) return null;
  const reliability = plateAppearances / (plateAppearances + priorStrength);
  return prior + (rate - prior) * reliability;
}

function blendOpponentRates(input: {
  seasonRate: number;
  seasonPa: number;
  recent30Rate: number | null;
  recent30Pa: number | null;
  recent14Rate: number | null;
  recent14Pa: number | null;
}): {
  blendedRate: number;
  trendDelta: number | null;
  confidence: string;
} {
  const season = shrinkRate(input.seasonRate, input.seasonPa, LEAGUE_BASELINE_K_RATE, 400)
    ?? input.seasonRate;
  const recent30 = shrinkRate(input.recent30Rate, input.recent30Pa, LEAGUE_BASELINE_K_RATE, 250);
  const recent14 = shrinkRate(input.recent14Rate, input.recent14Pa, LEAGUE_BASELINE_K_RATE, 175);

  const components: Array<{ value: number; weight: number }> = [
    { value: season, weight: 0.50 },
  ];
  if (recent30 !== null) components.push({ value: recent30, weight: 0.30 });
  if (recent14 !== null) components.push({ value: recent14, weight: 0.20 });

  const totalWeight = components.reduce((sum, row) => sum + row.weight, 0);
  const blendedRate = components.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;

  const confidence =
    input.seasonPa >= 800 && (input.recent30Pa ?? 0) >= 500 ? "HIGH" :
    input.seasonPa >= 350 && (input.recent30Pa ?? 0) >= 250 ? "MEDIUM" :
    "LOW";

  const recentRates = [
    input.recent30Rate,
    input.recent14Rate,
  ].filter((value): value is number => value !== null);

  const recentAverage = recentRates.length
    ? recentRates.reduce((sum, value) => sum + value, 0) / recentRates.length
    : null;

  return {
    blendedRate,
    trendDelta: recentAverage === null ? null : recentAverage - input.seasonRate,
    confidence,
  };
}

async function fetchTeamDateRangeSplit(
  mlbTeamId: number,
  startDate: string,
  endDate: string,
): Promise<{ plateAppearances: number; strikeouts: number; strikeoutRate: number }> {
  const url = new URL(`https://statsapi.mlb.com/api/v1/teams/${mlbTeamId}/stats`);
  url.searchParams.set("stats", "byDateRange");
  url.searchParams.set("group", "hitting");
  url.searchParams.set("gameType", "R");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const payload = await fetchMlbJson(url.toString());
  const { plateAppearances, strikeouts } = extractTeamSplit(payload);
  return {
    plateAppearances,
    strikeouts,
    strikeoutRate: strikeouts / plateAppearances,
  };
}

function extractTeamSplit(payload: Record<string, unknown>): { plateAppearances: number; strikeouts: number } {
  const blocks = Array.isArray(payload.stats) ? payload.stats as Array<Record<string, unknown>> : [];
  const splits = blocks.flatMap((block) =>
    Array.isArray(block.splits) ? block.splits as Array<Record<string, unknown>> : []
  );
  const split = splits[0];
  const stat = split && typeof split.stat === "object" && split.stat !== null
    ? split.stat as Record<string, unknown>
    : null;
  if (!stat) throw new Error("MLB team split response contained no statistics.");
  const plateAppearances = optionalNumber(stat.plateAppearances);
  const strikeouts = optionalNumber(stat.strikeOuts);
  if (plateAppearances === null || plateAppearances <= 0 || strikeouts === null) {
    throw new Error("MLB team split response was missing plate appearances or strikeouts.");
  }
  return { plateAppearances, strikeouts };
}

async function refreshOpponentHandednessData(
  env: Env,
  boardId: number,
  boardDate: string,
  offset = 0,
  limit = 5,
): Promise<{ results: MatchupRefreshResult[]; total: number; next_offset: number | null }> {
  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM (
      SELECT DISTINCT t.team_id, t.abbreviation, pi.throws_hand
      FROM props p
      JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
      LEFT JOIN teams t ON t.team_id = p.opponent_team_id
      WHERE p.board_id = ?
    )
  `).bind(boardId).first<{ total: number }>();

  const total = Number(countRow?.total ?? 0);
  const matchups = await env.DB.prepare(`
    SELECT DISTINCT
      t.team_id,
      t.abbreviation,
      pi.throws_hand
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    WHERE p.board_id = ?
    ORDER BY t.abbreviation, pi.throws_hand
    LIMIT ? OFFSET ?
  `).bind(boardId, limit, offset).all<{
    team_id: number | null;
    abbreviation: string | null;
    throws_hand: string | null;
  }>();

  const season = Number(String(boardDate).slice(0, 4));
  const results: MatchupRefreshResult[] = [];

  for (const matchup of matchups.results) {
    const abbreviation = String(matchup.abbreviation ?? "").toUpperCase();
    const hand = String(matchup.throws_hand ?? "").toUpperCase();
    if (!matchup.team_id || !abbreviation) {
      results.push({
        team_id: Number(matchup.team_id ?? 0), team: abbreviation || "Unknown",
        pitcher_hand: hand || "Unknown", plate_appearances: 0, strikeouts: 0,
        strikeout_rate: 0, warning: "Opponent is missing.",
      });
      continue;
    }
    if (!["R", "L"].includes(hand)) {
      results.push({
        team_id: matchup.team_id, team: abbreviation, pitcher_hand: hand || "Unknown",
        plate_appearances: 0, strikeouts: 0, strikeout_rate: 0,
        warning: "Pitcher throwing hand is missing.",
      });
      continue;
    }
    const mlbTeamId = MLB_TEAM_IDS[abbreviation];
    if (!mlbTeamId) {
      results.push({
        team_id: matchup.team_id, team: abbreviation, pitcher_hand: hand,
        plate_appearances: 0, strikeouts: 0, strikeout_rate: 0,
        warning: `No MLB team ID mapping exists for ${abbreviation}.`,
      });
      continue;
    }

    try {
      const url = new URL(`https://statsapi.mlb.com/api/v1/teams/${mlbTeamId}/stats`);
      url.searchParams.set("stats", "statSplits");
      url.searchParams.set("group", "hitting");
      url.searchParams.set("season", String(season));
      url.searchParams.set("gameType", "R");
      url.searchParams.set("sitCodes", hand === "R" ? "vr" : "vl");
      const payload = await fetchMlbJson(url.toString());
      const { plateAppearances, strikeouts } = extractTeamSplit(payload);
      const strikeoutRate = strikeouts / plateAppearances;
      const handednessEdge = strikeoutRate - LEAGUE_BASELINE_K_RATE;

      const endDate = String(boardDate).slice(0, 10);
      const recent30 = await fetchTeamDateRangeSplit(
        mlbTeamId,
        isoDateDaysBefore(endDate, 30),
        endDate,
      );
      const recent14 = await fetchTeamDateRangeSplit(
        mlbTeamId,
        isoDateDaysBefore(endDate, 14),
        endDate,
      );

      const blended = blendOpponentRates({
        seasonRate: strikeoutRate,
        seasonPa: plateAppearances,
        recent30Rate: recent30.strikeoutRate,
        recent30Pa: recent30.plateAppearances,
        recent14Rate: recent14.strikeoutRate,
        recent14Pa: recent14.plateAppearances,
      });

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO team_handedness_stats (
            team_id, season, pitcher_hand, plate_appearances, strikeouts,
            strikeout_rate, league_average_rate, handedness_edge, source, refreshed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MLB Stats API', CURRENT_TIMESTAMP)
          ON CONFLICT(team_id, season, pitcher_hand) DO UPDATE SET
            plate_appearances = excluded.plate_appearances,
            strikeouts = excluded.strikeouts,
            strikeout_rate = excluded.strikeout_rate,
            league_average_rate = excluded.league_average_rate,
            handedness_edge = excluded.handedness_edge,
            source = excluded.source,
            refreshed_at = CURRENT_TIMESTAMP
        `).bind(
          matchup.team_id, season, hand, plateAppearances, strikeouts,
          strikeoutRate, LEAGUE_BASELINE_K_RATE, handednessEdge,
        ),
        env.DB.prepare(`
          INSERT INTO team_opponent_trends (
            team_id, as_of_date, window_days, start_date, end_date,
            plate_appearances, strikeouts, strikeout_rate, source, refreshed_at
          ) VALUES (?, ?, 30, ?, ?, ?, ?, ?, 'MLB Stats API', CURRENT_TIMESTAMP)
          ON CONFLICT(team_id, as_of_date, window_days) DO UPDATE SET
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            plate_appearances = excluded.plate_appearances,
            strikeouts = excluded.strikeouts,
            strikeout_rate = excluded.strikeout_rate,
            source = excluded.source,
            refreshed_at = CURRENT_TIMESTAMP
        `).bind(
          matchup.team_id, endDate, isoDateDaysBefore(endDate, 30), endDate,
          recent30.plateAppearances, recent30.strikeouts, recent30.strikeoutRate,
        ),
        env.DB.prepare(`
          INSERT INTO team_opponent_trends (
            team_id, as_of_date, window_days, start_date, end_date,
            plate_appearances, strikeouts, strikeout_rate, source, refreshed_at
          ) VALUES (?, ?, 14, ?, ?, ?, ?, ?, 'MLB Stats API', CURRENT_TIMESTAMP)
          ON CONFLICT(team_id, as_of_date, window_days) DO UPDATE SET
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            plate_appearances = excluded.plate_appearances,
            strikeouts = excluded.strikeouts,
            strikeout_rate = excluded.strikeout_rate,
            source = excluded.source,
            refreshed_at = CURRENT_TIMESTAMP
        `).bind(
          matchup.team_id, endDate, isoDateDaysBefore(endDate, 14), endDate,
          recent14.plateAppearances, recent14.strikeouts, recent14.strikeoutRate,
        ),
      ]);

      results.push({
        team_id: matchup.team_id,
        team: abbreviation,
        pitcher_hand: hand,
        plate_appearances: plateAppearances,
        strikeouts,
        strikeout_rate: strikeoutRate,
        recent_30_k_rate: recent30.strikeoutRate,
        recent_14_k_rate: recent14.strikeoutRate,
        blended_k_rate: blended.blendedRate,
        sample_confidence: blended.confidence,
      });
    } catch (error) {
      results.push({
        team_id: matchup.team_id, team: abbreviation, pitcher_hand: hand,
        plate_appearances: 0, strikeouts: 0, strikeout_rate: 0,
        warning: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nextOffset = offset + matchups.results.length < total
    ? offset + matchups.results.length
    : null;

  return { results, total, next_offset: nextOffset };
}

async function getOpponentHandedness(
  env: Env,
  teamId: number | null,
  season: number,
  pitcherHand: string | null,
  asOfDate?: string | null,
): Promise<TeamHandednessRow | null> {
  if (!teamId || !pitcherHand || !["R", "L"].includes(pitcherHand)) return null;

  const seasonRow = await env.DB.prepare(`
    SELECT
      strikeout_rate,
      plate_appearances,
      strikeouts,
      refreshed_at
    FROM team_handedness_stats
    WHERE team_id = ? AND season = ? AND pitcher_hand = ?
  `).bind(teamId, season, pitcherHand).first<{
    strikeout_rate: number;
    plate_appearances: number;
    strikeouts: number;
    refreshed_at: string;
  }>();

  if (!seasonRow) return null;

  const dateKey = asOfDate ? String(asOfDate).slice(0, 10) : null;
  const trendRows = dateKey
    ? await env.DB.prepare(`
        SELECT window_days, plate_appearances, strikeouts, strikeout_rate
        FROM team_opponent_trends
        WHERE team_id = ? AND as_of_date = ?
          AND window_days IN (14, 30)
      `).bind(teamId, dateKey).all<{
        window_days: number;
        plate_appearances: number;
        strikeouts: number;
        strikeout_rate: number;
      }>()
    : { results: [] as Array<{
        window_days: number;
        plate_appearances: number;
        strikeouts: number;
        strikeout_rate: number;
      }> };

  const row30 = trendRows.results.find((row) => Number(row.window_days) === 30) ?? null;
  const row14 = trendRows.results.find((row) => Number(row.window_days) === 14) ?? null;

  const blended = blendOpponentRates({
    seasonRate: Number(seasonRow.strikeout_rate),
    seasonPa: Number(seasonRow.plate_appearances),
    recent30Rate: row30 ? Number(row30.strikeout_rate) : null,
    recent30Pa: row30 ? Number(row30.plate_appearances) : null,
    recent14Rate: row14 ? Number(row14.strikeout_rate) : null,
    recent14Pa: row14 ? Number(row14.plate_appearances) : null,
  });

  return {
    opponent_k_rate: blended.blendedRate,
    season_opponent_k_rate: Number(seasonRow.strikeout_rate),
    recent_30_k_rate: row30 ? Number(row30.strikeout_rate) : null,
    recent_14_k_rate: row14 ? Number(row14.strikeout_rate) : null,
    handedness_edge: blended.blendedRate - LEAGUE_BASELINE_K_RATE,
    opponent_trend_delta: blended.trendDelta,
    opponent_sample_confidence: blended.confidence,
    plate_appearances: Number(seasonRow.plate_appearances),
    strikeouts: Number(seasonRow.strikeouts),
    refreshed_at: seasonRow.refreshed_at,
  };
}

async function processProp(
  env: Env,
  modelVersionId: number,
  prop: ProcessPropRow,
): Promise<void> {
  const recent = await env.DB.prepare(`
    SELECT
      game_date,
      innings_pitched,
      strikeouts,
      batters_faced,
      pitch_count,
      starter
    FROM pitcher_game_stats
    WHERE pitcher_id = ?
    ORDER BY game_date DESC
    LIMIT 10
  `).bind(prop.pitcher_id).all<RecentStartRow>();

  const appearances = recent.results;
  const validStarts = appearances.filter(
    (row) =>
      Number(row.starter) === 1 &&
      row.strikeouts !== null &&
      row.batters_faced !== null &&
      Number(row.batters_faced) > 0,
  );

  if (validStarts.length < 3) {
    const sampleLabel = validStarts.length === 0
      ? "MLB sample unavailable"
      : `Only ${validStarts.length} usable MLB start${validStarts.length === 1 ? "" : "s"}`;
    const matchup = await getOpponentHandedness(
      env,
      prop.opponent_team_id,
      Number(String(prop.board_date).slice(0, 4)),
      prop.throws_hand,
      prop.board_date,
    );
    const matchupGate = matchup ? "NEUTRAL" : "PENDING";
    const finalReason = `WATCH: insufficient sample — ${sampleLabel}. No normal projection was generated.`;

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO feature_snapshots (
          prop_id, model_version_id, snapshot_time,
          last_3_k_avg, last_5_k_avg, last_10_k_avg, career_k_avg,
          average_ip_last_3, average_bf_last_5, average_pitch_count_last_5,
          starter_rate_last_10, form_delta_l3_l10, projection_sd,
          opponent_k_rate, handedness_edge,
          recent_form_gate, volume_gate, role_gate, health_gate, matchup_gate,
          data_freshness, source_quality
        ) VALUES (
          ?, ?, CURRENT_TIMESTAMP,
          NULL, NULL, NULL, NULL,
          NULL, NULL, NULL,
          ?, NULL, NULL,
          ?, ?,
          'INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT', 'UNKNOWN', ?,
          'CURRENT_DB', 'MLB_STATS_API+D1'
        )
      `).bind(
        prop.prop_id,
        modelVersionId,
        appearances.length
          ? appearances.filter((row) => Number(row.starter) === 1).length / appearances.length
          : 0,
        matchup?.opponent_k_rate ?? null,
        matchup?.handedness_edge ?? null,
        matchupGate,
      ),
      env.DB.prepare(`
        INSERT INTO recommendations (
          prop_id, model_version_id, projected_strikeouts, model_edge,
          estimated_over_rate, preferred_side, market_value_band, projection_status,
          confidence_score, confidence_band, confidence_cap, core_block_count,
          decision_tier, model_decision, final_decision, positive_factors,
          negative_factors, final_reason,
          initial_classification, final_classification,
          opening_line, recommended_line, market_type, completeness_score,
          recommendation_score, recommendation_band,
          score_projection, score_recent_form, score_volume, score_matchup, score_role, score_completeness, score_explanation,
          generated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, 'NO EDGE', 'INSUFFICIENT_SAMPLE',
                  25, 'LOW', '25', 1, 'WATCH', 'WATCH', 'WATCH', '[]', ?, ?,
                  'WATCH', COALESCE((SELECT final_classification FROM recommendations WHERE prop_id = ? AND model_version_id = ?), 'WATCH'),
                  ?, COALESCE((SELECT recommended_line FROM recommendations WHERE prop_id = ? AND model_version_id = ?), ?), ?, ?,
                  25, 'PASS', 0, 2, 2, 4, 2, 5, ?,
                  CURRENT_TIMESTAMP)
        ON CONFLICT(prop_id, model_version_id) DO UPDATE SET
          projected_strikeouts = NULL,
          model_edge = NULL,
          estimated_over_rate = NULL,
          preferred_side = NULL,
          market_value_band = 'NO EDGE',
          projection_status = 'INSUFFICIENT_SAMPLE',
          confidence_score = 25,
          confidence_band = 'LOW',
          confidence_cap = '25',
          core_block_count = 1,
          decision_tier = 'WATCH',
          model_decision = 'WATCH',
          final_decision = 'WATCH',
          positive_factors = '[]',
          negative_factors = excluded.negative_factors,
          final_reason = excluded.final_reason,
          initial_classification = excluded.initial_classification,
          final_classification = COALESCE(recommendations.final_classification, excluded.final_classification),
          opening_line = COALESCE(recommendations.opening_line, excluded.opening_line),
          recommended_line = COALESCE(recommendations.recommended_line, excluded.recommended_line),
          market_type = COALESCE(recommendations.market_type, excluded.market_type),
          completeness_score = excluded.completeness_score,
          recommendation_score = excluded.recommendation_score,
          recommendation_band = excluded.recommendation_band,
          score_projection = excluded.score_projection,
          score_recent_form = excluded.score_recent_form,
          score_volume = excluded.score_volume,
          score_matchup = excluded.score_matchup,
          score_role = excluded.score_role,
          score_completeness = excluded.score_completeness,
          score_explanation = excluded.score_explanation,
          generated_at = CURRENT_TIMESTAMP
      `).bind(
        prop.prop_id,
        modelVersionId,
        JSON.stringify([sampleLabel]),
        finalReason,
        prop.prop_id,
        modelVersionId,
        prop.strikeout_line,
        prop.prop_id,
        modelVersionId,
        prop.strikeout_line,
        prop.prop_type,
        lifecycleCompleteness({
          usableStarts: validStarts.length,
          hasMatchup: Boolean(matchup),
          hasPitchCount: false,
          hasBattersFaced: false,
          roleStable: false,
          hasOpponent: prop.opponent_team_id !== null,
          hasThrowingHand: Boolean(prop.throws_hand),
        }),
        JSON.stringify({ blockers: ["INSUFFICIENT_SAMPLE"], note: sampleLabel }),
      ),
    ]);
    return;
  }

  const last3 = validStarts.slice(0, 3);
  const last5 = validStarts.slice(0, 5);
  const last10 = validStarts.slice(0, 10);

  const last3Ks = last3.map((row) => Number(row.strikeouts));
  const last5Ks = last5.map((row) => Number(row.strikeouts));
  const last10Ks = last10.map((row) => Number(row.strikeouts));
  const last3Ips = last3
    .map((row) => Number(row.innings_pitched))
    .filter(Number.isFinite);
  const last5Bf = last5.map((row) => Number(row.batters_faced));
  const last5PitchCounts = last5
    .map((row) => Number(row.pitch_count))
    .filter(Number.isFinite);

  const l3KAvg = average(last3Ks) ?? 0;
  const l5KAvg = average(last5Ks) ?? 0;
  const l10KAvg = average(last10Ks) ?? l5KAvg;
  const formDelta = l3KAvg - l10KAvg;
  const averageBf = average(last5Bf) ?? 0;
  const averagePitchCount = average(last5PitchCounts);
  const starterRate = appearances.length
    ? appearances.filter((row) => Number(row.starter) === 1).length / appearances.length
    : 0;

  const totalKs = last5Ks.reduce((sum, value) => sum + value, 0);
  const totalBf = last5Bf.reduce((sum, value) => sum + value, 0);
  const strikeoutRate = totalBf > 0 ? totalKs / totalBf : 0;
  const baselineProjection = strikeoutRate * averageBf;
  const season = Number(String(prop.board_date).slice(0, 4));
  const matchup = await getOpponentHandedness(
    env, prop.opponent_team_id, season, prop.throws_hand, prop.board_date,
  );
  const matchupMultiplier = matchup
    ? clamp(1 + matchup.handedness_edge * 2.0, 0.88, 1.12)
    : 1;
  const projectedStrikeouts = baselineProjection * matchupMultiplier;
  const modelEdge = projectedStrikeouts - Number(prop.strikeout_line);
  const projectionSd = standardDeviation(last5Ks) ?? 1.5;
  const estimatedOverRate = estimateOverRate(modelEdge, projectionSd);

  const roleStable = starterRate >= 0.8 && validStarts.length >= 4;

  const recentFormGate =
    formDelta <= -1.5 ? "FAIL" :
    formDelta < -1.0 ? "WATCH" :
    "PASS";

  const volumeGate =
    averageBf < 18 || (averagePitchCount !== null && averagePitchCount < 70) ? "FAIL" :
    averageBf >= 20 && (averagePitchCount === null || averagePitchCount >= 80) ? "PASS" :
    "WATCH";

  const roleGate = roleStable ? "PASS" : starterRate >= 0.6 ? "WATCH" : "FAIL";

  const classification = classifyRecommendation(
    modelEdge,
    validStarts.length,
    roleStable,
    recentFormGate,
    volumeGate,
    prop.available_side,
  );

  const completenessScore = lifecycleCompleteness({
    usableStarts: validStarts.length,
    hasMatchup: Boolean(matchup),
    hasPitchCount: averagePitchCount !== null,
    hasBattersFaced: averageBf !== null,
    roleStable,
    hasOpponent: prop.opponent_team_id !== null,
    hasThrowingHand: Boolean(prop.throws_hand),
  });

  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];

  if (recentFormGate === "PASS") {
    positiveFactors.push(`Recent form is stable (L3 ${l3KAvg.toFixed(1)} vs L10 ${l10KAvg.toFixed(1)})`);
  } else if (recentFormGate === "FAIL") {
    negativeFactors.push(`Recent form is declining (L3 ${l3KAvg.toFixed(1)} vs L10 ${l10KAvg.toFixed(1)})`);
  } else {
    negativeFactors.push(`Recent form is softening (L3 ${l3KAvg.toFixed(1)} vs L10 ${l10KAvg.toFixed(1)})`);
  }

  if (volumeGate === "PASS") {
    positiveFactors.push(`Stable volume: ${averageBf.toFixed(1)} BF and ${averagePitchCount === null ? "unknown" : averagePitchCount.toFixed(0)} pitches`);
  } else {
    negativeFactors.push(`Volume ${volumeGate.toLowerCase()}: ${averageBf.toFixed(1)} BF and ${averagePitchCount === null ? "unknown" : averagePitchCount.toFixed(0)} pitches`);
  }

  if (roleStable) {
    positiveFactors.push(`Starter role is stable (${Math.round(starterRate * 100)}%)`);
  } else {
    negativeFactors.push(`Starter role is not fully stable (${Math.round(starterRate * 100)}%)`);
  }

  if (Math.abs(modelEdge) >= 1) {
    positiveFactors.push(`Model edge is ${Math.abs(modelEdge).toFixed(1)} strikeouts`);
  }
  if (validStarts.length < 5) {
    negativeFactors.push("Fewer than five usable recent starts");
  }

  let matchupGate = "PENDING";
  if (prop.opponent_team_id === null) {
    negativeFactors.push("Opponent is missing");
  } else if (!prop.throws_hand) {
    negativeFactors.push("Pitcher throwing hand is missing");
  } else if (!matchup) {
    negativeFactors.push("Opponent handedness split was unavailable");
  } else {
    matchupGate =
      matchup.opponent_k_rate >= 0.25 && matchup.opponent_sample_confidence !== "LOW" ? "STRONG PASS" :
      matchup.opponent_k_rate >= 0.235 ? "PASS" :
      matchup.opponent_k_rate < 0.195 ? "FAIL" :
      matchup.opponent_k_rate < 0.21 ? "WATCH" :
      "NEUTRAL";

    if (["STRONG PASS", "PASS"].includes(matchupGate)) {
      positiveFactors.push(
        `Blended opponent K rate is ${(matchup.opponent_k_rate * 100).toFixed(1)}% ` +
        `(${matchup.opponent_sample_confidence.toLowerCase()} confidence)`
      );
    } else if (["WATCH", "FAIL"].includes(matchupGate)) {
      negativeFactors.push(
        `Blended opponent K rate is only ${(matchup.opponent_k_rate * 100).toFixed(1)}% ` +
        `(${matchup.opponent_sample_confidence.toLowerCase()} confidence)`
      );
    }

    if (matchup.opponent_trend_delta !== null) {
      const trendPoints = matchup.opponent_trend_delta * 100;
      const trendText = `${trendPoints >= 0 ? "+" : ""}${trendPoints.toFixed(1)} pts versus season`;
      if (trendPoints >= 1.5) positiveFactors.push(`Opponent strikeout trend is rising (${trendText})`);
      if (trendPoints <= -1.5) negativeFactors.push(`Opponent strikeout trend is falling (${trendText})`);
    }
  }

  const v11 = scoreRecommendationV11({
    modelEdge,
    estimatedOverRate,
    recentFormGate,
    volumeGate,
    matchupGate,
    roleGate,
    completenessScore,
    availableSide: prop.available_side,
    preferredSide: classification.preferredSide,
    usableStarts: validStarts.length,
  });
  for (const blocker of v11.blockers) negativeFactors.push(`V11 blocker: ${blocker.replaceAll("_", " ").toLowerCase()}`);

  const projectionStatus = matchup ? "FULL" : "PARTIAL";
  const matchupText = matchup
    ? ` Opponent: season vs ${prop.throws_hand}HP ${(matchup.season_opponent_k_rate * 100).toFixed(1)}%, ` +
      `L30 ${matchup.recent_30_k_rate === null ? "n/a" : `${(matchup.recent_30_k_rate * 100).toFixed(1)}%`}, ` +
      `L14 ${matchup.recent_14_k_rate === null ? "n/a" : `${(matchup.recent_14_k_rate * 100).toFixed(1)}%`}, ` +
      `blended ${(matchup.opponent_k_rate * 100).toFixed(1)}% (${matchup.opponent_sample_confidence} confidence).`
    : " Opponent handedness and trend adjustment unavailable.";
  const volumeText = ` Volume: ${averageBf.toFixed(1)} BF, ${averagePitchCount === null ? "n/a" : averagePitchCount.toFixed(0)} pitches, ${Math.round(starterRate * 100)}% starter rate.`;
  const formText = ` Form: L3 ${l3KAvg.toFixed(1)}, L5 ${l5KAvg.toFixed(1)}, L10 ${l10KAvg.toFixed(1)} (${recentFormGate}).`;
  const finalReason =
    `${v11.band} (${v11.score}/100): projection ${projectedStrikeouts.toFixed(1)} ` +
    `versus line ${Number(prop.strikeout_line).toFixed(1)} ` +
    `(${modelEdge >= 0 ? "+" : ""}${modelEdge.toFixed(1)} edge).` +
    formText + volumeText + matchupText;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO feature_snapshots (
        prop_id,
        model_version_id,
        snapshot_time,
        last_3_k_avg,
        last_5_k_avg,
        last_10_k_avg,
        career_k_avg,
        average_ip_last_3,
        average_bf_last_5,
        average_pitch_count_last_5,
        starter_rate_last_10,
        form_delta_l3_l10,
        projection_sd,
        opponent_k_rate,
        handedness_edge,
        season_opponent_k_rate,
        recent_30_k_rate,
        recent_14_k_rate,
        opponent_trend_delta,
        opponent_sample_confidence,
        recent_form_gate,
        volume_gate,
        role_gate,
        health_gate,
        matchup_gate,
        data_freshness,
        source_quality
      )
      VALUES (
        ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, 'UNKNOWN', ?, 'CURRENT_DB', 'MLB_STATS_API+D1'
      )
    `).bind(
      prop.prop_id,
      modelVersionId,
      l3KAvg,
      l5KAvg,
      l10KAvg,
      l10KAvg,
      average(last3Ips),
      averageBf,
      averagePitchCount,
      starterRate,
      formDelta,
      projectionSd,
      matchup?.opponent_k_rate ?? null,
      matchup?.handedness_edge ?? null,
      matchup?.season_opponent_k_rate ?? null,
      matchup?.recent_30_k_rate ?? null,
      matchup?.recent_14_k_rate ?? null,
      matchup?.opponent_trend_delta ?? null,
      matchup?.opponent_sample_confidence ?? null,
      recentFormGate,
      volumeGate,
      roleGate,
      matchupGate,
    ),
    env.DB.prepare(`
      INSERT INTO recommendations (
        prop_id, model_version_id, projected_strikeouts, model_edge,
        estimated_over_rate, preferred_side, market_value_band, projection_status,
        confidence_score, confidence_band, confidence_cap, core_block_count,
        decision_tier, model_decision, final_decision, positive_factors,
        negative_factors, final_reason,
        initial_classification, final_classification,
        opening_line, recommended_line, market_type, completeness_score,
        recommendation_score, recommendation_band,
        score_projection, score_recent_form, score_volume, score_matchup, score_role, score_completeness, score_explanation,
        generated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, COALESCE((SELECT final_classification FROM recommendations WHERE prop_id = ? AND model_version_id = ?), ?),
              ?, COALESCE((SELECT recommended_line FROM recommendations WHERE prop_id = ? AND model_version_id = ?), ?), ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CURRENT_TIMESTAMP)
      ON CONFLICT(prop_id, model_version_id) DO UPDATE SET
        projected_strikeouts = excluded.projected_strikeouts,
        model_edge = excluded.model_edge,
        estimated_over_rate = excluded.estimated_over_rate,
        preferred_side = excluded.preferred_side,
        market_value_band = excluded.market_value_band,
        projection_status = excluded.projection_status,
        confidence_score = excluded.confidence_score,
        confidence_band = excluded.confidence_band,
        confidence_cap = excluded.confidence_cap,
        core_block_count = excluded.core_block_count,
        decision_tier = excluded.decision_tier,
        model_decision = excluded.model_decision,
        final_decision = excluded.final_decision,
        positive_factors = excluded.positive_factors,
        negative_factors = excluded.negative_factors,
        final_reason = excluded.final_reason,
        initial_classification = excluded.initial_classification,
        final_classification = COALESCE(recommendations.final_classification, excluded.final_classification),
        opening_line = COALESCE(recommendations.opening_line, excluded.opening_line),
        recommended_line = COALESCE(recommendations.recommended_line, excluded.recommended_line),
        market_type = COALESCE(recommendations.market_type, excluded.market_type),
        completeness_score = excluded.completeness_score,
        recommendation_score = excluded.recommendation_score,
        recommendation_band = excluded.recommendation_band,
        score_projection = excluded.score_projection,
        score_recent_form = excluded.score_recent_form,
        score_volume = excluded.score_volume,
        score_matchup = excluded.score_matchup,
        score_role = excluded.score_role,
        score_completeness = excluded.score_completeness,
        score_explanation = excluded.score_explanation,
        generated_at = CURRENT_TIMESTAMP
    `).bind(
      prop.prop_id,
      modelVersionId,
      projectedStrikeouts,
      modelEdge,
      estimatedOverRate,
      classification.preferredSide,
      Math.abs(modelEdge) >= 1 ? "STRONG" : Math.abs(modelEdge) >= 0.5 ? "FAIR" : "THIN",
      projectionStatus,
      v11.score,
      v11.score >= 85 ? "ELITE" : v11.score >= 75 ? "HIGH" : v11.score >= 65 ? "MEDIUM" : "LOW",
      String(classification.confidenceCap),
      classification.coreBlockCount,
      v11.decisionTier,
      v11.modelDecision,
      v11.modelDecision,
      JSON.stringify(positiveFactors),
      JSON.stringify(negativeFactors),
      finalReason,
      v11.band,
      prop.prop_id,
      modelVersionId,
      v11.band,
      prop.strikeout_line,
      prop.prop_id,
      modelVersionId,
      prop.strikeout_line,
      prop.prop_type,
      completenessScore,
      v11.score,
      v11.band,
      v11.components.projection,
      v11.components.recent_form,
      v11.components.volume,
      v11.components.matchup,
      v11.components.role,
      v11.components.completeness,
      JSON.stringify({ components: v11.components, blockers: v11.blockers }),
    ),
  ]);
}

async function processBoard(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  await assertRefreshableBoard(env, boardId);

  const modelVersion = await env.DB.prepare(`
    SELECT model_version_id, version_name
    FROM model_versions
    WHERE is_active = 1
    ORDER BY model_version_id DESC
    LIMIT 1
  `).first<{ model_version_id: number; version_name: string }>();

  if (!modelVersion) {
    return json(
      { error: "No active model version is configured." },
      { status: 409 },
    );
  }

  const props = await env.DB.prepare(`
    SELECT
      p.prop_id,
      p.pitcher_id,
      p.opponent_team_id,
      p.strikeout_line,
      p.available_side,
      p.prop_type,
      pi.canonical_name,
      pi.mlb_id,
      pi.throws_hand,
      b.board_date
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    JOIN boards b ON b.board_id = p.board_id
    WHERE p.board_id = ?
    ORDER BY COALESCE(p.source_row, p.prop_id), p.prop_id
  `).bind(boardId).all<ProcessPropRow>();

  if (!props.results.length) {
    return json(
      { error: "The board has no props to process." },
      { status: 409 },
    );
  }

  let processed = 0;
  const warnings: Array<Record<string, unknown>> = [];

  for (const prop of props.results) {
    try {
      await processProp(env, modelVersion.model_version_id, prop);
      processed += 1;
    } catch (error) {
      warnings.push({
        prop_id: prop.prop_id,
        pitcher: prop.canonical_name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await audit(env, identity, "BOARD_PROCESSED", "BOARD", boardId, {
    model_version_id: modelVersion.model_version_id,
    model_version: modelVersion.version_name,
    processed,
    warnings,
  });

  return json({
    ok: true,
    board_id: boardId,
    model_version: modelVersion.version_name,
    processed,
    warnings: warnings.length,
    warning_details: warnings,
  });
}



function parseBatchWindow(url: URL): { offset: number; limit: number } {
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const limitRaw = Number(url.searchParams.get("limit") ?? "5");
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 8) : 5;
  return { offset, limit };
}

async function refreshPitcherBatch(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
  url: URL,
): Promise<Response> {
  const board = await assertRefreshableBoard(env, boardId);
  const { offset, limit } = parseBatchWindow(url);
  const batch = await refreshBoardPitcherData(
    env,
    boardId,
    String(board.board_date),
    offset,
    limit,
  );

  const warnings = batch.results
    .filter((row) => row.warning)
    .map((row) => ({
      pitcher_id: row.pitcher_id,
      pitcher: row.pitcher,
      message: row.warning,
      stage: "REFRESH",
    }));

  await audit(env, identity, "BOARD_PITCHER_BATCH_REFRESHED", "BOARD", boardId, {
    offset,
    limit,
    returned: batch.results.length,
    total: batch.total,
    next_offset: batch.next_offset,
    warnings,
  });

  return json({
    ok: true,
    stage: "PITCHERS",
    offset,
    limit,
    total: batch.total,
    completed: offset + batch.results.length,
    next_offset: batch.next_offset,
    ids_resolved: batch.results.filter((row) => row.id_resolved).length,
    pitchers_refreshed: batch.results.filter((row) => row.games_loaded > 0).length,
    game_logs_loaded: batch.results.reduce((sum, row) => sum + row.games_loaded, 0),
    warning_details: warnings,
    refresh_details: batch.results,
  });
}

async function refreshMatchupBatch(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
  url: URL,
): Promise<Response> {
  const board = await assertRefreshableBoard(env, boardId);
  const { offset, limit } = parseBatchWindow(url);
  const batch = await refreshOpponentHandednessData(
    env,
    boardId,
    String(board.board_date),
    offset,
    limit,
  );

  const warnings = batch.results
    .filter((row) => row.warning)
    .map((row) => ({
      pitcher: `${row.team} vs ${row.pitcher_hand}HP`,
      message: row.warning,
      stage: "MATCHUP",
    }));

  await audit(env, identity, "BOARD_MATCHUP_BATCH_REFRESHED", "BOARD", boardId, {
    offset,
    limit,
    returned: batch.results.length,
    total: batch.total,
    next_offset: batch.next_offset,
    warnings,
  });

  return json({
    ok: true,
    stage: "MATCHUPS",
    offset,
    limit,
    total: batch.total,
    completed: offset + batch.results.length,
    next_offset: batch.next_offset,
    matchup_splits_loaded: batch.results.filter((row) => !row.warning).length,
    warning_details: warnings,
    matchup_details: batch.results,
  });
}


async function refreshAndProcessBoard(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  const board = await assertRefreshableBoard(env, boardId);
  const refreshBatch = await refreshBoardPitcherData(
    env,
    boardId,
    String(board.board_date),
    0,
    100,
  );
  const matchupBatch = await refreshOpponentHandednessData(
    env,
    boardId,
    String(board.board_date),
    0,
    100,
  );
  const refreshResults = refreshBatch.results;
  const matchupResults = matchupBatch.results;

  let processPayload: Record<string, unknown> = {
    processed: 0,
    warnings: 0,
    warning_details: [],
  };

  if (String(board.status) === "DRAFT") {
    const processResponse = await processBoard(env, identity, boardId);
    processPayload = await processResponse.json() as Record<string, unknown>;
  }

  const refreshWarnings = refreshResults
    .filter((row) => row.warning)
    .map((row) => ({
      pitcher_id: row.pitcher_id,
      pitcher: row.pitcher,
      message: row.warning,
      stage: "REFRESH",
    }));
  const matchupWarnings = matchupResults
    .filter((row) => row.warning)
    .map((row) => ({
      pitcher: `${row.team} vs ${row.pitcher_hand}HP`,
      message: row.warning,
      stage: "MATCHUP",
    }));
  const processWarnings = Array.isArray(processPayload.warning_details)
    ? (processPayload.warning_details as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        stage: "PROCESS",
      }))
    : [];

  const idsResolved = refreshResults.filter((row) => row.id_resolved).length;
  const gameLogsLoaded = refreshResults.reduce((sum, row) => sum + row.games_loaded, 0);
  const warnings = [...refreshWarnings, ...matchupWarnings, ...processWarnings];

  await audit(
    env,
    identity,
    String(board.status) === "DRAFT" ? "BOARD_REFRESHED_AND_PROCESSED" : "ACTIVE_BOARD_DATA_REFRESHED",
    "BOARD",
    boardId,
    {
    board_status: board.status,
    ids_resolved: idsResolved,
    game_logs_loaded: gameLogsLoaded,
    matchup_splits_loaded: matchupResults.filter((row) => !row.warning).length,
    processed: Number(processPayload.processed ?? 0),
    warnings,
  });

  return json({
    ok: true,
    board_id: boardId,
    model_version: processPayload.model_version ?? null,
    ids_resolved: idsResolved,
    pitchers_refreshed: refreshResults.filter((row) => row.games_loaded > 0).length,
    game_logs_loaded: gameLogsLoaded,
    matchup_splits_loaded: matchupResults.filter((row) => !row.warning).length,
    mode: String(board.status) === "DRAFT" ? "REFRESH_AND_PROCESS" : "REFRESH_ONLY",
    processed: Number(processPayload.processed ?? 0),
    warnings: warnings.length,
    warning_details: warnings,
    refresh_details: refreshResults,
    matchup_details: matchupResults,
  });
}


interface GradeWarning {
  prop_id: number;
  pitcher: string;
  message: string;
}



interface MlbScheduleGame {
  gamePk?: number;
  gameDate?: string;
  status?: { detailedState?: string; abstractGameState?: string; codedGameState?: string };
  teams?: {
    away?: { team?: { id?: number }; probablePitcher?: { id?: number } };
    home?: { team?: { id?: number }; probablePitcher?: { id?: number } };
  };
}

function scheduleGames(payload: unknown): MlbScheduleGame[] {
  const root = payload as { dates?: Array<{ games?: MlbScheduleGame[] }> };
  return (root.dates ?? []).flatMap((date) => date.games ?? []);
}

function liveFeedChecks(payload: unknown): { lineup: boolean; weather: boolean; umpire: boolean } {
  const root = payload as {
    gameData?: { weather?: { condition?: string; temp?: number }; officials?: Array<{ officialType?: string }> };
    liveData?: { boxscore?: { teams?: { away?: { battingOrder?: unknown[] }; home?: { battingOrder?: unknown[] } }; officials?: Array<{ officialType?: string }> } };
  };
  const awayOrder = root.liveData?.boxscore?.teams?.away?.battingOrder ?? [];
  const homeOrder = root.liveData?.boxscore?.teams?.home?.battingOrder ?? [];
  const officials = root.liveData?.boxscore?.officials ?? root.gameData?.officials ?? [];
  return {
    lineup: awayOrder.length >= 9 && homeOrder.length >= 9,
    weather: Boolean(root.gameData?.weather?.condition || root.gameData?.weather?.temp != null),
    umpire: officials.some((official) => String(official.officialType ?? '').toLowerCase().includes('home plate')),
  };
}

async function automatePregameChecks(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
  targetGamePks: Set<number> | null = null,
  triggerSource = 'MANUAL',
): Promise<Response> {
  const board = await getBoardForResults(env, boardId);
  const runInsert = await env.DB.prepare(`
    INSERT INTO automation_runs (board_id, run_type, trigger_source, status)
    VALUES (?, 'PREGAME_CHECKS', ?, 'RUNNING')
  `).bind(boardId, triggerSource).run();
  const runId = Number(runInsert.meta.last_row_id);

  try {
    const scheduleUrl = new URL('https://statsapi.mlb.com/api/v1/schedule');
    scheduleUrl.searchParams.set('sportId', '1');
    scheduleUrl.searchParams.set('date', board.board_date);
    scheduleUrl.searchParams.set('hydrate', 'probablePitcher,team');
    const schedule = scheduleGames(await fetchMlbJson(scheduleUrl.toString()));

    const props = await env.DB.prepare(`
      SELECT p.prop_id, p.opponent_team_id, p.strikeout_line,
             pi.mlb_id, pi.current_team, ot.abbreviation AS opponent
      FROM props p
      JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
      LEFT JOIN teams ot ON ot.team_id = p.opponent_team_id
      WHERE p.board_id = ?
    `).bind(boardId).all<{
      prop_id: number; opponent_team_id: number | null; strikeout_line: number;
      mlb_id: number | null; current_team: string | null; opponent: string | null;
    }>();

    const inverseTeamIds = new Map<number, string>(
      Object.entries(MLB_TEAM_IDS).map(([abbr, id]) => [Number(id), abbr]),
    );
    const feedCache = new Map<number, { checks: { lineup: boolean; weather: boolean; umpire: boolean }; success: boolean }>();
    let matched = 0;
    let starterConfirmed = 0;
    let lineupConfirmed = 0;
    let weatherChecked = 0;
    let umpireChecked = 0;
    let staleProps = 0;
    const now = Date.now();

    for (const prop of props.results) {
      const pitcherTeam = String(prop.current_team ?? '').toUpperCase();
      const opponent = String(prop.opponent ?? '').toUpperCase();
      const game = schedule.find((candidate) => {
        const away = inverseTeamIds.get(Number(candidate.teams?.away?.team?.id ?? 0)) ?? '';
        const home = inverseTeamIds.get(Number(candidate.teams?.home?.team?.id ?? 0)) ?? '';
        return (away === pitcherTeam && home === opponent) || (home === pitcherTeam && away === opponent);
      });
      if (!game?.gamePk) continue;
      if (targetGamePks && !targetGamePks.has(Number(game.gamePk))) continue;
      matched += 1;

      const isAway = inverseTeamIds.get(Number(game.teams?.away?.team?.id ?? 0)) === pitcherTeam;
      const probableId = isAway
        ? game.teams?.away?.probablePitcher?.id
        : game.teams?.home?.probablePitcher?.id;
      const starter = Boolean(prop.mlb_id && probableId && Number(prop.mlb_id) === Number(probableId));
      if (starter) starterConfirmed += 1;

      let feed = feedCache.get(Number(game.gamePk));
      if (!feed) {
        try {
          const checks = liveFeedChecks(await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${game.gamePk}/feed/live`));
          feed = { checks, success: true };
        } catch {
          feed = { checks: { lineup: false, weather: false, umpire: false }, success: false };
        }
        feedCache.set(Number(game.gamePk), feed);
      }

      const checks = feed.checks;
      if (checks.lineup) lineupConfirmed += 1;
      if (checks.weather) weatherChecked += 1;
      if (checks.umpire) umpireChecked += 1;

      const firstPitchMs = game.gameDate ? Date.parse(game.gameDate) : Number.NaN;
      const minutesToPitch = Number.isFinite(firstPitchMs) ? (firstPitchMs - now) / 60_000 : null;
      const ready = starter && checks.lineup && checks.weather && checks.umpire;
      const anyReady = starter || checks.lineup || checks.weather || checks.umpire;
      const stale = minutesToPitch != null && minutesToPitch <= 10 && minutesToPitch >= -5 && !ready;
      const status = ready ? 'READY' : stale ? 'STALE' : anyReady ? 'PARTIAL' : 'PENDING';
      if (stale) staleProps += 1;
      const missing = [
        !starter ? 'starter' : null,
        !checks.lineup ? 'lineup' : null,
        !checks.weather ? 'weather' : null,
        !checks.umpire ? 'umpire' : null,
      ].filter(Boolean).join(', ');
      const message = ready
        ? 'All official pregame checks are complete.'
        : `${missing || 'Official data'} pending${minutesToPitch == null ? '' : `; ${Math.round(minutesToPitch)} min to first pitch`}.`;

      await env.DB.prepare(`
        UPDATE recommendations
        SET starter_confirmed = CASE WHEN ? = 1 THEN 1 ELSE starter_confirmed END,
            lineup_confirmed = CASE WHEN ? = 1 THEN 1 ELSE lineup_confirmed END,
            weather_checked = CASE WHEN ? = 1 THEN 1 ELSE weather_checked END,
            umpire_checked = CASE WHEN ? = 1 THEN 1 ELSE umpire_checked END,
            closing_line = ?,
            final_classification = COALESCE(final_classification, initial_classification),
            completeness_score = MIN(100,
              COALESCE(completeness_score, 0)
              + CASE WHEN ? = 1 AND starter_confirmed = 0 THEN 5 ELSE 0 END
              + CASE WHEN ? = 1 AND lineup_confirmed = 0 THEN 4 ELSE 0 END
              + CASE WHEN ? = 1 AND weather_checked = 0 THEN 3 ELSE 0 END
              + CASE WHEN ? = 1 AND umpire_checked = 0 THEN 3 ELSE 0 END
            ),
            game_pk = ?,
            scheduled_first_pitch = ?,
            last_pregame_checked_at = CURRENT_TIMESTAMP,
            last_successful_refresh_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_successful_refresh_at END,
            pregame_check_status = ?,
            pregame_check_message = ?
        WHERE prop_id = ?
      `).bind(
        starter ? 1 : 0,
        checks.lineup ? 1 : 0,
        checks.weather ? 1 : 0,
        checks.umpire ? 1 : 0,
        Number(prop.strikeout_line),
        starter ? 1 : 0,
        checks.lineup ? 1 : 0,
        checks.weather ? 1 : 0,
        checks.umpire ? 1 : 0,
        Number(game.gamePk),
        game.gameDate ?? null,
        feed.success ? 1 : 0,
        status,
        message,
        prop.prop_id,
      ).run();
    }

    const details = {
      board_date: board.board_date,
      props: props.results.length,
      matched,
      starter_confirmed: starterConfirmed,
      lineup_confirmed: lineupConfirmed,
      weather_checked: weatherChecked,
      umpire_checked: umpireChecked,
      games_checked: feedCache.size,
      stale_props: staleProps,
    };

    await env.DB.prepare(`
      UPDATE automation_runs
      SET completed_at = CURRENT_TIMESTAMP, status = 'SUCCESS', games_checked = ?, props_matched = ?,
          starter_confirmed = ?, lineup_confirmed = ?, weather_checked = ?, umpire_checked = ?,
          stale_props = ?, details = ?
      WHERE automation_run_id = ?
    `).bind(
      feedCache.size, matched, starterConfirmed, lineupConfirmed, weatherChecked,
      umpireChecked, staleProps, JSON.stringify(details), runId,
    ).run();

    await audit(env, identity, 'PREGAME_CHECKS_AUTOMATED', 'BOARD', boardId, details);

    return json({ ok: true, board_id: boardId, ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE automation_runs
      SET completed_at = CURRENT_TIMESTAMP, status = 'FAILED', details = ?
      WHERE automation_run_id = ?
    `).bind(JSON.stringify({ error: message }), runId).run();
    throw error;
  }
}

interface RecommendationLifecycleInput {
  initial_classification?: string | null;
  final_classification?: string | null;
  final_card?: boolean | number;
  actually_played?: boolean | number;
  opening_line?: number | null;
  recommended_line?: number | null;
  closing_line?: number | null;
  market_type?: string | null;
  finalized_at?: string | null;
  change_reason?: string | null;
  completeness_score?: number | null;
  starter_confirmed?: boolean | number;
  lineup_confirmed?: boolean | number;
  weather_checked?: boolean | number;
  umpire_checked?: boolean | number;
}

interface PostgameReviewInput {
  postgame_reason_code?: string | null;
  early_exit_reason?: string | null;
}

function nullableText(value: unknown, maxLength = 240): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Response(JSON.stringify({ error: `${field} must be numeric or null.` }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return number;
}

function boolInt(value: unknown): number {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

async function updateRecommendationLifecycle(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  propId: number,
): Promise<Response> {
  const input = await parseJson<RecommendationLifecycleInput>(request);
  const recommendation = await env.DB.prepare(`
    SELECT r.*, p.strikeout_line
    FROM recommendations r
    JOIN props p ON p.prop_id = r.prop_id
    WHERE r.prop_id = ?
    ORDER BY r.generated_at DESC, r.recommendation_id DESC
    LIMIT 1
  `).bind(propId).first<Record<string, unknown> & { recommendation_id: number; strikeout_line: number }>();

  if (!recommendation) {
    return json({ error: "Process the prop before saving its recommendation lifecycle." }, { status: 409 });
  }

  const completenessRaw = input.completeness_score === undefined
    ? Number(recommendation.completeness_score ?? 0)
    : nullableNumber(input.completeness_score, "completeness_score");
  const completeness = completenessRaw == null
    ? null
    : Math.min(100, Math.max(0, Math.round(completenessRaw)));
  const finalCard = input.final_card === undefined
    ? Number(recommendation.final_card ?? 0)
    : boolInt(input.final_card);
  const finalizedAt = input.finalized_at === undefined
    ? (finalCard
      ? String(recommendation.finalized_at ?? new Date().toISOString())
      : null)
    : nullableText(input.finalized_at, 40);

  await env.DB.prepare(`
    UPDATE recommendations
    SET initial_classification = ?,
        final_classification = ?,
        final_card = ?,
        actually_played = ?,
        opening_line = ?,
        recommended_line = ?,
        closing_line = ?,
        market_type = ?,
        finalized_at = ?,
        change_reason = ?,
        completeness_score = ?,
        starter_confirmed = ?,
        lineup_confirmed = ?,
        weather_checked = ?,
        umpire_checked = ?
    WHERE recommendation_id = ?
  `).bind(
    input.initial_classification === undefined
      ? nullableText(recommendation.initial_classification, 80)
      : nullableText(input.initial_classification, 80),
    input.final_classification === undefined
      ? nullableText(recommendation.final_classification, 80)
      : nullableText(input.final_classification, 80),
    finalCard,
    input.actually_played === undefined
      ? Number(recommendation.actually_played ?? 0)
      : boolInt(input.actually_played),
    input.opening_line === undefined
      ? nullableNumber(recommendation.opening_line, "opening_line")
      : nullableNumber(input.opening_line, "opening_line"),
    input.recommended_line === undefined
      ? (nullableNumber(recommendation.recommended_line, "recommended_line") ?? recommendation.strikeout_line)
      : (nullableNumber(input.recommended_line, "recommended_line") ?? recommendation.strikeout_line),
    input.closing_line === undefined
      ? nullableNumber(recommendation.closing_line, "closing_line")
      : nullableNumber(input.closing_line, "closing_line"),
    input.market_type === undefined
      ? nullableText(recommendation.market_type, 40)
      : nullableText(input.market_type, 40),
    finalizedAt,
    input.change_reason === undefined
      ? nullableText(recommendation.change_reason, 500)
      : nullableText(input.change_reason, 500),
    completeness,
    input.starter_confirmed === undefined
      ? Number(recommendation.starter_confirmed ?? 0)
      : boolInt(input.starter_confirmed),
    input.lineup_confirmed === undefined
      ? Number(recommendation.lineup_confirmed ?? 0)
      : boolInt(input.lineup_confirmed),
    input.weather_checked === undefined
      ? Number(recommendation.weather_checked ?? 0)
      : boolInt(input.weather_checked),
    input.umpire_checked === undefined
      ? Number(recommendation.umpire_checked ?? 0)
      : boolInt(input.umpire_checked),
    recommendation.recommendation_id,
  ).run();

  await audit(env, identity, "RECOMMENDATION_LIFECYCLE_UPDATED", "PROP", propId, input as Record<string, unknown>);
  return json({ ok: true, prop_id: propId });
}

async function updatePostgameReview(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  propId: number,
): Promise<Response> {
  const input = await parseJson<PostgameReviewInput>(request);
  const existing = await env.DB.prepare(`
    SELECT prop_result_id FROM prop_results WHERE prop_id = ?
  `).bind(propId).first();
  if (!existing) return json({ error: "The prop has not been graded yet." }, { status: 409 });

  await env.DB.prepare(`
    UPDATE prop_results
    SET postgame_reason_code = ?,
        early_exit_reason = ?,
        postgame_review_status = 'REVIEWED'
    WHERE prop_id = ?
  `).bind(
    nullableText(input.postgame_reason_code, 80),
    nullableText(input.early_exit_reason, 500),
    propId,
  ).run();

  await audit(env, identity, "POSTGAME_REVIEW_UPDATED", "PROP", propId, input as Record<string, unknown>);
  return json({ ok: true, prop_id: propId });
}

function suggestPostgameReason(game: {
  starter: number | null;
  pitch_count: number | null;
  batters_faced: number | null;
  walks: number | null;
  earned_runs: number | null;
}, result: string): string {
  if (Number(game.starter) !== 1) return "ROLE_CHANGE";
  if (game.pitch_count != null && Number(game.pitch_count) < 60) return "LOW_PITCH_COUNT";
  if (game.batters_faced != null && Number(game.batters_faced) < 15) return "LOW_BATTERS_FACED";
  if (game.walks != null && Number(game.walks) >= 4) return "POOR_COMMAND";
  if (game.earned_runs != null && Number(game.earned_runs) >= 5) return "BLOWUP_OUTING";
  if (result === "PUSH") return "LINE_ACCURATE";
  return "NORMAL_VARIANCE_REVIEW";
}

async function getBoardForResults(
  env: Env,
  boardId: number,
): Promise<{ board_id: number; board_date: string; board_name: string | null; status: string }> {
  const board = await env.DB.prepare(`
    SELECT board_id, board_date, board_name, status
    FROM boards
    WHERE board_id = ?
  `).bind(boardId).first<{
    board_id: number;
    board_date: string;
    board_name: string | null;
    status: string;
  }>();

  if (!board) {
    throw new Response(
      JSON.stringify({ error: "Board not found." }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return board;
}

async function gradeBoardResults(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
  refreshLimit: number | null = null,
): Promise<Response> {
  const board = await getBoardForResults(env, boardId);

  const props = await env.DB.prepare(`
    SELECT
      p.prop_id,
      p.pitcher_id,
      p.strikeout_line,
      pi.canonical_name,
      pi.mlb_id,
      pi.current_team,
      ot.abbreviation AS opponent,
      pr.result_status,
      pr.result,
      r.preferred_side,
      r.final_card,
      r.game_pk
    FROM props p
    JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
    LEFT JOIN teams ot ON ot.team_id = p.opponent_team_id
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC LIMIT 1
    )
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
    ORDER BY COALESCE(p.source_row, p.prop_id), p.prop_id
  `).bind(boardId).all<{
    prop_id: number;
    pitcher_id: number;
    strikeout_line: number;
    canonical_name: string;
    mlb_id: number | null;
    current_team: string | null;
    opponent: string | null;
    result_status: string | null;
    result: string | null;
    preferred_side: string | null;
    final_card: number | null;
    game_pk: number | null;
  }>();

  if (!props.results.length) {
    return json({ error: "The board has no props to grade." }, { status: 409 });
  }

  const season = Number(board.board_date.slice(0, 4));
  const refreshedPitchers = new Set<number>();
  const refreshWarnings: GradeWarning[] = [];

  // Only pending props need fresh MLB game logs. The cron path supplies a
  // refreshLimit so a single scheduled invocation cannot exhaust the
  // Worker's outbound subrequest allowance.
  const pendingProps = props.results.filter(
    (prop) => prop.result_status == null || prop.result_status === "PENDING",
  );
  const refreshCandidates = refreshLimit == null
    ? pendingProps
    : pendingProps.slice(0, Math.max(0, refreshLimit));

  for (const prop of refreshCandidates) {
    if (refreshedPitchers.has(prop.pitcher_id)) continue;
    refreshedPitchers.add(prop.pitcher_id);

    try {
      let mlbId = prop.mlb_id == null ? null : Number(prop.mlb_id);
      if (!mlbId) {
        mlbId = await resolveMlbId(env, prop.pitcher_id, prop.canonical_name);
      }
      await refreshPitcherCurrentTeam(env, prop.pitcher_id, mlbId);
      await loadPitcherGameLog(env, prop.pitcher_id, mlbId, season);
    } catch (error) {
      refreshWarnings.push({
        prop_id: prop.prop_id,
        pitcher: prop.canonical_name,
        message: `Game-log refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const scheduleUrl = new URL("https://statsapi.mlb.com/api/v1/schedule");
  scheduleUrl.searchParams.set("sportId", "1");
  scheduleUrl.searchParams.set("date", board.board_date);
  scheduleUrl.searchParams.set("hydrate", "probablePitcher,team");

  let schedule: MlbScheduleGame[] = [];
  try {
    schedule = scheduleGames(await fetchMlbJson(scheduleUrl.toString()));
  } catch (error) {
    refreshWarnings.push({
      prop_id: 0,
      pitcher: "BOARD",
      message: `Schedule refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const inverseTeamIds = new Map<number, string>(
    Object.entries(MLB_TEAM_IDS).map(([abbr, id]) => [Number(id), abbr]),
  );
  const terminalVoidStates = new Set(["postponed", "cancelled", "canceled", "forfeit"]);
  const finalStates = new Set(["final", "game over", "completed early"]);

  function findPropGame(prop: { game_pk: number | null; current_team: string | null; opponent: string | null }): MlbScheduleGame | null {
    if (prop.game_pk) {
      const exact = schedule.find((game) => Number(game.gamePk) === Number(prop.game_pk));
      if (exact) return exact;
    }

    const pitcherTeam = String(prop.current_team ?? "").toUpperCase();
    const opponent = String(prop.opponent ?? "").toUpperCase();
    if (!pitcherTeam || !opponent) return null;

    const matches = schedule.filter((game) => {
      const away = inverseTeamIds.get(Number(game.teams?.away?.team?.id ?? 0)) ?? "";
      const home = inverseTeamIds.get(Number(game.teams?.home?.team?.id ?? 0)) ?? "";
      return (away === pitcherTeam && home === opponent) || (home === pitcherTeam && away === opponent);
    });

    return matches.length === 1 ? matches[0] : null;
  }

  async function saveVoidResult(
    prop: { prop_id: number },
    reasonCode: string,
    source: string,
  ): Promise<void> {
    await env.DB.prepare(`
      INSERT INTO prop_results (
        prop_id, actual_strikeouts, result, result_status, source,
        innings_pitched, pitch_count, batters_faced, starter,
        suggested_reason_code, postgame_review_status, graded_at, created_at
      ) VALUES (?, NULL, 'VOID', 'GRADED', ?, NULL, NULL, NULL, 0, ?, 'NOT_REQUIRED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(prop_id) DO UPDATE SET
        actual_strikeouts = NULL,
        result = 'VOID',
        result_status = 'GRADED',
        source = excluded.source,
        innings_pitched = NULL,
        pitch_count = NULL,
        batters_faced = NULL,
        starter = 0,
        suggested_reason_code = excluded.suggested_reason_code,
        postgame_review_status = 'NOT_REQUIRED',
        graded_at = CURRENT_TIMESTAMP
    `).bind(prop.prop_id, source, reasonCode).run();
  }

  let graded = 0;
  let overs = 0;
  let unders = 0;
  let pushes = 0;
  let voids = 0;
  const warnings: GradeWarning[] = [...refreshWarnings];

  for (const prop of props.results) {
    // Preserve already-settled outcomes. Scheduled retries should only act on pending props.
    if (prop.result_status === "GRADED") continue;

    const game = await env.DB.prepare(`
      SELECT strikeouts, innings_pitched, pitch_count, batters_faced,
             starter, walks, earned_runs, source
      FROM pitcher_game_stats
      WHERE pitcher_id = ? AND game_date = ?
      ORDER BY starter DESC, pitcher_game_stat_id DESC
      LIMIT 1
    `).bind(prop.pitcher_id, board.board_date).first<{
      strikeouts: number | null;
      innings_pitched: number | null;
      pitch_count: number | null;
      batters_faced: number | null;
      starter: number | null;
      walks: number | null;
      earned_runs: number | null;
      source: string | null;
    }>();

    if (!game || game.strikeouts == null) {
      const scheduledGame = findPropGame(prop);
      const detailedState = String(scheduledGame?.status?.detailedState ?? "").trim();
      const normalizedState = detailedState.toLowerCase();
      const abstractState = String(scheduledGame?.status?.abstractGameState ?? "").toLowerCase();

      if (scheduledGame && terminalVoidStates.has(normalizedState)) {
        await saveVoidResult(prop, "POSTPONED_OR_CANCELLED", `MLB Stats API: ${detailedState || "Postponed"}`);
        graded += 1;
        voids += 1;
        continue;
      }

      if (scheduledGame && (finalStates.has(normalizedState) || abstractState === "final")) {
        // The game finished but this pitcher recorded no pitching line. That means
        // the listed starter was scratched, did not appear, or otherwise did not play.
        await saveVoidResult(prop, "DNP_OR_STARTER_CHANGE", `MLB Stats API: ${detailedState || "Final"}`);
        graded += 1;
        voids += 1;
        continue;
      }

      warnings.push({
        prop_id: prop.prop_id,
        pitcher: prop.canonical_name,
        message: scheduledGame
          ? `No completed pitching line found; MLB game status is ${detailedState || "unknown"}. Result remains pending.`
          : `No unambiguous MLB game match or completed pitching line found for ${board.board_date}; result remains pending.`,
      });
      continue;
    }

    const actual = Number(game.strikeouts);
    const line = Number(prop.strikeout_line);
    const result = actual > line ? "OVER" : actual < line ? "UNDER" : "PUSH";

    const recommendationWon =
      (String(prop.preferred_side).toLowerCase() === "more" && result === "OVER") ||
      (String(prop.preferred_side).toLowerCase() === "less" && result === "UNDER");
    const reviewStatus = Number(prop.final_card) !== 1 || recommendationWon || result === "PUSH"
      ? "NOT_REQUIRED"
      : "UNREVIEWED";

    await env.DB.prepare(`
      INSERT INTO prop_results (
        prop_id, actual_strikeouts, result, result_status, source,
        innings_pitched, pitch_count, batters_faced, starter,
        suggested_reason_code, postgame_review_status, graded_at, created_at
      ) VALUES (?, ?, ?, 'GRADED', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(prop_id) DO UPDATE SET
        actual_strikeouts = excluded.actual_strikeouts,
        result = excluded.result,
        result_status = excluded.result_status,
        source = excluded.source,
        innings_pitched = excluded.innings_pitched,
        pitch_count = excluded.pitch_count,
        batters_faced = excluded.batters_faced,
        starter = excluded.starter,
        suggested_reason_code = excluded.suggested_reason_code,
        postgame_review_status = CASE
          WHEN prop_results.postgame_review_status = 'REVIEWED' THEN 'REVIEWED'
          ELSE excluded.postgame_review_status
        END,
        graded_at = CURRENT_TIMESTAMP
    `).bind(
      prop.prop_id,
      actual,
      result,
      game.source || "MLB Stats API",
      game.innings_pitched,
      game.pitch_count,
      game.batters_faced,
      game.starter,
      suggestPostgameReason(game, result),
      reviewStatus,
    ).run();

    graded += 1;
    if (result === "OVER") overs += 1;
    else if (result === "UNDER") unders += 1;
    else pushes += 1;
  }

  const remaining = await env.DB.prepare(`
    SELECT COUNT(*) AS pending
    FROM props p
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.board_id = ?
      AND (pr.prop_result_id IS NULL OR pr.result_status = 'PENDING')
  `).bind(boardId).first<{ pending: number }>();

  const pending = Number(remaining?.pending ?? 0);
  let boardClosed = false;
  if (pending === 0 && board.status !== "CLOSED") {
    await env.DB.prepare(`
      UPDATE boards
      SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
      WHERE board_id = ?
    `).bind(boardId).run();
    boardClosed = true;
  }

  await audit(env, identity, "BOARD_RESULTS_GRADED", "BOARD", boardId, {
    board_date: board.board_date,
    graded,
    overs,
    unders,
    pushes,
    voids,
    pending,
    board_closed: boardClosed,
    refresh_limit: refreshLimit,
    refresh_candidates: refreshCandidates.length,
    pitchers_refreshed: refreshedPitchers.size,
    warnings,
  });

  return json({
    ok: true,
    board_id: boardId,
    board_date: board.board_date,
    graded,
    overs,
    unders,
    pushes,
    voids,
    pending,
    board_closed: boardClosed,
    refresh_limit: refreshLimit,
    refresh_candidates: refreshCandidates.length,
    pitchers_refreshed: refreshedPitchers.size,
    warnings: warnings.length,
    warning_details: warnings,
  });
}

function chicagoDateParts(timestamp: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function chicagoDateString(timestamp: number): string {
  const local = chicagoDateParts(timestamp);
  return [
    String(local.year).padStart(4, "0"),
    String(local.month).padStart(2, "0"),
    String(local.day).padStart(2, "0"),
  ].join("-");
}

function previousChicagoDate(timestamp: number): string {
  const local = chicagoDateParts(timestamp);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function autoRefreshPregameBoards(env: Env, scheduledTime: number): Promise<void> {
  const boardDate = chicagoDateString(scheduledTime);
  const boards = await env.DB.prepare(`
    SELECT board_id, board_date, board_name, status
    FROM boards
    WHERE board_date = ?
      AND status IN ('DRAFT', 'ACTIVE')
    ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, board_id DESC
  `).bind(boardDate).all<{
    board_id: number;
    board_date: string;
    board_name: string | null;
    status: string;
  }>();

  if (!boards.results.length) {
    console.log(`AUTO_PREGAME: no DRAFT or ACTIVE board found for ${boardDate}.`);
    return;
  }

  const scheduleUrl = new URL('https://statsapi.mlb.com/api/v1/schedule');
  scheduleUrl.searchParams.set('sportId', '1');
  scheduleUrl.searchParams.set('date', boardDate);
  scheduleUrl.searchParams.set('hydrate', 'probablePitcher,team');
  const games = scheduleGames(await fetchMlbJson(scheduleUrl.toString()));

  // The cron runs every five minutes. Refresh repeatedly from 30 to 5 minutes
  // before first pitch so incomplete MLB data can be retried automatically.
  const upcomingGamePks = new Set<number>();
  const leadMinutes: Array<{ game_pk: number; minutes_to_first_pitch: number }> = [];
  for (const game of games) {
    if (!game.gamePk || !game.gameDate) continue;
    const firstPitch = Date.parse(game.gameDate);
    if (!Number.isFinite(firstPitch)) continue;
    const minutes = (firstPitch - scheduledTime) / 60_000;
    if (minutes >= 5 && minutes <= 30) {
      upcomingGamePks.add(Number(game.gamePk));
      leadMinutes.push({
        game_pk: Number(game.gamePk),
        minutes_to_first_pitch: Math.round(minutes * 10) / 10,
      });
    }
  }

  if (!upcomingGamePks.size) return;

  const systemIdentity: AccessIdentity = {
    email: 'cloudflare-cron@system.local',
    subject: 'cloudflare-cron',
    issuer: 'scheduled',
  };

  for (const board of boards.results) {
    try {
      const response = await automatePregameChecks(
        env,
        systemIdentity,
        Number(board.board_id),
        upcomingGamePks,
        'CRON',
      );
      const payload = await response.json<Record<string, unknown>>();
      console.log('AUTO_PREGAME:', JSON.stringify({
        board_id: board.board_id,
        board_date: board.board_date,
        games: leadMinutes,
        matched_props: payload.matched ?? 0,
        starter_confirmed: payload.starter_confirmed ?? 0,
      }));
    } catch (error) {
      console.error(`AUTO_PREGAME failed for board ${board.board_id}:`, error);
    }
  }
}

async function autoGradePreviousBoard(env: Env, scheduledTime: number): Promise<void> {
  const local = chicagoDateParts(scheduledTime);

  // UTC cron entries cover daylight and standard time for the
  // 6:00, 7:00, and 8:00 AM America/Chicago grading attempts.
  if (![6, 7, 8].includes(local.hour) || local.minute >= 5) return;

  const boardDate = previousChicagoDate(scheduledTime);
  const board = await env.DB.prepare(`
    SELECT board_id, board_date, board_name, status
    FROM boards
    WHERE board_date = ?
      AND status IN ('ACTIVE', 'ARCHIVED')
    ORDER BY
      CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
      board_id DESC
    LIMIT 1
  `).bind(boardDate).first<{
    board_id: number;
    board_date: string;
    board_name: string | null;
    status: string;
  }>();

  if (!board) {
    console.log(`AUTO_GRADE: no ACTIVE or ARCHIVED board found for ${boardDate}.`);
    return;
  }

  const systemIdentity: AccessIdentity = {
    email: "cloudflare-cron@system.local",
    subject: "cloudflare-cron",
    issuer: "scheduled",
  };

  const runInsert = await env.DB.prepare(`
    INSERT INTO automation_runs (board_id, run_type, trigger_source, status)
    VALUES (?, 'MORNING_GRADE', 'CRON', 'RUNNING')
  `).bind(board.board_id).run();
  const runId = Number(runInsert.meta.last_row_id);

  try {
    // Refresh up to twenty pending pitchers per scheduled run. This covers a normal
    // full MLB board while retaining a guard against excessive subrequests.
    const response = await gradeBoardResults(env, systemIdentity, board.board_id, 20);
    const payload = await response.json<Record<string, unknown>>();

    let createdBoardId: number | null = null;
  const closedBoard = await env.DB.prepare(`
    SELECT board_id
    FROM boards
    WHERE board_id = ? AND status = 'CLOSED'
    LIMIT 1
  `).bind(board.board_id).first<{ board_id: number }>();

  if (closedBoard && Number(payload.pending ?? -1) === 0) {
    const today = chicagoDateString(scheduledTime);
    const existingToday = await env.DB.prepare(`
      SELECT board_id, status
      FROM boards
      WHERE board_date = ?
      ORDER BY board_id DESC
      LIMIT 1
    `).bind(today).first<{ board_id: number; status: string }>();

    if (!existingToday) {
      const result = await env.DB.prepare(`
        INSERT INTO boards (
          board_date,
          board_name,
          status,
          source,
          created_at,
          updated_at
        )
        VALUES (?, ?, 'DRAFT', 'AUTO_CRON', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(today, `PrizePicks ${today}`).run();

      createdBoardId = Number(result.meta.last_row_id);

      await audit(env, systemIdentity, "BOARD_AUTO_CREATED", "BOARD", createdBoardId, {
        board_date: today,
        board_name: `PrizePicks ${today}`,
        status: "DRAFT",
        source: "AUTO_CRON",
        previous_board_id: board.board_id,
      });
    }
  }

    const gradeDetails = {
      board_id: board.board_id,
      board_date: board.board_date,
      status_before: board.status,
      graded: payload.graded,
      pending: payload.pending,
      board_closed: payload.board_closed,
      refresh_limit: payload.refresh_limit,
      refresh_candidates: payload.refresh_candidates,
      pitchers_refreshed: payload.pitchers_refreshed,
      created_board_id: createdBoardId,
      warnings: payload.warnings,
    };

    await env.DB.prepare(`
      UPDATE automation_runs
      SET completed_at = CURRENT_TIMESTAMP, status = 'SUCCESS',
          props_matched = ?, details = ?
      WHERE automation_run_id = ?
    `).bind(Number(payload.graded ?? 0), JSON.stringify(gradeDetails), runId).run();

    console.log("AUTO_GRADE completed", gradeDetails);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE automation_runs
      SET completed_at = CURRENT_TIMESTAMP, status = 'FAILED', details = ?
      WHERE automation_run_id = ?
    `).bind(JSON.stringify({ error: message }), runId).run();
    console.error(`AUTO_GRADE failed for board ${board.board_id}:`, error);
    throw error;
  }
}


async function activateBoard(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  await assertEditableBoard(env, boardId);

  const count = await env.DB.prepare(`
    SELECT COUNT(*) AS prop_count
    FROM props
    WHERE board_id = ?
  `).bind(boardId).first<{ prop_count: number }>();

  if (!count || count.prop_count < 1) {
    return json({ error: "A board must contain at least one prop before activation." }, { status: 409 });
  }

  const duplicate = await env.DB.prepare(`
    SELECT pitcher_id, strikeout_line, COUNT(*) AS duplicate_count
    FROM props
    WHERE board_id = ?
    GROUP BY pitcher_id, strikeout_line
    HAVING COUNT(*) > 1
    LIMIT 1
  `).bind(boardId).first();

  if (duplicate) {
    return json({ error: "Duplicate pitcher/line combination blocks activation.", duplicate }, { status: 409 });
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE boards
      SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'ACTIVE' AND board_id <> ?
    `).bind(boardId),
    env.DB.prepare(`
      UPDATE boards
      SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
      WHERE board_id = ? AND status = 'DRAFT'
    `).bind(boardId),
  ]);

  await audit(env, identity, "BOARD_ACTIVATED", "BOARD", boardId, {
    prop_count: count.prop_count,
  });

  return json({ ok: true, board_id: boardId, status: "ACTIVE" });
}



async function getPitcherPropHistory(env: Env, url: URL): Promise<Response> {
  const pitcherIdRaw = url.searchParams.get("pitcher_id");
  const pitcherName = url.searchParams.get("name")?.trim() ?? "";

  if (!pitcherIdRaw && !pitcherName) {
    const pitchers = await env.DB.prepare(`
      SELECT
        pi.pitcher_id,
        pi.canonical_name,
        pi.mlb_id,
        pi.throws_hand,
        pi.current_team,
        COUNT(p.prop_id) AS prop_count,
        SUM(CASE WHEN pr.prop_result_id IS NOT NULL THEN 1 ELSE 0 END) AS graded_count,
        MAX(b.board_date) AS latest_prop_date
      FROM pitchers pi
      JOIN props p ON p.pitcher_id = pi.pitcher_id
      JOIN boards b ON b.board_id = p.board_id
      LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
      GROUP BY
        pi.pitcher_id,
        pi.canonical_name,
        pi.mlb_id,
        pi.throws_hand,
        pi.current_team
      ORDER BY pi.canonical_name
    `).all();

    return json({ pitchers: pitchers.results });
  }

  let pitcher:
    | {
        pitcher_id: number;
        canonical_name: string;
        mlb_id: number | null;
        throws_hand: string | null;
        active: number;
        current_team: string | null;
      }
    | null;

  if (pitcherIdRaw) {
    const pitcherId = Number(pitcherIdRaw);
    if (!Number.isInteger(pitcherId) || pitcherId < 1) {
      return json({ error: "Invalid pitcher_id" }, { status: 400 });
    }

    pitcher = await env.DB.prepare(`
      SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active, current_team
      FROM pitchers
      WHERE pitcher_id = ?
    `).bind(pitcherId).first<typeof pitcher>();
  } else {
    pitcher = await env.DB.prepare(`
      SELECT pitcher_id, canonical_name, mlb_id, throws_hand, active, current_team
      FROM pitchers
      WHERE canonical_name = ? COLLATE NOCASE
    `).bind(pitcherName).first<typeof pitcher>();
  }

  if (!pitcher) {
    return json({ error: "Pitcher not found" }, { status: 404 });
  }

  const history = await env.DB.prepare(`
    SELECT
      p.prop_id,
      b.board_id,
      b.board_date,
      b.board_name,
      b.status AS board_status,
      b.source AS board_source,
      p.strikeout_line,
      p.available_side,
      p.prop_type,
      p.source AS prop_source,
      p.status AS prop_status,
      t.abbreviation AS opponent,
      (
        SELECT r.preferred_side
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS preferred_side,
      (
        SELECT r.model_decision
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS model_decision,
      (
        SELECT r.final_decision
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS final_decision,
      (
        SELECT r.confidence_score
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS confidence_score,
      (
        SELECT r.confidence_band
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS confidence_band,
      (
        SELECT r.final_reason
        FROM recommendations r
        WHERE r.prop_id = p.prop_id
        ORDER BY r.recommendation_id DESC
        LIMIT 1
      ) AS final_reason,
      pr.actual_strikeouts,
      pr.result,
      pr.result_status,
      pr.innings_pitched,
      pr.source AS result_source,
      pr.graded_at
    FROM props p
    JOIN boards b ON b.board_id = p.board_id
    LEFT JOIN teams t ON t.team_id = p.opponent_team_id
    LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
    WHERE p.pitcher_id = ?
    ORDER BY b.board_date DESC, p.strikeout_line DESC, p.prop_id DESC
  `).bind(pitcher.pitcher_id).all();

  const rows = history.results as Array<Record<string, unknown>>;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let voids = 0;
  let gradedRecommendations = 0;

  const enriched = rows.map((row) => {
    const marketResult = String(row.result ?? "").toUpperCase();
    const preferredSide = String(row.preferred_side ?? "").toUpperCase();
    let recommendationResult: string | null = null;

    if (marketResult === "VOID") {
      recommendationResult = "VOID";
      voids += 1;
    } else if (marketResult === "PUSH") {
      recommendationResult = "PUSH";
      pushes += 1;
      gradedRecommendations += preferredSide ? 1 : 0;
    } else if (preferredSide === "MORE" && marketResult) {
      recommendationResult = marketResult === "OVER" ? "WIN" : "LOSS";
      recommendationResult === "WIN" ? wins += 1 : losses += 1;
      gradedRecommendations += 1;
    } else if (preferredSide === "LESS" && marketResult) {
      recommendationResult = marketResult === "UNDER" ? "WIN" : "LOSS";
      recommendationResult === "WIN" ? wins += 1 : losses += 1;
      gradedRecommendations += 1;
    }

    return {
      ...row,
      recommendation_result: recommendationResult,
    };
  });

  const propCount = enriched.length;
  const verifiedCount = rows.filter((row) => row.result_status && row.result_status !== "PENDING").length;
  const unresolvedCount = propCount - verifiedCount;
  const decided = wins + losses;

  return json({
    pitcher,
    summary: {
      prop_count: propCount,
      verified_count: verifiedCount,
      unresolved_count: unresolvedCount,
      graded_recommendations: gradedRecommendations,
      wins,
      losses,
      pushes,
      voids,
      win_rate: decided > 0 ? wins / decided : null,
    },
    history: enriched,
  });
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      const isPublicHostname = url.hostname.toLowerCase() === "mlb.kalupa.net";
      const editorAssetPaths = new Set([
        "/board-editor.html",
        "/board-editor.js",
        "/board-editor.css",
      ]);

      if (isPublicHostname && editorAssetPaths.has(url.pathname)) {
        return notFound(url.pathname);
      }

      const publicReadOnlyPaths = new Set([
        "/api/dashboard",
        "/api/pitcher-history",
      ]);

      const isPublicReadOnlyRequest =
        request.method === "GET" &&
        publicReadOnlyPaths.has(url.pathname);

      if (
        isPublicHostname &&
        url.pathname.startsWith("/api/") &&
        !isPublicReadOnlyRequest
      ) {
        return notFound(url.pathname);
      }

      let identity: AccessIdentity | null = null;

      if (url.pathname.startsWith("/api/") && !isPublicReadOnlyRequest) {
        identity = await requireAccessIdentity(request, env);
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        return json({
          authenticated: true,
          email: identity?.email ?? null,
          subject: identity?.subject ?? null,
          issuer: identity?.issuer ?? null,
        });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return getHealth(env);
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        return getDashboard(env, url);
      }

      if (url.pathname === "/api/pitcher-history" && request.method === "GET") {
        return getPitcherPropHistory(env, url);
      }

      if (url.pathname === "/api/boards/current" && request.method === "GET") {
        return getCurrentBoard(env);
      }

      if (url.pathname === "/api/editor/bootstrap" && request.method === "GET") {
        return getEditorBootstrap(request, env);
      }

      if (url.pathname === "/api/pitchers/resolve-or-create" && request.method === "POST") {
        return resolveOrCreatePitcher(request, env, identity!);
      }

      if (url.pathname === "/api/boards" && request.method === "POST") {
        return createBoard(request, env, identity!);
      }

      const boardMatch = url.pathname.match(/^\/api\/boards\/(\d+)$/);
      if (boardMatch && request.method === "GET") {
        return getBoardById(env, Number(boardMatch[1]));
      }
      if (boardMatch && request.method === "PATCH") {
        return updateBoard(request, env, identity!, Number(boardMatch[1]));
      }

      const boardPropsMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/props$/);
      if (boardPropsMatch && request.method === "POST") {
        return createProp(request, env, identity!, Number(boardPropsMatch[1]));
      }

      const refreshPitchersMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/refresh-pitchers$/);
      if (refreshPitchersMatch && request.method === "POST") {
        return refreshPitcherBatch(env, identity!, Number(refreshPitchersMatch[1]), url);
      }

      const refreshMatchupsMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/refresh-matchups$/);
      if (refreshMatchupsMatch && request.method === "POST") {
        return refreshMatchupBatch(env, identity!, Number(refreshMatchupsMatch[1]), url);
      }

      const refreshProcessMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/refresh-process$/);
      if (refreshProcessMatch && request.method === "POST") {
        return refreshAndProcessBoard(env, identity!, Number(refreshProcessMatch[1]));
      }

      const processMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/process$/);
      if (processMatch && request.method === "POST") {
        return processBoard(env, identity!, Number(processMatch[1]));
      }

      const gradeResultsMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/grade-results$/);
      if (gradeResultsMatch && request.method === "POST") {
        return gradeBoardResults(env, identity!, Number(gradeResultsMatch[1]));
      }

      const activateMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/activate$/);
      if (activateMatch && request.method === "POST") {
        return activateBoard(env, identity!, Number(activateMatch[1]));
      }

      const pregameChecksMatch = url.pathname.match(/^\/api\/boards\/(\d+)\/pregame-checks$/);
      if (pregameChecksMatch && request.method === "POST") {
        return automatePregameChecks(env, identity!, Number(pregameChecksMatch[1]));
      }

      const lifecycleMatch = url.pathname.match(/^\/api\/props\/(\d+)\/lifecycle$/);
      if (lifecycleMatch && request.method === "PATCH") {
        return updateRecommendationLifecycle(request, env, identity!, Number(lifecycleMatch[1]));
      }

      const postgameReviewMatch = url.pathname.match(/^\/api\/props\/(\d+)\/postgame-review$/);
      if (postgameReviewMatch && request.method === "PATCH") {
        return updatePostgameReview(request, env, identity!, Number(postgameReviewMatch[1]));
      }

      const propMatch = url.pathname.match(/^\/api\/props\/(\d+)$/);
      if (propMatch && request.method === "PATCH") {
        return updateProp(request, env, identity!, Number(propMatch[1]));
      }
      if (propMatch && request.method === "DELETE") {
        return deleteProp(env, identity!, Number(propMatch[1]));
      }

      if (url.pathname === "/api/pitchers" && request.method === "GET") {
        return getPitchers(env, url);
      }

      const pitcherHistoryMatch = url.pathname.match(/^\/api\/pitchers\/(\d+)\/history$/);
      if (pitcherHistoryMatch && request.method === "GET") {
        return getPitcherHistory(env, Number(pitcherHistoryMatch[1]));
      }


      if (url.pathname === "/api/calibration" && request.method === "GET") {
        return getCalibration(env);
      }

      if (url.pathname === "/api/results" && request.method === "GET") {
        return getRecentResults(env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        return notFound(url.pathname);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      console.error(error);

      return json(
        {
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(Promise.all([
      autoRefreshPregameBoards(env, controller.scheduledTime),
      autoGradePreviousBoard(env, controller.scheduledTime),
    ]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;