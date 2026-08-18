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

const accessJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessJwks(issuer: string) {
  let jwks = accessJwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessJwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

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
  const jwks = getAccessJwks(issuer);

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
      CASE r.model_decision
        WHEN 'PLAY' THEN 0
        WHEN 'LEAN' THEN 1
        WHEN 'WATCH' THEN 2
        WHEN 'PASS' THEN 3
        WHEN 'AUTO PASS' THEN 4
        ELSE 5
      END,
      CASE WHEN r.recommendation_score IS NULL THEN 1 ELSE 0 END,
      r.recommendation_score DESC,
      ABS(COALESCE(r.model_edge, 0)) DESC,
      pi.canonical_name
  `).bind(board.board_id).all();

  const categoryRecordsPromise = env.DB.prepare(`
    SELECT
      UPPER(TRIM(r.decision_tier)) AS category,
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
    FROM props p
    JOIN boards b ON b.board_id = p.board_id
    JOIN prop_results pr ON pr.prop_id = p.prop_id
    JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    WHERE pr.result_status <> 'PENDING'
      AND b.board_date <= ?
      AND UPPER(TRIM(r.decision_tier)) IN ('CORE', 'SECONDARY', 'LEAN')
    GROUP BY UPPER(TRIM(r.decision_tier))
    ORDER BY CASE UPPER(TRIM(r.decision_tier))
      WHEN 'CORE' THEN 0
      WHEN 'SECONDARY' THEN 1
      WHEN 'LEAN' THEN 2
      ELSE 3
    END
  `).bind(board.board_date).all();

  const dailyCategoryRecordsPromise = env.DB.prepare(`
    SELECT
      UPPER(TRIM(r.decision_tier)) AS category,
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
    FROM props p
    JOIN prop_results pr ON pr.prop_id = p.prop_id
    JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
    )
    WHERE p.board_id = ?
      AND pr.result_status <> 'PENDING'
      AND UPPER(TRIM(r.decision_tier)) IN ('CORE', 'SECONDARY', 'LEAN')
    GROUP BY UPPER(TRIM(r.decision_tier))
    ORDER BY CASE UPPER(TRIM(r.decision_tier))
      WHEN 'CORE' THEN 0
      WHEN 'SECONDARY' THEN 1
      WHEN 'LEAN' THEN 2
      ELSE 3
    END
  `).bind(board.board_id).all();

  const [
    summary,
    recommendations,
    workflowBoards,
    modelRecords,
    recentResults,
    yesterdayBoard,
    lifetimeRecords,
    categoryRecords,
    dailyCategoryRecords,
  ] = await Promise.all([
    summaryPromise,
    recommendationsPromise,
    workflowBoardsPromise,
    modelRecordsPromise,
    recentResultsPromise,
    yesterdayBoardPromise,
    lifetimeRecordsPromise,
    categoryRecordsPromise,
    dailyCategoryRecordsPromise,
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

    const yesterdayCategoryRecords = await env.DB.prepare(`
      SELECT
        UPPER(TRIM(r.decision_tier)) AS category,
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
      FROM props p
      JOIN prop_results pr ON pr.prop_id = p.prop_id
      JOIN recommendations r ON r.recommendation_id = (
        SELECT r2.recommendation_id
        FROM recommendations r2
        WHERE r2.prop_id = p.prop_id
        ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
        LIMIT 1
      )
      WHERE p.board_id = ?
        AND pr.result_status <> 'PENDING'
        AND UPPER(TRIM(r.decision_tier)) IN ('CORE', 'SECONDARY', 'LEAN')
      GROUP BY UPPER(TRIM(r.decision_tier))
      ORDER BY CASE UPPER(TRIM(r.decision_tier))
        WHEN 'CORE' THEN 0
        WHEN 'SECONDARY' THEN 1
        WHEN 'LEAN' THEN 2
        ELSE 3
      END
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
      category_records: yesterdayCategoryRecords.results,
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
    category_records: categoryRecords.results,
    daily_category_records: dailyCategoryRecords.results,
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
      r.model_version_id,
      mv.version_name AS model_version_name,
      r.projected_strikeouts,
      r.base_projected_strikeouts,
      r.matchup_projected_strikeouts,
      r.same_opponent_adjustment,
      r.calibration_adjustment,
      r.calibration_sample_size,
      r.calibration_hit_rate,
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
      fs.same_opponent_start_count,
      fs.same_opponent_k_avg,
      fs.same_opponent_bf_avg,
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
      ON r.recommendation_id = (
        SELECT r2.recommendation_id
        FROM recommendations r2
        WHERE r2.prop_id = p.prop_id
        ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
        LIMIT 1
      )
    LEFT JOIN model_versions mv ON mv.model_version_id = r.model_version_id
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
    LEFT JOIN recommendations r ON r.recommendation_id = (
      SELECT r2.recommendation_id
      FROM recommendations r2
      WHERE r2.prop_id = p.prop_id
      ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
      LIMIT 1
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
  board_id: number;
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


interface V13ScoreInput {
  modelEdge: number;
  estimatedOverRate: number;
  formDelta: number;
  recentFormGate: string;
  volumeGate: string;
  matchupGate: string;
  roleGate: string;
  completenessScore: number;
  availableSide: string;
  preferredSide: string;
  usableStarts: number;
}

function scoreRecommendationV13(input: V13ScoreInput) {
  const absoluteEdge = Math.abs(input.modelEdge);
  const probabilityEdge = Math.abs(input.estimatedOverRate - 0.5) * 2;
  const isMore = input.preferredSide === "More";

  // V13 is directional: the same matchup/form/volume signal must not score
  // identically for More and Less recommendations.
  const projection = clamp((absoluteEdge / 1.75) * 25 + probabilityEdge * 5, 0, 30);

  const recentForm = isMore
    ? (input.formDelta >= 0.5 ? 15 : input.formDelta >= -0.5 ? 12 : input.formDelta >= -1.0 ? 8 : 2)
    : (input.formDelta <= -1.5 ? 15 : input.formDelta <= -1.0 ? 13 : input.formDelta <= 0 ? 10 : input.formDelta <= 0.75 ? 7 : 3);

  const volume = isMore
    ? (input.volumeGate === "PASS" ? 15 : input.volumeGate === "WATCH" ? 7 : 1)
    : (input.volumeGate === "FAIL" ? 13 : input.volumeGate === "WATCH" ? 15 : 10);

  const matchup = isMore
    ? (input.matchupGate === "STRONG PASS" ? 20
      : input.matchupGate === "PASS" ? 17
      : input.matchupGate === "NEUTRAL" ? 10
      : input.matchupGate === "WATCH" ? 4
      : input.matchupGate === "FAIL" ? 0 : 4)
    : (input.matchupGate === "FAIL" ? 20
      : input.matchupGate === "WATCH" ? 17
      : input.matchupGate === "NEUTRAL" ? 10
      : input.matchupGate === "PASS" ? 4
      : input.matchupGate === "STRONG PASS" ? 0 : 4);

  const role = input.roleGate === "PASS" ? 10 : input.roleGate === "WATCH" ? 5 : 0;
  const completeness = clamp(input.completenessScore / 10, 0, 10);
  let score = projection + recentForm + volume + matchup + role + completeness;

  const blockers: string[] = [];
  if (input.usableStarts < 3) blockers.push("INSUFFICIENT_SAMPLE");
  if (input.roleGate === "FAIL") blockers.push("UNSTABLE_ROLE");
  if (input.availableSide === "More only" && input.preferredSide === "Less") blockers.push("SIDE_UNAVAILABLE");

  // More has been materially weaker in the production history, so V13 requires
  // all major evidence gates before it can become a PLAY.
  const morePlayEligible = isMore
    && input.usableStarts >= 5
    && absoluteEdge >= 1.25
    && input.roleGate === "PASS"
    && input.volumeGate === "PASS"
    && input.recentFormGate === "PASS"
    && ["PASS", "STRONG PASS"].includes(input.matchupGate)
    && input.completenessScore >= 70;

  // Less has performed better, but still needs a real edge, stable role, and
  // no clearly hostile high-strikeout matchup.
  const lessPlayEligibleFinal = !isMore
    && input.usableStarts >= 5
    && absoluteEdge >= 0.85
    && input.roleGate === "PASS"
    && (input.volumeGate !== "PASS" || absoluteEdge >= 1.25)
    && ["FAIL", "WATCH", "NEUTRAL"].includes(input.matchupGate)
    && input.completenessScore >= 65;

  if (isMore && !morePlayEligible) blockers.push("MORE_PLAY_GATES_NOT_MET");
  if (!isMore && !lessPlayEligibleFinal) blockers.push("LESS_PLAY_GATES_NOT_MET");

  const hardConflict = blockers.includes("SIDE_UNAVAILABLE") || blockers.includes("INSUFFICIENT_SAMPLE");
  if (input.roleGate === "FAIL") score = Math.min(score, 44);
  if (hardConflict) score = Math.min(score, 39);
  if (isMore && input.volumeGate === "FAIL") score = Math.min(score, 49);
  if (isMore && input.recentFormGate === "FAIL") score = Math.min(score, 54);
  if (isMore && ["WATCH", "FAIL"].includes(input.matchupGate)) score = Math.min(score, 59);
  if (!isMore && ["PASS", "STRONG PASS"].includes(input.matchupGate)) score = Math.min(score, 59);
  score = Math.round(clamp(score, 0, 100));

  const playEligible = morePlayEligible || lessPlayEligibleFinal;
  const coreEligible = playEligible
    && input.usableStarts >= 7
    && input.roleGate === "PASS"
    && input.completenessScore >= 80
    && absoluteEdge >= (isMore ? 1.50 : 1.10)
    && score >= 84;

  let band: string;
  let modelDecision: string;
  let decisionTier: string;

  if (hardConflict) {
    band = "AUTO PASS";
    modelDecision = "AUTO PASS";
    decisionTier = "AUTO PASS";
  } else if (coreEligible) {
    band = "CORE CANDIDATE";
    modelDecision = "PLAY";
    decisionTier = "CORE";
  } else if (playEligible && score >= 74) {
    band = "STRONG LEAN";
    modelDecision = "PLAY";
    decisionTier = "SECONDARY";
  } else if (score >= 64 && absoluteEdge >= (isMore ? 0.75 : 0.60)) {
    band = "LEAN";
    modelDecision = "LEAN";
    decisionTier = "LEAN";
  } else if (score >= 48) {
    band = "WATCH";
    modelDecision = "WATCH";
    decisionTier = "WATCH";
  } else {
    band = "PASS";
    modelDecision = "PASS";
    decisionTier = "PASS";
  }

  return {
    score, band, modelDecision, decisionTier, blockers,
    eligibility: { morePlayEligible, lessPlayEligible: lessPlayEligibleFinal, coreEligible },
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
    .replace(/[.'â€™\-]/g, " ")
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


interface TeamSplitSyncResult {
  sync_run_id: number;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  as_of_date: string;
  teams_requested: number;
  teams_processed: number;
  rows_inserted: number;
  rows_updated: number;
  rows_unchanged: number;
  rejected: number;
  next_offset: number;
}

interface TeamSplitTarget {
  team_id: number;
  abbreviation: string;
  mlb_team_id: number;
}

interface MlbScheduleGameForSplit {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
}

function normalizedMlbTeamAbbreviation(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^@\s*/, "")
    .replace(/[^A-Z]/g, "");
}

async function getCanonicalTeamSplitTargets(env: Env): Promise<TeamSplitTarget[]> {
  const rows = await env.DB.prepare(`
    SELECT team_id, abbreviation
    FROM teams
    WHERE abbreviation IS NOT NULL
    ORDER BY team_id
  `).all<{ team_id: number; abbreviation: string }>();

  const byMlbId = new Map<number, Array<{ team_id: number; abbreviation: string; normalized: string }>>();
  for (const row of rows.results) {
    const normalized = normalizedMlbTeamAbbreviation(row.abbreviation);
    const mlbId = MLB_TEAM_IDS[normalized];
    if (!mlbId) continue;
    const list = byMlbId.get(mlbId) ?? [];
    list.push({ team_id: row.team_id, abbreviation: row.abbreviation, normalized });
    byMlbId.set(mlbId, list);
  }

  const targets: TeamSplitTarget[] = [];
  for (const [mlbId, candidates] of byMlbId.entries()) {
    const preferred = MLB_TEAM_ABBREVIATIONS[mlbId] ?? candidates[0]?.normalized ?? "";
    const selected = candidates.find((candidate) => candidate.normalized === preferred)
      ?? candidates.find((candidate) => !String(candidate.abbreviation).trim().startsWith("@"))
      ?? candidates[0];
    if (!selected) continue;
    targets.push({ team_id: selected.team_id, abbreviation: preferred, mlb_team_id: mlbId });
  }

  return targets.sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));
}

async function fetchTeamSeasonHandSplit(
  mlbTeamId: number,
  pitcherHand: "L" | "R",
  season: number,
): Promise<{ plateAppearances: number; strikeouts: number; walks: number | null; strikeoutRate: number; walkRate: number | null }> {
  const url = new URL(`https://statsapi.mlb.com/api/v1/teams/${mlbTeamId}/stats`);
  url.searchParams.set("stats", "statSplits");
  url.searchParams.set("group", "hitting");
  url.searchParams.set("season", String(season));
  url.searchParams.set("gameType", "R");
  url.searchParams.set("sitCodes", pitcherHand === "L" ? "vl" : "vr");

  const payload = await fetchMlbJson(url.toString());
  const blocks = Array.isArray(payload.stats) ? payload.stats as Array<Record<string, unknown>> : [];
  const splits = blocks.flatMap((block) => Array.isArray(block.splits) ? block.splits as Array<Record<string, unknown>> : []);
  const stat = splits[0] && typeof splits[0].stat === "object" && splits[0].stat !== null
    ? splits[0].stat as Record<string, unknown> : null;
  if (!stat) throw new Error("MLB season handedness response contained no statistics.");
  const plateAppearances = optionalNumber(stat.plateAppearances);
  const strikeouts = optionalNumber(stat.strikeOuts);
  const walks = optionalNumber(stat.baseOnBalls);
  if (plateAppearances === null || plateAppearances <= 0 || strikeouts === null) {
    throw new Error("MLB season handedness response was missing plate appearances or strikeouts.");
  }
  return {
    plateAppearances,
    strikeouts,
    walks,
    strikeoutRate: strikeouts / plateAppearances,
    walkRate: walks === null ? null : walks / plateAppearances,
  };
}

async function fetchTeamRecentScheduleGames(
  mlbTeamId: number,
  startDate: string,
  endDate: string,
): Promise<MlbScheduleGameForSplit[]> {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("teamId", String(mlbTeamId));
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("gameTypes", "R");
  const payload = await fetchMlbJson(url.toString());
  const dates = Array.isArray(payload.dates) ? payload.dates as Array<Record<string, unknown>> : [];
  const output: MlbScheduleGameForSplit[] = [];
  for (const dateBlock of dates) {
    const games = Array.isArray(dateBlock.games) ? dateBlock.games as Array<Record<string, unknown>> : [];
    for (const game of games) {
      const status = game.status && typeof game.status === "object" ? game.status as Record<string, unknown> : {};
      const abstractState = String(status.abstractGameState ?? "");
      const codedState = String(status.codedGameState ?? "");
      if (abstractState !== "Final" && !["F", "O"].includes(codedState)) continue;
      const teams = game.teams && typeof game.teams === "object" ? game.teams as Record<string, unknown> : {};
      const home = teams.home && typeof teams.home === "object" ? teams.home as Record<string, unknown> : {};
      const away = teams.away && typeof teams.away === "object" ? teams.away as Record<string, unknown> : {};
      const homeTeam = home.team && typeof home.team === "object" ? home.team as Record<string, unknown> : {};
      const awayTeam = away.team && typeof away.team === "object" ? away.team as Record<string, unknown> : {};
      const gamePk = optionalNumber(game.gamePk);
      const homeTeamId = optionalNumber(homeTeam.id);
      const awayTeamId = optionalNumber(awayTeam.id);
      const officialDate = String(game.officialDate ?? dateBlock.date ?? "").slice(0, 10);
      if (!gamePk || !homeTeamId || !awayTeamId || !/^\d{4}-\d{2}-\d{2}$/.test(officialDate)) continue;
      output.push({ gamePk, officialDate, homeTeamId, awayTeamId });
    }
  }
  return output;
}

async function cacheGameHandednessBatting(
  env: Env,
  game: MlbScheduleGameForSplit,
  syncRunId: number,
): Promise<void> {
  const cached = await env.DB.prepare(`
    SELECT mlb_game_pk FROM team_game_handedness_games WHERE mlb_game_pk = ?
  `).bind(game.gamePk).first<{ mlb_game_pk: number }>();
  if (cached) return;

  const payload = await fetchMlbJson(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/playByPlay`);
  const plays = Array.isArray(payload.allPlays) ? payload.allPlays as Array<Record<string, unknown>> : [];
  const counts = new Map<string, { pa: number; k: number; bb: number }>();
  for (const teamId of [game.homeTeamId, game.awayTeamId]) {
    for (const hand of ["L", "R"] as const) counts.set(`${teamId}:${hand}`, { pa: 0, k: 0, bb: 0 });
  }

  let usablePlays = 0;
  for (const play of plays) {
    const about = play.about && typeof play.about === "object" ? play.about as Record<string, unknown> : {};
    const matchup = play.matchup && typeof play.matchup === "object" ? play.matchup as Record<string, unknown> : {};
    const result = play.result && typeof play.result === "object" ? play.result as Record<string, unknown> : {};
    const pitchHand = matchup.pitchHand && typeof matchup.pitchHand === "object" ? matchup.pitchHand as Record<string, unknown> : {};
    const pitcherHand = String(pitchHand.code ?? "").toUpperCase();
    if (pitcherHand !== "L" && pitcherHand !== "R") continue;
    const halfInning = String(about.halfInning ?? "").toLowerCase();
    const battingTeamId = halfInning === "top" ? game.awayTeamId : halfInning === "bottom" ? game.homeTeamId : null;
    if (!battingTeamId) continue;
    const eventType = String(result.eventType ?? "").toLowerCase();
    if (!eventType) continue;
    const key = `${battingTeamId}:${pitcherHand}`;
    const row = counts.get(key);
    if (!row) continue;
    row.pa += 1;
    if (eventType === "strikeout" || eventType === "strikeout_double_play") row.k += 1;
    if (eventType === "walk" || eventType === "intent_walk" || eventType === "intentional_walk") row.bb += 1;
    usablePlays += 1;
  }

  if (usablePlays === 0) throw new Error(`MLB play-by-play contained no usable plate appearances for game ${game.gamePk}.`);

  const statements = [];
  for (const [key, row] of counts.entries()) {
    const [teamIdText, hand] = key.split(":");
    const battingTeamId = Number(teamIdText);
    const opponentTeamId = battingTeamId === game.homeTeamId ? game.awayTeamId : game.homeTeamId;
    statements.push(env.DB.prepare(`
      INSERT INTO team_game_handedness_batting (
        mlb_game_pk, official_date, batting_team_mlb_id, opponent_team_mlb_id,
        pitcher_hand, plate_appearances, strikeouts, walks, sync_run_id, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mlb_game_pk, batting_team_mlb_id, pitcher_hand) DO UPDATE SET
        official_date = excluded.official_date,
        opponent_team_mlb_id = excluded.opponent_team_mlb_id,
        plate_appearances = excluded.plate_appearances,
        strikeouts = excluded.strikeouts,
        walks = excluded.walks,
        sync_run_id = excluded.sync_run_id,
        last_synced_at = CURRENT_TIMESTAMP
    `).bind(game.gamePk, game.officialDate, battingTeamId, opponentTeamId, hand, row.pa, row.k, row.bb, syncRunId));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO team_game_handedness_games (mlb_game_pk, official_date, play_count, sync_run_id, processed_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mlb_game_pk) DO UPDATE SET
      official_date = excluded.official_date,
      play_count = excluded.play_count,
      sync_run_id = excluded.sync_run_id,
      processed_at = CURRENT_TIMESTAMP
  `).bind(game.gamePk, game.officialDate, usablePlays, syncRunId));
  await env.DB.batch(statements);
}

async function getRecentTeamHandSplit(
  env: Env,
  mlbTeamId: number,
  pitcherHand: "L" | "R",
  startDate: string,
  endDate: string,
): Promise<{ plateAppearances: number; strikeouts: number; walks: number; strikeoutRate: number; walkRate: number }> {
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(plate_appearances), 0) AS plate_appearances,
      COALESCE(SUM(strikeouts), 0) AS strikeouts,
      COALESCE(SUM(walks), 0) AS walks
    FROM team_game_handedness_batting
    WHERE batting_team_mlb_id = ?
      AND pitcher_hand = ?
      AND official_date BETWEEN ? AND ?
  `).bind(mlbTeamId, pitcherHand, startDate, endDate).first<{ plate_appearances: number; strikeouts: number; walks: number }>();
  const plateAppearances = Number(row?.plate_appearances ?? 0);
  const strikeouts = Number(row?.strikeouts ?? 0);
  const walks = Number(row?.walks ?? 0);
  return {
    plateAppearances,
    strikeouts,
    walks,
    strikeoutRate: plateAppearances > 0 ? strikeouts / plateAppearances : 0,
    walkRate: plateAppearances > 0 ? walks / plateAppearances : 0,
  };
}

async function recordTeamSplitSyncError(env: Env, syncRunId: number, stage: string, error: unknown, key: string | null = null): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(`
    INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt)
    VALUES (?,?,'TEAM_SPLIT_SYNC_ERROR',?,?,1,?)
  `).bind(syncRunId, stage, message, key, message.slice(0,1000)).run();
}

async function syncTeamStrikeoutSplits(
  env: Env,
  asOfDate: string,
  offset = 0,
  limit = 1,
  triggerSource: "CRON" | "ADMIN" | "API" | "MANUAL" = "MANUAL",
): Promise<TeamSplitSyncResult> {
  const safeDate = validateDate(asOfDate);
  const boundedLimit = 1;
  const targets = await getCanonicalTeamSplitTargets(env);
  const total = targets.length;
  const startOffset = total === 0 ? 0 : Math.max(0, Math.trunc(offset || 0)) % total;
  const teamRows = targets.slice(startOffset, startOffset + boundedLimit);
  const syncWindowStart = isoDateDaysBefore(safeDate, 30);

  const run = await env.DB.prepare(`
    INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end)
    VALUES (?,'MLB_STATS_API','TEAM_STRIKEOUT_SPLITS','INCREMENTAL',?,'RUNNING',?,?)
  `).bind(crypto.randomUUID(), triggerSource, String(startOffset), String(startOffset + boundedLimit)).run();
  const syncRunId = Number(run.meta.last_row_id);
  let inserted = 0, updated = 0, unchanged = 0, rejected = 0, processed = 0;
  const season = Number(safeDate.slice(0, 4));
  const recentWindows = [
    { days: 30, start: isoDateDaysBefore(safeDate, 30) },
    { days: 14, start: isoDateDaysBefore(safeDate, 14) },
    { days: 7, start: isoDateDaysBefore(safeDate, 7) },
  ];

  try {
    for (const team of teamRows) {
      const abbr = team.abbreviation;
      let teamOk = true;
      try {
        const games = await fetchTeamRecentScheduleGames(team.mlb_team_id, syncWindowStart, safeDate);
        for (const game of games) {
          try {
            await cacheGameHandednessBatting(env, game, syncRunId);
          } catch (error) {
            teamOk = false;
            rejected++;
            await recordTeamSplitSyncError(env, syncRunId, "PLAY_BY_PLAY", error, `${abbr}:${game.gamePk}`);
          }
        }

        const seasonSplits = {
          L: await fetchTeamSeasonHandSplit(team.mlb_team_id, "L", season),
          R: await fetchTeamSeasonHandSplit(team.mlb_team_id, "R", season),
        };
        if (
          seasonSplits.L.plateAppearances === seasonSplits.R.plateAppearances &&
          seasonSplits.L.strikeouts === seasonSplits.R.strikeouts
        ) {
          throw new Error(`Season handedness validation failed for ${abbr}: L/R splits are identical.`);
        }

        for (const hand of ["L", "R"] as const) {
          const allRows: Array<{
            days: number; start: string; source: string;
            split: { plateAppearances: number; strikeouts: number; walks: number | null; strikeoutRate: number; walkRate: number | null };
          }> = [{ days: 0, start: `${season}-03-01`, source: "MLB_STATS_API_STAT_SPLITS", split: seasonSplits[hand] }];

          for (const window of recentWindows) {
            const split = await getRecentTeamHandSplit(env, team.mlb_team_id, hand, window.start, safeDate);
            allRows.push({ days: window.days, start: window.start, source: "MLB_PLAY_BY_PLAY", split });
          }

          for (const row of allRows) {
            const existing = await env.DB.prepare(`
              SELECT plate_appearances,strikeouts,walks
              FROM team_strikeout_splits_daily
              WHERE team_id=? AND as_of_date=? AND pitcher_hand=? AND window_days=?
            `).bind(team.team_id, safeDate, hand, row.days)
              .first<{ plate_appearances: number; strikeouts: number; walks: number | null }>();

            await env.DB.prepare(`
              INSERT INTO team_strikeout_splits_daily (
                team_id,mlb_team_id,as_of_date,season,pitcher_hand,window_days,start_date,end_date,
                plate_appearances,strikeouts,walks,strikeout_rate,walk_rate,source_name,sync_run_id,last_synced_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(team_id,as_of_date,pitcher_hand,window_days) DO UPDATE SET
                mlb_team_id=excluded.mlb_team_id,season=excluded.season,start_date=excluded.start_date,end_date=excluded.end_date,
                plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,walks=excluded.walks,
                strikeout_rate=excluded.strikeout_rate,walk_rate=excluded.walk_rate,source_name=excluded.source_name,
                sync_run_id=excluded.sync_run_id,last_synced_at=CURRENT_TIMESTAMP
            `).bind(
              team.team_id, team.mlb_team_id, safeDate, season, hand, row.days, row.start, safeDate,
              row.split.plateAppearances, row.split.strikeouts, row.split.walks, row.split.strikeoutRate, row.split.walkRate,
              row.source, syncRunId,
            ).run();

            if (!existing) inserted++;
            else if (
              Number(existing.plate_appearances) !== row.split.plateAppearances ||
              Number(existing.strikeouts) !== row.split.strikeouts ||
              Number(existing.walks ?? -1) !== Number(row.split.walks ?? -1)
            ) updated++;
            else unchanged++;

            if (row.days === 0) {
              await env.DB.prepare(`
                INSERT INTO team_handedness_stats (
                  team_id,season,pitcher_hand,plate_appearances,strikeouts,strikeout_rate,
                  league_average_rate,handedness_edge,source,refreshed_at
                ) VALUES (?,?,?,?,?,?,?,?, 'MLB Stats API statSplits',CURRENT_TIMESTAMP)
                ON CONFLICT(team_id,season,pitcher_hand) DO UPDATE SET
                  plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,
                  strikeout_rate=excluded.strikeout_rate,league_average_rate=excluded.league_average_rate,
                  handedness_edge=excluded.handedness_edge,source=excluded.source,refreshed_at=CURRENT_TIMESTAMP
              `).bind(
                team.team_id, season, hand, row.split.plateAppearances, row.split.strikeouts,
                row.split.strikeoutRate, LEAGUE_BASELINE_K_RATE, row.split.strikeoutRate - LEAGUE_BASELINE_K_RATE,
              ).run();
            }
          }
        }
      } catch (error) {
        teamOk = false;
        rejected++;
        await recordTeamSplitSyncError(env, syncRunId, "TEAM_SYNC", error, abbr);
      }
      if (teamOk) processed++;
    }

    const nextOffset = total === 0 ? 0 : ((startOffset + teamRows.length) % total);
    const status: TeamSplitSyncResult["status"] = rejected === 0 ? "SUCCEEDED" : (inserted + updated + unchanged) > 0 ? "PARTIAL" : "FAILED";
    await env.DB.prepare(`
      UPDATE sync_runs
      SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,
          freshness_cutoff_at=?,details_json=?
      WHERE sync_run_id=?
    `).bind(
      status, teamRows.length, inserted, updated, unchanged, rejected, safeDate,
      JSON.stringify({ teams_processed: processed, next_offset: nextOffset, canonical_team_count: total, split_method: "season_statSplits_plus_recent_playByPlay" }),
      syncRunId,
    ).run();

    const sourceStatus = status === "SUCCEEDED" ? "HEALTHY" : status === "PARTIAL" ? "INCOMPLETE" : "FAILED";
    await env.DB.prepare(`
      INSERT INTO data_source_status (
        source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,
        expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at
      ) VALUES (
        'MLB_STATS_API','TEAM_STRIKEOUT_SPLITS',?,CURRENT_TIMESTAMP,
        CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,30,240,
        CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM team_strikeout_splits_daily),?,?,CURRENT_TIMESTAMP
      )
      ON CONFLICT(source_name,dataset_name) DO UPDATE SET
        status=excluded.status,last_attempt_at=excluded.last_attempt_at,
        last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,
        last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,
        last_sync_run_id=excluded.last_sync_run_id,
        consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,
        record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP
    `).bind(
      sourceStatus, status, safeDate, syncRunId, status,
      `${processed}/${teamRows.length} canonical teams completed; ${inserted} inserted; ${updated} updated; ${rejected} rejected.`,
      JSON.stringify({ next_offset: nextOffset, batch_size: boundedLimit, canonical_team_count: total, recent_source: "MLB_PLAY_BY_PLAY" }),
    ).run();

    return {
      sync_run_id: syncRunId, status, as_of_date: safeDate, teams_requested: teamRows.length,
      teams_processed: processed, rows_inserted: inserted, rows_updated: updated,
      rows_unchanged: unchanged, rejected, next_offset: nextOffset,
    };
  } catch (error) {
    await recordTeamSplitSyncError(env, syncRunId, "SYNC", error);
    await env.DB.prepare(`
      UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=?
      WHERE sync_run_id=?
    `).bind(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), syncRunId).run();
    throw error;
  }
}



type PitcherFeatureSyncStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

function featureMean(values: Array<number | null | undefined>): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((a,b)=>a+b,0)/clean.length;
}

function featureRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function featureRound(value: number | null, digits = 6): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function syncPitcherDailyFeatures(
  env: Env,
  asOfDate: string,
  triggerSource: "CRON" | "ADMIN" | "API" | "MANUAL" = "MANUAL",
): Promise<Record<string, unknown>> {
  const safeDate = validateDate(asOfDate);
  const season = Number(safeDate.slice(0,4));
  const run = await env.DB.prepare(`
    INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end)
    VALUES (?,'FEATURE_STORE','PITCHER_DAILY_FEATURES','INCREMENTAL',?,'RUNNING',?,?)
  `).bind(crypto.randomUUID(), triggerSource, safeDate, safeDate).run();
  const syncRunId = Number(run.meta.last_row_id);
  let inserted=0, updated=0, unchanged=0, rejected=0, processed=0;
  try {
    const pitchers = await env.DB.prepare(`
      SELECT p.pitcher_id, p.mlb_id AS mlb_pitcher_id, p.canonical_name AS pitcher_name
      FROM pitchers p
      WHERE p.mlb_id IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM raw_pitcher_game_logs r WHERE r.pitcher_id=p.pitcher_id AND r.starter=1 AND r.game_date < ? AND substr(r.game_date,1,4)=?)
          OR EXISTS (SELECT 1 FROM pitcher_game_stats g WHERE g.pitcher_id=p.pitcher_id AND g.starter=1 AND g.game_date < ? AND substr(g.game_date,1,4)=?)
        )
      ORDER BY p.pitcher_id
    `).bind(safeDate, String(season), safeDate, String(season)).all<Record<string, unknown>>();

    for (const pitcher of pitchers.results) {
      try {
        const mlbPitcherId = Number(pitcher.mlb_pitcher_id);
        const localPitcherId = Number(pitcher.pitcher_id);
        const startsResult = await env.DB.prepare(`
          SELECT game_date,home_away,strikeouts,batters_faced,outs_recorded,pitch_count,source_kind
          FROM (
            SELECT r.game_date,r.home_away,r.strikeouts,r.batters_faced,r.outs_recorded,r.pitch_count,'RAW' source_kind
            FROM raw_pitcher_game_logs r
            WHERE r.pitcher_id=? AND r.starter=1 AND r.game_date < ? AND substr(r.game_date,1,4)=?
            UNION ALL
            SELECT g.game_date,'' home_away,g.strikeouts,g.batters_faced,CAST(ROUND(COALESCE(g.innings_pitched,0)*3) AS INTEGER) outs_recorded,g.pitch_count,'LEGACY' source_kind
            FROM pitcher_game_stats g
            WHERE g.pitcher_id=? AND g.starter=1 AND g.game_date < ? AND substr(g.game_date,1,4)=?
              AND NOT EXISTS (SELECT 1 FROM raw_pitcher_game_logs r2 WHERE r2.pitcher_id=g.pitcher_id AND r2.game_date=g.game_date AND r2.starter=1)
          )
          ORDER BY game_date DESC
          LIMIT 40
        `).bind(localPitcherId, safeDate, String(season), localPitcherId, safeDate, String(season)).all<Record<string, unknown>>();
        const starts = startsResult.results.map(r => ({
          date:String(r.game_date), homeAway:String(r.home_away ?? ''), sourceKind:String(r.source_kind ?? ''),
          k:Number(r.strikeouts ?? 0), bf:Number(r.batters_faced ?? 0),
          outs:Number(r.outs_recorded ?? 0), pitches:Number(r.pitch_count ?? 0),
        }));
        if (!starts.length) continue;
        const summarize=(rows: typeof starts)=>{
          const k=rows.reduce((a,r)=>a+r.k,0), bf=rows.reduce((a,r)=>a+r.bf,0), outs=rows.reduce((a,r)=>a+r.outs,0), pitches=rows.reduce((a,r)=>a+r.pitches,0);
          return { count:rows.length,k,bf,outs,pitches,kbf:featureRatio(k,bf),kpi:featureRatio(k*3,outs),avgK:featureMean(rows.map(r=>r.k)),avgBf:featureMean(rows.map(r=>r.bf)),avgIp:featureMean(rows.map(r=>r.outs/3)),avgPitches:featureMean(rows.map(r=>r.pitches)) };
        };
        const seasonRows=starts, l3=starts.slice(0,3), l5=starts.slice(0,5), l10=starts.slice(0,10), prior3=starts.slice(3,6);
        const ss=summarize(seasonRows), s3=summarize(l3), s5=summarize(l5), s10=summarize(l10), p3=summarize(prior3);
        const home=summarize(starts.filter(r=>r.homeAway==='HOME')), away=summarize(starts.filter(r=>r.homeAway==='AWAY'));
        const lastStartDate=starts[0].date;
        const daysSince=Math.max(0, Math.round((Date.parse(`${safeDate}T00:00:00Z`)-Date.parse(`${lastStartDate}T00:00:00Z`))/86400000));
        const flags:string[]=[];
        if (starts.length < 3) flags.push('FEWER_THAN_3_STARTS');
        if (starts.length < 5) flags.push('FEWER_THAN_5_STARTS');
        if (starts.filter(r=>r.bf>0).length < starts.length) flags.push('MISSING_BATTERS_FACED');
        if (starts.filter(r=>r.pitches>0).length < starts.length) flags.push('MISSING_PITCH_COUNT');
        if (starts.filter(r=>r.outs>0).length < starts.length) flags.push('MISSING_OUTS_RECORDED');
        if (starts.some(r=>r.sourceKind==='LEGACY')) flags.push('LEGACY_PITCHER_GAME_STATS_USED');
        if (starts.some(r=>!r.homeAway)) flags.push('PARTIAL_HOME_AWAY_HISTORY');
        let quality=100;
        if (starts.length<5) quality-=25; else if (starts.length<10) quality-=10;
        if (flags.includes('MISSING_BATTERS_FACED')) quality-=20;
        if (flags.includes('MISSING_PITCH_COUNT')) quality-=10;
        if (flags.includes('MISSING_OUTS_RECORDED')) quality-=10;
        quality=Math.max(0,Math.min(100,quality));

        const existing=await env.DB.prepare(`SELECT pitcher_daily_feature_id, season_starts, season_strikeouts, season_batters_faced, season_pitch_count, last5_k_per_bf, data_quality_score FROM pitcher_daily_features WHERE mlb_pitcher_id=? AND as_of_date=? AND feature_version='pitcher-daily-v1'`).bind(mlbPitcherId,safeDate).first<Record<string,unknown>>();
        await env.DB.prepare(`
          INSERT INTO pitcher_daily_features (
            pitcher_id,mlb_pitcher_id,pitcher_name,as_of_date,season,source_cutoff_date,
            season_starts,last3_starts,last5_starts,last10_starts,season_strikeouts,season_batters_faced,season_outs_recorded,season_pitch_count,
            season_k_per_bf,season_k_per_inning,season_avg_strikeouts,season_avg_batters_faced,season_avg_innings,season_avg_pitch_count,
            last3_k_per_bf,last3_avg_strikeouts,last3_avg_batters_faced,last3_avg_innings,last3_avg_pitch_count,
            last5_k_per_bf,last5_avg_strikeouts,last5_avg_batters_faced,last5_avg_innings,last5_avg_pitch_count,
            last10_k_per_bf,last10_avg_strikeouts,last10_avg_batters_faced,last10_avg_innings,last10_avg_pitch_count,
            home_k_per_bf,away_k_per_bf,days_since_last_start,last_start_date,pitch_count_trend_3v3,innings_trend_3v3,strikeout_trend_3v3,
            recent5_vs_season_k_per_bf,data_quality_score,data_quality_flags_json,feature_version,sync_run_id,generated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(mlb_pitcher_id,as_of_date,feature_version) DO UPDATE SET
            pitcher_id=excluded.pitcher_id,pitcher_name=excluded.pitcher_name,season=excluded.season,source_cutoff_date=excluded.source_cutoff_date,
            season_starts=excluded.season_starts,last3_starts=excluded.last3_starts,last5_starts=excluded.last5_starts,last10_starts=excluded.last10_starts,
            season_strikeouts=excluded.season_strikeouts,season_batters_faced=excluded.season_batters_faced,season_outs_recorded=excluded.season_outs_recorded,season_pitch_count=excluded.season_pitch_count,
            season_k_per_bf=excluded.season_k_per_bf,season_k_per_inning=excluded.season_k_per_inning,season_avg_strikeouts=excluded.season_avg_strikeouts,
            season_avg_batters_faced=excluded.season_avg_batters_faced,season_avg_innings=excluded.season_avg_innings,season_avg_pitch_count=excluded.season_avg_pitch_count,
            last3_k_per_bf=excluded.last3_k_per_bf,last3_avg_strikeouts=excluded.last3_avg_strikeouts,last3_avg_batters_faced=excluded.last3_avg_batters_faced,last3_avg_innings=excluded.last3_avg_innings,last3_avg_pitch_count=excluded.last3_avg_pitch_count,
            last5_k_per_bf=excluded.last5_k_per_bf,last5_avg_strikeouts=excluded.last5_avg_strikeouts,last5_avg_batters_faced=excluded.last5_avg_batters_faced,last5_avg_innings=excluded.last5_avg_innings,last5_avg_pitch_count=excluded.last5_avg_pitch_count,
            last10_k_per_bf=excluded.last10_k_per_bf,last10_avg_strikeouts=excluded.last10_avg_strikeouts,last10_avg_batters_faced=excluded.last10_avg_batters_faced,last10_avg_innings=excluded.last10_avg_innings,last10_avg_pitch_count=excluded.last10_avg_pitch_count,
            home_k_per_bf=excluded.home_k_per_bf,away_k_per_bf=excluded.away_k_per_bf,days_since_last_start=excluded.days_since_last_start,last_start_date=excluded.last_start_date,
            pitch_count_trend_3v3=excluded.pitch_count_trend_3v3,innings_trend_3v3=excluded.innings_trend_3v3,strikeout_trend_3v3=excluded.strikeout_trend_3v3,
            recent5_vs_season_k_per_bf=excluded.recent5_vs_season_k_per_bf,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,
            sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP
        `).bind(
          pitcher.pitcher_id ?? null,mlbPitcherId,String(pitcher.pitcher_name ?? `MLB ${mlbPitcherId}`),safeDate,season,lastStartDate,
          ss.count,s3.count,s5.count,s10.count,ss.k,ss.bf,ss.outs,ss.pitches,
          featureRound(ss.kbf),featureRound(ss.kpi),featureRound(ss.avgK),featureRound(ss.avgBf),featureRound(ss.avgIp),featureRound(ss.avgPitches),
          featureRound(s3.kbf),featureRound(s3.avgK),featureRound(s3.avgBf),featureRound(s3.avgIp),featureRound(s3.avgPitches),
          featureRound(s5.kbf),featureRound(s5.avgK),featureRound(s5.avgBf),featureRound(s5.avgIp),featureRound(s5.avgPitches),
          featureRound(s10.kbf),featureRound(s10.avgK),featureRound(s10.avgBf),featureRound(s10.avgIp),featureRound(s10.avgPitches),
          featureRound(home.kbf),featureRound(away.kbf),daysSince,lastStartDate,
          featureRound((s3.avgPitches??0)-(p3.avgPitches??s3.avgPitches??0)),featureRound((s3.avgIp??0)-(p3.avgIp??s3.avgIp??0)),featureRound((s3.avgK??0)-(p3.avgK??s3.avgK??0)),
          featureRound((s5.kbf??0)-(ss.kbf??0)),quality,JSON.stringify(flags),'pitcher-daily-v1',syncRunId,
        ).run();
        if (!existing) inserted++;
        else {
          const changed = Number(existing.season_starts)!==ss.count || Number(existing.season_strikeouts)!==ss.k || Number(existing.season_batters_faced)!==ss.bf || Number(existing.season_pitch_count)!==ss.pitches || Number(existing.last5_k_per_bf ?? -1)!==Number(featureRound(s5.kbf) ?? -1) || Number(existing.data_quality_score)!==quality;
          if (changed) updated++; else unchanged++;
        }
        processed++;
      } catch (error) {
        rejected++;
        const message=error instanceof Error?error.message:String(error);
        await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'PITCHER_FEATURE','PITCHER_DAILY_FEATURE_ERROR',?,?,1,?)`).bind(syncRunId,message,String(pitcher.mlb_pitcher_id ?? ''),message.slice(0,1000)).run();
      }
    }
    const status:PitcherFeatureSyncStatus = rejected===0?'SUCCEEDED':processed>0?'PARTIAL':'FAILED';
    const sourceStatus=status==='SUCCEEDED'?'HEALTHY':status==='PARTIAL'?'INCOMPLETE':'FAILED';
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,pitchers.results.length,inserted,updated,unchanged,rejected,safeDate,JSON.stringify({pitchers_processed:processed,feature_version:'pitcher-daily-v1',source_cutoff_rule:'game_date < as_of_date'}),syncRunId).run();
    await env.DB.prepare(`
      INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at)
      VALUES ('FEATURE_STORE','PITCHER_DAILY_FEATURES',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM pitcher_daily_features),?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP
    `).bind(sourceStatus,status,safeDate,syncRunId,status,`${processed} pitchers generated; ${inserted} inserted; ${updated} updated; ${unchanged} unchanged; ${rejected} rejected.`,JSON.stringify({feature_version:'pitcher-daily-v1',as_of_date:safeDate})).run();
    return {sync_run_id:syncRunId,status,as_of_date:safeDate,pitchers_read:pitchers.results.length,pitchers_processed:processed,rows_inserted:inserted,rows_updated:updated,rows_unchanged:unchanged,rejected};
  } catch (error) {
    const message=error instanceof Error?error.message:String(error);
    await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();
    throw error;
  }
}

async function getPitcherDailyFeatureStatus(env:Env,url:URL):Promise<Response>{
  const date=url.searchParams.get('date')?validateDate(String(url.searchParams.get('date'))):chicagoDateString(Date.now());
  const source=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='FEATURE_STORE' AND dataset_name='PITCHER_DAILY_FEATURES'`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) error_count FROM sync_runs sr WHERE sr.dataset_name='PITCHER_DAILY_FEATURES' ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const rows=await env.DB.prepare(`SELECT * FROM pitcher_daily_features WHERE as_of_date=(SELECT MAX(as_of_date) FROM pitcher_daily_features WHERE as_of_date<=?) ORDER BY data_quality_score DESC,season_starts DESC,pitcher_name LIMIT 250`).bind(date).all<Record<string,unknown>>();
  return json({source_status:source,recent_runs:runs.results,features:rows.results});
}

async function runPitcherDailyFeatureSync(request:Request,env:Env):Promise<Response>{
  const input=await parseJson<{as_of_date?:string}>(request);
  return json({ok:true,...await syncPitcherDailyFeatures(env,input.as_of_date?validateDate(input.as_of_date):chicagoDateString(Date.now()),'ADMIN')});
}

async function autoSyncPitcherDailyFeatures(env:Env,scheduledTime:number):Promise<void>{
  const local=chicagoDateParts(scheduledTime);
  if (local.minute!==25) return;
  await syncPitcherDailyFeatures(env,chicagoDateString(scheduledTime),'CRON');
}



type TeamDailyFeatureSyncStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

type TeamSplitFeatureRow = {
  team_id: number;
  mlb_team_id: number;
  team_abbr: string;
  pitcher_hand: "L" | "R";
  window_days: number;
  plate_appearances: number;
  strikeouts: number;
  strikeout_rate: number;
  sync_run_id: number | null;
};

function teamFeatureClamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

async function syncTeamDailyFeatures(
  env: Env,
  asOfDate: string,
  triggerSource: "CRON" | "ADMIN" | "API" | "MANUAL" = "MANUAL",
): Promise<Record<string, unknown>> {
  const safeDate = validateDate(asOfDate);
  const sourceDateRow = await env.DB.prepare(`
    SELECT MAX(as_of_date) AS source_date
    FROM team_strikeout_splits_daily
    WHERE as_of_date < ?
  `).bind(safeDate).first<{ source_date: string | null }>();
  const sourceDate = sourceDateRow?.source_date ? String(sourceDateRow.source_date) : null;
  if (!sourceDate) throw new Error(`No completed team strikeout split snapshot exists before ${safeDate}.`);

  const run = await env.DB.prepare(`
    INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end)
    VALUES (?,'FEATURE_STORE','TEAM_DAILY_FEATURES','INCREMENTAL',?,'RUNNING',?,?)
  `).bind(crypto.randomUUID(), triggerSource, sourceDate, safeDate).run();
  const syncRunId = Number(run.meta.last_row_id);
  let inserted = 0, updated = 0, unchanged = 0, rejected = 0, processed = 0;

  try {
    const splitRows = await env.DB.prepare(`
      SELECT s.team_id,s.mlb_team_id,t.abbreviation AS team_abbr,s.pitcher_hand,s.window_days,
             s.plate_appearances,s.strikeouts,s.strikeout_rate,s.sync_run_id
      FROM team_strikeout_splits_daily s
      JOIN teams t ON t.team_id=s.team_id
      WHERE s.as_of_date=?
      ORDER BY s.team_id,s.pitcher_hand,s.window_days
    `).bind(sourceDate).all<TeamSplitFeatureRow>();

    const groups = new Map<string, TeamSplitFeatureRow[]>();
    for (const row of splitRows.results) {
      const key = `${row.team_id}:${row.pitcher_hand}`;
      const arr = groups.get(key) ?? [];
      arr.push(row);
      groups.set(key, arr);
    }

    for (const rows of groups.values()) {
      const first = rows[0];
      try {
        const byWindow = new Map(rows.map(r => [Number(r.window_days), r]));
        const seasonRow = byWindow.get(0);
        const d30 = byWindow.get(30);
        const d14 = byWindow.get(14);
        const d7 = byWindow.get(7);
        if (!seasonRow || !d30 || !d14 || !d7) {
          rejected++;
          await env.DB.prepare(`
            INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt)
            VALUES (?,'FEATURE_BUILD','TEAM_DAILY_FEATURE_ERROR',?,?,0,?)
          `).bind(syncRunId, `Missing required team split window(s) for ${first.team_abbr} vs ${first.pitcher_hand} on ${sourceDate}`, `${first.team_abbr}:${first.pitcher_hand}`, JSON.stringify(rows).slice(0,1000)).run();
          continue;
        }

        const weightedRecent = 0.50 * Number(d7.strikeout_rate) + 0.30 * Number(d14.strikeout_rate) + 0.20 * Number(d30.strikeout_rate);
        const recentVsSeason = weightedRecent - Number(seasonRow.strikeout_rate);
        const last7Vs30 = Number(d7.strikeout_rate) - Number(d30.strikeout_rate);
        const trendDirection = last7Vs30 >= 0.015 ? 'UP' : last7Vs30 <= -0.015 ? 'DOWN' : 'FLAT';

        const sampleSizeScore = teamFeatureClamp(
          Math.min(20, Number(seasonRow.plate_appearances) / 50) +
          Math.min(35, Number(d30.plate_appearances) / 12) +
          Math.min(25, Number(d14.plate_appearances) / 8) +
          Math.min(20, Number(d7.plate_appearances) / 4),
        );
        const stabilityStatus = Number(d30.plate_appearances) >= 300 && Number(d14.plate_appearances) >= 140 && Number(d7.plate_appearances) >= 60
          ? 'HIGH'
          : Number(d30.plate_appearances) >= 180 && Number(d14.plate_appearances) >= 80
            ? 'MEDIUM'
            : 'LOW';
        const flags: string[] = [];
        if (Number(seasonRow.plate_appearances) < 500) flags.push('LOW_SEASON_PA');
        if (Number(d30.plate_appearances) < 250) flags.push('LOW_30D_PA');
        if (Number(d14.plate_appearances) < 120) flags.push('LOW_14D_PA');
        if (Number(d7.plate_appearances) < 50) flags.push('LOW_7D_PA');
        if (Math.abs(last7Vs30) >= 0.04) flags.push('LARGE_RECENT_SWING');
        let quality = 100;
        if (flags.includes('LOW_SEASON_PA')) quality -= 10;
        if (flags.includes('LOW_30D_PA')) quality -= 20;
        if (flags.includes('LOW_14D_PA')) quality -= 15;
        if (flags.includes('LOW_7D_PA')) quality -= 10;
        if (stabilityStatus === 'LOW') quality -= 10;
        quality = teamFeatureClamp(quality);
        const sourceRunIds = Array.from(new Set(rows.map(r => Number(r.sync_run_id)).filter(Number.isFinite)));
        const season = Number(sourceDate.slice(0,4));

        const existing = await env.DB.prepare(`
          SELECT team_daily_feature_id,season_k_rate,last30_k_rate,last14_k_rate,last7_k_rate,weighted_recent_k_rate,data_quality_score
          FROM team_daily_features
          WHERE team_id=? AND as_of_date=? AND pitcher_hand=? AND feature_version='team-daily-v1'
        `).bind(first.team_id, safeDate, first.pitcher_hand).first<Record<string,unknown>>();

        await env.DB.prepare(`
          INSERT INTO team_daily_features (
            team_id,mlb_team_id,team_abbr,as_of_date,season,pitcher_hand,source_cutoff_date,
            season_plate_appearances,season_strikeouts,season_k_rate,
            last30_plate_appearances,last30_strikeouts,last30_k_rate,
            last14_plate_appearances,last14_strikeouts,last14_k_rate,
            last7_plate_appearances,last7_strikeouts,last7_k_rate,
            weighted_recent_k_rate,recent_vs_season_delta,last7_vs_last30_delta,trend_direction,stability_status,
            sample_size_score,data_quality_score,data_quality_flags_json,source_sync_run_ids_json,feature_version,sync_run_id,generated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'team-daily-v1',?,CURRENT_TIMESTAMP)
          ON CONFLICT(team_id,as_of_date,pitcher_hand,feature_version) DO UPDATE SET
            mlb_team_id=excluded.mlb_team_id,team_abbr=excluded.team_abbr,season=excluded.season,source_cutoff_date=excluded.source_cutoff_date,
            season_plate_appearances=excluded.season_plate_appearances,season_strikeouts=excluded.season_strikeouts,season_k_rate=excluded.season_k_rate,
            last30_plate_appearances=excluded.last30_plate_appearances,last30_strikeouts=excluded.last30_strikeouts,last30_k_rate=excluded.last30_k_rate,
            last14_plate_appearances=excluded.last14_plate_appearances,last14_strikeouts=excluded.last14_strikeouts,last14_k_rate=excluded.last14_k_rate,
            last7_plate_appearances=excluded.last7_plate_appearances,last7_strikeouts=excluded.last7_strikeouts,last7_k_rate=excluded.last7_k_rate,
            weighted_recent_k_rate=excluded.weighted_recent_k_rate,recent_vs_season_delta=excluded.recent_vs_season_delta,last7_vs_last30_delta=excluded.last7_vs_last30_delta,
            trend_direction=excluded.trend_direction,stability_status=excluded.stability_status,sample_size_score=excluded.sample_size_score,
            data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,
            source_sync_run_ids_json=excluded.source_sync_run_ids_json,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP
        `).bind(
          first.team_id,first.mlb_team_id,first.team_abbr,safeDate,season,first.pitcher_hand,sourceDate,
          seasonRow.plate_appearances,seasonRow.strikeouts,seasonRow.strikeout_rate,
          d30.plate_appearances,d30.strikeouts,d30.strikeout_rate,
          d14.plate_appearances,d14.strikeouts,d14.strikeout_rate,
          d7.plate_appearances,d7.strikeouts,d7.strikeout_rate,
          weightedRecent,recentVsSeason,last7Vs30,trendDirection,stabilityStatus,
          sampleSizeScore,quality,JSON.stringify(flags),JSON.stringify(sourceRunIds),syncRunId,
        ).run();

        if (!existing) inserted++;
        else {
          const changed =
            Number(existing.season_k_rate) !== Number(seasonRow.strikeout_rate) ||
            Number(existing.last30_k_rate) !== Number(d30.strikeout_rate) ||
            Number(existing.last14_k_rate) !== Number(d14.strikeout_rate) ||
            Number(existing.last7_k_rate) !== Number(d7.strikeout_rate) ||
            Number(existing.weighted_recent_k_rate) !== Number(weightedRecent) ||
            Number(existing.data_quality_score) !== quality;
          changed ? updated++ : unchanged++;
        }
        processed++;
      } catch (error) {
        rejected++;
        const message = error instanceof Error ? error.message : String(error);
        await env.DB.prepare(`
          INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt)
          VALUES (?,'FEATURE_BUILD','TEAM_DAILY_FEATURE_ERROR',?,?,0,?)
        `).bind(syncRunId,message,`${first.team_abbr}:${first.pitcher_hand}`,message.slice(0,1000)).run();
      }
    }

    const status: TeamDailyFeatureSyncStatus = rejected === 0 ? 'SUCCEEDED' : processed > 0 ? 'PARTIAL' : 'FAILED';
    await env.DB.prepare(`
      UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,
        freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?
    `).bind(status,groups.size,inserted,updated,unchanged,rejected,sourceDate,JSON.stringify({feature_date:safeDate,source_cutoff_date:sourceDate,groups_found:groups.size,groups_processed:processed}),syncRunId).run();

    const sourceStatus = status === 'SUCCEEDED' ? 'HEALTHY' : status === 'PARTIAL' ? 'INCOMPLETE' : 'FAILED';
    await env.DB.prepare(`
      INSERT INTO data_source_status (
        source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,
        expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at
      ) VALUES ('FEATURE_STORE','TEAM_DAILY_FEATURES',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,
        CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM team_daily_features),?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_name,dataset_name) DO UPDATE SET
        status=excluded.status,last_attempt_at=excluded.last_attempt_at,
        last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,
        last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,
        last_sync_run_id=excluded.last_sync_run_id,
        consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,
        record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP
    `).bind(sourceStatus,status,safeDate,syncRunId,status,
      `${processed}/${groups.size} team-hand feature rows processed from ${sourceDate}; ${inserted} inserted; ${updated} updated; ${rejected} rejected.`,
      JSON.stringify({source_cutoff_date:sourceDate,feature_version:'team-daily-v1',groups_processed:processed}),
    ).run();

    return {sync_run_id:syncRunId,status,as_of_date:safeDate,source_cutoff_date:sourceDate,team_hand_groups:groups.size,rows_processed:processed,rows_inserted:inserted,rows_updated:updated,rows_unchanged:unchanged,rejected};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();
    throw error;
  }
}

async function getTeamDailyFeatureStatus(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get('date') ? validateDate(String(url.searchParams.get('date'))) : chicagoDateString(Date.now());
  const source = await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='FEATURE_STORE' AND dataset_name='TEAM_DAILY_FEATURES'`).first<Record<string,unknown>>();
  const runs = await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) error_count FROM sync_runs sr WHERE sr.dataset_name='TEAM_DAILY_FEATURES' ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const rows = await env.DB.prepare(`SELECT * FROM team_daily_features WHERE as_of_date=(SELECT MAX(as_of_date) FROM team_daily_features WHERE as_of_date<=?) ORDER BY pitcher_hand,weighted_recent_k_rate DESC,team_abbr LIMIT 100`).bind(date).all<Record<string,unknown>>();
  return json({source_status:source,recent_runs:runs.results,features:rows.results});
}

async function runTeamDailyFeatureSync(request: Request, env: Env): Promise<Response> {
  const input = await parseJson<{as_of_date?:string}>(request);
  return json({ok:true,...await syncTeamDailyFeatures(env,input.as_of_date?validateDate(input.as_of_date):chicagoDateString(Date.now()),'ADMIN')});
}

async function autoSyncTeamDailyFeatures(env: Env, scheduledTime: number): Promise<void> {
  const local = chicagoDateParts(scheduledTime);
  if (local.minute !== 35) return;
  await syncTeamDailyFeatures(env,chicagoDateString(scheduledTime),'CRON');
}



interface LineupPlayerView {
  id: number;
  name: string;
  bat_side: 'L' | 'R' | 'S' | null;
  position: string | null;
  order_value: string | null;
}

function normalizeBatSide(value: unknown): 'L' | 'R' | 'S' | null {
  const side = String(value ?? '').trim().toUpperCase();
  return side === 'L' || side === 'R' || side === 'S' ? side : null;
}

function lineupPlayersFromFeed(payload: unknown, side: 'away' | 'home'): LineupPlayerView[] {
  const root = payload as any;
  const team = root?.liveData?.boxscore?.teams?.[side];
  if (!team) return [];
  const orderIds = (team.battingOrder ?? []).map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0);
  const players = (team.players ?? {}) as Record<string, any>;
  const fallback = Object.values(players)
    .map((player: any) => ({ player, order: Number(player.battingOrder ?? 0) }))
    .filter((row: any) => Number.isFinite(row.order) && row.order > 0)
    .sort((a: any,b: any) => a.order - b.order)
    .map((row: any) => Number(row.player.person?.id ?? 0))
    .filter((v: number) => v > 0);
  const ids = orderIds.length ? orderIds : fallback;
  return ids.slice(0, 9).map((id: number, index: number) => {
    const key = `ID${id}`;
    const box = players[key];
    const gd = root?.gameData?.players?.[key];
    return {
      id,
      name: String(box?.person?.fullName ?? gd?.fullName ?? `MLB ${id}`),
      bat_side: normalizeBatSide(gd?.batSide?.code),
      position: box?.position?.abbreviation ? String(box.position.abbreviation) : null,
      order_value: box?.battingOrder != null ? String(box.battingOrder) : String((index + 1) * 100),
    };
  });
}


function pitcherHandFromFeed(payload: unknown, pitcherId: number | null): 'L' | 'R' | null {
  if (!pitcherId) return null;
  const root = payload as any;
  const key = `ID${pitcherId}`;
  const raw = root?.gameData?.players?.[key]?.pitchHand?.code
    ?? root?.gameData?.players?.[key]?.pitchHand?.description
    ?? null;
  const hand = String(raw ?? '').trim().toUpperCase();
  if (hand === 'L' || hand.startsWith('LEFT')) return 'L';
  if (hand === 'R' || hand.startsWith('RIGHT')) return 'R';
  return null;
}

async function recordLineupSyncError(env: Env, syncRunId: number, stage: string, error: unknown, key: string | null = null): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(`
    INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt)
    VALUES (?,?,'MLB_LINEUP_SYNC_ERROR',?,?,1,?)
  `).bind(syncRunId, stage, message, key, message.slice(0,1000)).run();
}

async function syncMlbLineups(env: Env, date: string, triggerSource: 'CRON'|'ADMIN'|'API'|'MANUAL'='MANUAL'): Promise<Record<string, unknown>> {
  const safeDate = validateDate(date);
  const runInsert = await env.DB.prepare(`
    INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end,request_count)
    VALUES (?,'MLB_STATS_API','LINEUP_SNAPSHOTS','INCREMENTAL',?,'RUNNING',?,?,0)
  `).bind(crypto.randomUUID(), triggerSource, safeDate, safeDate).run();
  const syncRunId = Number(runInsert.meta.last_row_id);
  let gamesRead=0, gamesFetched=0, snapshotsInserted=0, entriesInserted=0, unchanged=0, rejected=0, confirmedTeams=0, unavailableTeams=0;
  try {
    const games = await env.DB.prepare(`
      SELECT g.mlb_game_pk,g.official_date,g.status_detailed,g.game_status,
             at.abbreviation away_abbr,ht.abbreviation home_abbr,
             g.away_probable_pitcher_mlb_id,g.away_probable_pitcher_hand,
             g.home_probable_pitcher_mlb_id,g.home_probable_pitcher_hand
      FROM games g
      LEFT JOIN teams at ON at.team_id=g.away_team_id
      LEFT JOIN teams ht ON ht.team_id=g.home_team_id
      WHERE COALESCE(g.official_date,g.game_date)=? AND g.mlb_game_pk IS NOT NULL
      ORDER BY g.scheduled_start,g.mlb_game_pk
    `).bind(safeDate).all<Record<string,unknown>>();
    gamesRead = games.results.length;
    for (const game of games.results) {
      const gamePk = Number(game.mlb_game_pk);
      try {
        const awayId = MLB_TEAM_IDS[normalizedMlbTeamAbbreviation(String(game.away_abbr ?? ''))] ?? 0;
        const homeId = MLB_TEAM_IDS[normalizedMlbTeamAbbreviation(String(game.home_abbr ?? ''))] ?? 0;
        if (!awayId || !homeId) throw new Error(`Missing MLB team mapping for game ${gamePk}.`);
        const payload = await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
        gamesFetched += 1;
        const homePitcherId = Number(game.home_probable_pitcher_mlb_id)||null;
        const awayPitcherId = Number(game.away_probable_pitcher_mlb_id)||null;
        const homePitcherHand = normalizeBatSide(game.home_probable_pitcher_hand) === 'L' || normalizeBatSide(game.home_probable_pitcher_hand) === 'R'
          ? normalizeBatSide(game.home_probable_pitcher_hand) as 'L'|'R'
          : pitcherHandFromFeed(payload, homePitcherId);
        const awayPitcherHand = normalizeBatSide(game.away_probable_pitcher_hand) === 'L' || normalizeBatSide(game.away_probable_pitcher_hand) === 'R'
          ? normalizeBatSide(game.away_probable_pitcher_hand) as 'L'|'R'
          : pitcherHandFromFeed(payload, awayPitcherId);
        const sides: Array<{side:'away'|'home'; teamId:number; oppId:number; pitcherId:number|null; pitcherHand:string|null}> = [
          {side:'away',teamId:awayId,oppId:homeId,pitcherId:homePitcherId,pitcherHand:homePitcherHand},
          {side:'home',teamId:homeId,oppId:awayId,pitcherId:awayPitcherId,pitcherHand:awayPitcherHand},
        ];
        for (const target of sides) {
          const lineup = lineupPlayersFromFeed(payload,target.side);
          const status = lineup.length >= 9 ? 'CONFIRMED' : 'UNAVAILABLE';
          if (status === 'CONFIRMED') confirmedTeams += 1; else unavailableTeams += 1;
          const canonical = JSON.stringify({gamePk,teamId:target.teamId,status,lineup:lineup.map(p=>[p.id,p.bat_side,p.position,p.order_value]),pitcherId:target.pitcherId,pitcherHand:target.pitcherHand});
          const hash = compactHash(canonical);
          const existing = await env.DB.prepare(`SELECT lineup_snapshot_id FROM game_lineup_snapshots WHERE mlb_game_pk=? AND batting_team_mlb_id=? AND payload_hash=? LIMIT 1`).bind(gamePk,target.teamId,hash).first<{lineup_snapshot_id:number}>();
          if (existing) { unchanged += 1; continue; }
          const snap = await env.DB.prepare(`
            INSERT INTO game_lineup_snapshots (mlb_game_pk,official_date,batting_team_mlb_id,opponent_team_mlb_id,opposing_probable_pitcher_mlb_id,opposing_probable_pitcher_hand,lineup_status,lineup_size,source_game_status,payload_hash,sync_run_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).bind(gamePk,safeDate,target.teamId,target.oppId,target.pitcherId,normalizeBatSide(target.pitcherHand)==='S'?null:normalizeBatSide(target.pitcherHand),status,lineup.length,String(game.status_detailed??game.game_status??''),hash,syncRunId).run();
          const snapshotId=Number(snap.meta.last_row_id); snapshotsInserted += 1;
          for (let i=0;i<lineup.length;i++) {
            const player=lineup[i];
            await env.DB.prepare(`
              INSERT INTO mlb_batters (mlb_batter_id,full_name,bat_side,last_seen_team_mlb_id,last_synced_at)
              VALUES (?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(mlb_batter_id) DO UPDATE SET full_name=excluded.full_name,bat_side=COALESCE(excluded.bat_side,mlb_batters.bat_side),last_seen_team_mlb_id=excluded.last_seen_team_mlb_id,last_synced_at=CURRENT_TIMESTAMP
            `).bind(player.id,player.name,player.bat_side,target.teamId).run();
            await env.DB.prepare(`
              INSERT INTO game_lineup_entries (lineup_snapshot_id,batting_slot,mlb_batter_id,player_name,bat_side,position_abbr,source_order_value)
              VALUES (?,?,?,?,?,?,?)
            `).bind(snapshotId,i+1,player.id,player.name,player.bat_side,player.position,player.order_value).run();
            entriesInserted += 1;
          }
        }
      } catch (error) {
        rejected += 1;
        await recordLineupSyncError(env,syncRunId,'GAME_LINEUP',error,String(gamePk));
      }
    }
    const status = rejected === 0 ? 'SUCCEEDED' : rejected < Math.max(1,gamesRead) ? 'PARTIAL' : 'FAILED';
    const health = status === 'SUCCEEDED' ? 'HEALTHY' : status === 'PARTIAL' ? 'INCOMPLETE' : 'FAILED';
    const details={games_read:gamesRead,games_fetched:gamesFetched,snapshots_inserted:snapshotsInserted,entries_inserted:entriesInserted,unchanged,confirmed_teams:confirmedTeams,unavailable_teams:unavailableTeams,rejected};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_unchanged=?,rows_rejected=?,request_count=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,gamesRead,snapshotsInserted,unchanged,rejected,gamesFetched,safeDate,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`
      INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at)
      VALUES ('MLB_STATS_API','LINEUP_SNAPSHOTS',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,15,45,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM game_lineup_snapshots),?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP
    `).bind(health,status,safeDate,syncRunId,status,`${gamesFetched}/${gamesRead} games fetched; ${confirmedTeams} confirmed team lineups; ${unavailableTeams} unavailable; ${rejected} rejected.`,JSON.stringify(details)).run();
    return {sync_run_id:syncRunId,status,date:safeDate,...details};
  } catch (error) {
    await recordLineupSyncError(env,syncRunId,'SYNC',error);
    await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),syncRunId).run();
    throw error;
  }
}

async function getLineupSyncStatus(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get('date') ? validateDate(String(url.searchParams.get('date'))) : chicagoDateString(Date.now());
  const source = await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='LINEUP_SNAPSHOTS'`).first<Record<string,unknown>>();
  const runs = await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) error_count FROM sync_runs sr WHERE sr.dataset_name='LINEUP_SNAPSHOTS' ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const snapshots = await env.DB.prepare(`
    SELECT ls.*, COALESCE(bt.abbreviation,CAST(ls.batting_team_mlb_id AS TEXT)) batting_team,
      COALESCE(ot.abbreviation,CAST(ls.opponent_team_mlb_id AS TEXT)) opponent_team
    FROM game_lineup_snapshots ls
    LEFT JOIN teams bt ON bt.abbreviation=CASE ls.batting_team_mlb_id ${Object.entries(MLB_TEAM_ABBREVIATIONS).map(([id,abbr])=>`WHEN ${id} THEN '${abbr}'`).join(' ')} END
    LEFT JOIN teams ot ON ot.abbreviation=CASE ls.opponent_team_mlb_id ${Object.entries(MLB_TEAM_ABBREVIATIONS).map(([id,abbr])=>`WHEN ${id} THEN '${abbr}'`).join(' ')} END
    WHERE ls.official_date=?
      AND ls.lineup_snapshot_id=(SELECT MAX(x.lineup_snapshot_id) FROM game_lineup_snapshots x WHERE x.mlb_game_pk=ls.mlb_game_pk AND x.batting_team_mlb_id=ls.batting_team_mlb_id)
    ORDER BY ls.mlb_game_pk,ls.batting_team_mlb_id
  `).bind(date).all<Record<string,unknown>>();
  const ids=snapshots.results.map(r=>Number(r.lineup_snapshot_id)).filter(Boolean);
  let entries:Record<string,unknown>[]=[];
  if(ids.length){
    const placeholders=ids.map(()=>'?').join(',');
    entries=(await env.DB.prepare(`SELECT * FROM game_lineup_entries WHERE lineup_snapshot_id IN (${placeholders}) ORDER BY lineup_snapshot_id,batting_slot`).bind(...ids).all<Record<string,unknown>>()).results;
  }
  return json({date,source_status:source,recent_runs:runs.results,snapshots:snapshots.results,entries});
}

async function runLineupSync(request: Request, env: Env): Promise<Response> {
  const input=await parseJson<{date?:string}>(request);
  return json({ok:true,...await syncMlbLineups(env,input.date?validateDate(input.date):chicagoDateString(Date.now()),'ADMIN')});
}


type MlbHittingStatSplit = {
  player?: { id?: number; fullName?: string };
  team?: { id?: number };
  stat?: { plateAppearances?: number | string; strikeOuts?: number | string };
};

function previousIsoDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function featureRound6(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 1_000_000) / 1_000_000;
}

async function syncBatterKProfiles(env: Env, asOfDate: string, triggerSource: 'ADMIN'|'CRON'|'API'|'MANUAL'='MANUAL'): Promise<Record<string, unknown>> {
  const safeDate = validateDate(asOfDate);
  const cutoff = previousIsoDate(safeDate);
  const season = Number(safeDate.slice(0,4));
  const startDate = `${season}-03-01`;
  const run = await env.DB.prepare(`
    INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end)
    VALUES (?,'MLB_STATS_API','BATTER_K_PROFILES','FULL',?,'RUNNING',?,?)
  `).bind(crypto.randomUUID(),triggerSource,startDate,cutoff).run();
  const syncRunId=Number(run.meta.last_row_id);
  let inserted=0,updated=0,unchanged=0,rejected=0;
  try {
    const u=new URL('https://statsapi.mlb.com/api/v1/stats');
    u.searchParams.set('stats','byDateRange');
    u.searchParams.set('group','hitting');
    u.searchParams.set('startDate',startDate);
    u.searchParams.set('endDate',cutoff);
    u.searchParams.set('sportIds','1');
    u.searchParams.set('gameType','R');
    u.searchParams.set('limit','2000');
    u.searchParams.set('hydrate','person');
    const payload=await fetchMlbJson(u.toString());
    const stats=Array.isArray(payload.stats)?payload.stats as Array<Record<string,unknown>>:[];
    const splits=(stats[0] && Array.isArray(stats[0].splits)?stats[0].splits:[]) as MlbHittingStatSplit[];
    const valid=splits.map(sp=>({
      id:Number(sp.player?.id), name:String(sp.player?.fullName??''), pa:Number(sp.stat?.plateAppearances??0), so:Number(sp.stat?.strikeOuts??0), teamId:Number(sp.team?.id)||null,
    })).filter(x=>Number.isInteger(x.id)&&x.id>0&&x.name&&x.pa>=0&&x.so>=0);
    const leaguePa=valid.reduce((a,x)=>a+x.pa,0), leagueSo=valid.reduce((a,x)=>a+x.so,0);
    const leagueRate=leaguePa>0?leagueSo/leaguePa:0.225;
    const known=(await env.DB.prepare(`SELECT mlb_batter_id FROM mlb_batters`).all<{mlb_batter_id:number}>()).results;
    const wanted=new Set(known.map(x=>Number(x.mlb_batter_id)));
    const rows=valid.filter(x=>wanted.has(x.id));
    for(const x of rows){
      try{
        const raw=x.pa>0?x.so/x.pa:null;
        const priorPa=80;
        const shrunk=(x.so+leagueRate*priorPa)/(x.pa+priorPa);
        const sampleWeight=x.pa/(x.pa+priorPa);
        const flags:string[]=[];
        if(x.pa<25)flags.push('VERY_LOW_PA'); else if(x.pa<75)flags.push('LOW_PA');
        let quality=Math.min(100,Math.round(40+Math.min(60,x.pa/4)));
        if(x.pa<25)quality=Math.min(quality,55); else if(x.pa<75)quality=Math.min(quality,75);
        const existing=await env.DB.prepare(`SELECT plate_appearances,strikeouts,shrunk_k_rate FROM batter_k_profiles_daily WHERE mlb_batter_id=? AND as_of_date=? AND profile_version='batter-k-v1'`).bind(x.id,safeDate).first<Record<string,unknown>>();
        await env.DB.prepare(`
          INSERT INTO batter_k_profiles_daily (mlb_batter_id,player_name,as_of_date,source_cutoff_date,season,plate_appearances,strikeouts,raw_k_rate,shrunk_k_rate,league_k_rate,sample_weight,data_quality_score,data_quality_flags_json,profile_version,sync_run_id,generated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'batter-k-v1',?,CURRENT_TIMESTAMP)
          ON CONFLICT(mlb_batter_id,as_of_date,profile_version) DO UPDATE SET player_name=excluded.player_name,source_cutoff_date=excluded.source_cutoff_date,season=excluded.season,plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,raw_k_rate=excluded.raw_k_rate,shrunk_k_rate=excluded.shrunk_k_rate,league_k_rate=excluded.league_k_rate,sample_weight=excluded.sample_weight,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP
        `).bind(x.id,x.name,safeDate,cutoff,season,x.pa,x.so,featureRound6(raw),featureRound6(shrunk),featureRound6(leagueRate),featureRound6(sampleWeight),quality,JSON.stringify(flags),syncRunId).run();
        if(!existing)inserted++; else if(Number(existing.plate_appearances)!==x.pa||Number(existing.strikeouts)!==x.so||Number(existing.shrunk_k_rate)!==Number(featureRound6(shrunk)))updated++; else unchanged++;
      }catch(error){rejected++;await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'BATTER_PROFILE','BATTER_K_PROFILE_ERROR',?,?,0,?)`).bind(syncRunId,error instanceof Error?error.message:String(error),String(x.id),JSON.stringify(x).slice(0,1000)).run();}
    }
    const status=rejected===0?'SUCCEEDED':rejected<Math.max(1,rows.length)?'PARTIAL':'FAILED';
    const health=status==='SUCCEEDED'?'HEALTHY':status==='PARTIAL'?'INCOMPLETE':'FAILED';
    const details={as_of_date:safeDate,source_cutoff_date:cutoff,api_rows:valid.length,known_batters:wanted.size,matched_batters:rows.length,inserted,updated,unchanged,rejected,league_k_rate:featureRound6(leagueRate)};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,request_count=1,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,rows.length,inserted,updated,unchanged,rejected,cutoff,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES ('FEATURE_STORE','BATTER_K_PROFILES',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM batter_k_profiles_daily),?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(health,status,safeDate,syncRunId,status,`${rows.length}/${wanted.size} known lineup batters profiled through ${cutoff}.`,JSON.stringify(details)).run();
    return {sync_run_id:syncRunId,status,...details};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,retryable,payload_excerpt) VALUES (?,'SYNC','BATTER_K_PROFILE_SYNC_ERROR',?,1,?)`).bind(syncRunId,message,message.slice(0,1000)).run();
    await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();
    throw error;
  }
}

const LINEUP_SLOT_WEIGHTS=[1.08,1.06,1.04,1.02,1.00,0.98,0.96,0.94,0.92];

async function syncLineupKFeatures(env: Env, asOfDate: string, triggerSource: 'ADMIN'|'CRON'|'API'|'MANUAL'='MANUAL'): Promise<Record<string,unknown>> {
  const safeDate=validateDate(asOfDate);
  const batterResult=await syncBatterKProfiles(env,safeDate,triggerSource);
  const run=await env.DB.prepare(`INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_end) VALUES (?,'FEATURE_STORE','LINEUP_K_FEATURES','INCREMENTAL',?,'RUNNING',?)`).bind(crypto.randomUUID(),triggerSource,safeDate).run();
  const syncRunId=Number(run.meta.last_row_id);
  let inserted=0,updated=0,unchanged=0,rejected=0;
  try{
    const snaps=(await env.DB.prepare(`SELECT ls.* FROM game_lineup_snapshots ls WHERE ls.official_date=? AND ls.lineup_status='CONFIRMED' AND ls.lineup_snapshot_id=(SELECT MAX(x.lineup_snapshot_id) FROM game_lineup_snapshots x WHERE x.mlb_game_pk=ls.mlb_game_pk AND x.batting_team_mlb_id=ls.batting_team_mlb_id AND x.lineup_status='CONFIRMED') ORDER BY ls.mlb_game_pk,ls.batting_team_mlb_id`).bind(safeDate).all<Record<string,unknown>>()).results;
    for(const snap of snaps){
      const sid=Number(snap.lineup_snapshot_id);
      try{
        const rows=(await env.DB.prepare(`SELECT e.batting_slot,e.mlb_batter_id,e.player_name,p.plate_appearances,p.shrunk_k_rate,p.league_k_rate FROM game_lineup_entries e LEFT JOIN batter_k_profiles_daily p ON p.mlb_batter_id=e.mlb_batter_id AND p.as_of_date=? AND p.profile_version='batter-k-v1' WHERE e.lineup_snapshot_id=? ORDER BY e.batting_slot`).bind(safeDate,sid).all<Record<string,unknown>>()).results;
        const profiled=rows.filter(r=>r.shrunk_k_rate!==null&&r.shrunk_k_rate!==undefined);
        const league=profiled.length?profiled.reduce((a,r)=>a+Number(r.league_k_rate??0),0)/profiled.length:Number(batterResult.league_k_rate??0.225);
        const values=rows.map(r=>Number(r.shrunk_k_rate??league));
        const unweighted=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
        let wsum=0,vr=0; rows.forEach((r,i)=>{const w=LINEUP_SLOT_WEIGHTS[Math.max(0,Math.min(8,Number(r.batting_slot??i+1)-1))];vr+=Number(r.shrunk_k_rate??league)*w;wsum+=w;});
        const weighted=wsum?vr/wsum:null;
        const coverage=rows.length?profiled.length/rows.length:0;
        const totalPa=profiled.reduce((a,r)=>a+Number(r.plate_appearances??0),0);
        const teamRef=await env.DB.prepare(`SELECT weighted_recent_k_rate FROM team_daily_features WHERE mlb_team_id=? AND as_of_date=? AND pitcher_hand=? ORDER BY team_daily_feature_id DESC LIMIT 1`).bind(Number(snap.batting_team_mlb_id),safeDate,String(snap.opposing_probable_pitcher_hand??'R')).first<{weighted_recent_k_rate:number}>();
        const ref=teamRef?.weighted_recent_k_rate===undefined?null:Number(teamRef.weighted_recent_k_rate);
        const delta=weighted!==null&&ref!==null?weighted-ref:null;
        const flags:string[]=[];
        if(rows.length<9)flags.push('INCOMPLETE_LINEUP');
        if(coverage<1)flags.push('PARTIAL_PROFILE_COVERAGE');
        if(coverage<0.78)flags.push('LOW_PROFILE_COVERAGE');
        if(totalPa<500)flags.push('LOW_COMBINED_PA');
        if(ref===null)flags.push('NO_TEAM_REFERENCE');
        let quality=100;
        if(rows.length<9)quality-=25;
        quality-=Math.round((1-coverage)*35);
        if(totalPa<500)quality-=15; else if(totalPa<1000)quality-=5;
        if(ref===null)quality-=10;
        quality=Math.max(0,Math.min(100,quality));
        const existing=await env.DB.prepare(`SELECT slot_weighted_lineup_k_rate,profile_coverage,data_quality_score FROM lineup_k_features_daily WHERE lineup_snapshot_id=? AND feature_version='lineup-k-v1'`).bind(sid).first<Record<string,unknown>>();
        await env.DB.prepare(`INSERT INTO lineup_k_features_daily (lineup_snapshot_id,mlb_game_pk,official_date,batting_team_mlb_id,opponent_team_mlb_id,opposing_probable_pitcher_mlb_id,opposing_probable_pitcher_hand,lineup_size,profiled_batters,profile_coverage,total_profile_pa,unweighted_lineup_k_rate,slot_weighted_lineup_k_rate,team_k_rate_reference,lineup_vs_team_delta,league_k_rate,data_quality_score,data_quality_flags_json,feature_version,sync_run_id,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'lineup-k-v1',?,CURRENT_TIMESTAMP) ON CONFLICT(lineup_snapshot_id,feature_version) DO UPDATE SET profiled_batters=excluded.profiled_batters,profile_coverage=excluded.profile_coverage,total_profile_pa=excluded.total_profile_pa,unweighted_lineup_k_rate=excluded.unweighted_lineup_k_rate,slot_weighted_lineup_k_rate=excluded.slot_weighted_lineup_k_rate,team_k_rate_reference=excluded.team_k_rate_reference,lineup_vs_team_delta=excluded.lineup_vs_team_delta,league_k_rate=excluded.league_k_rate,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP`).bind(sid,Number(snap.mlb_game_pk),safeDate,Number(snap.batting_team_mlb_id),Number(snap.opponent_team_mlb_id),Number(snap.opposing_probable_pitcher_mlb_id)||null,String(snap.opposing_probable_pitcher_hand??'')||null,rows.length,profiled.length,featureRound6(coverage),totalPa,featureRound6(unweighted),featureRound6(weighted),featureRound6(ref),featureRound6(delta),featureRound6(league),quality,JSON.stringify(flags),syncRunId).run();
        if(!existing)inserted++; else if(Number(existing.slot_weighted_lineup_k_rate)!==Number(featureRound6(weighted))||Number(existing.profile_coverage)!==Number(featureRound6(coverage))||Number(existing.data_quality_score)!==quality)updated++; else unchanged++;
      }catch(error){rejected++;await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'LINEUP_FEATURE','LINEUP_K_FEATURE_ERROR',?,?,0,?)`).bind(syncRunId,error instanceof Error?error.message:String(error),String(sid),JSON.stringify(snap).slice(0,1000)).run();}
    }
    const status=rejected===0?'SUCCEEDED':rejected<Math.max(1,snaps.length)?'PARTIAL':'FAILED';
    const health=status==='SUCCEEDED'?'HEALTHY':status==='PARTIAL'?'INCOMPLETE':'FAILED';
    const details={date:safeDate,lineups_seen:snaps.length,inserted,updated,unchanged,rejected,batter_profile_run_id:batterResult.sync_run_id};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,snaps.length,inserted,updated,unchanged,rejected,safeDate,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES ('FEATURE_STORE','LINEUP_K_FEATURES',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,15,60,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM lineup_k_features_daily),?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(health,status,safeDate,syncRunId,status,`${snaps.length-rejected}/${snaps.length} confirmed lineups profiled.`,JSON.stringify(details)).run();
    return {sync_run_id:syncRunId,status,...details,batter_profiles:batterResult};
  }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();throw error;}
}


type BatterHandProfileInput = { id:number; name:string; pa:number; so:number; teamId:number|null };

async function fetchLeagueBatterHandSplits(asOfDate: string, pitcherHand: 'L'|'R'): Promise<{rows:BatterHandProfileInput[]; leagueRate:number; requests:number}> {
  const safeDate=validateDate(asOfDate);
  const cutoff=previousIsoDate(safeDate);
  const season=Number(safeDate.slice(0,4));
  const startDate=`${season}-03-01`;
  const byPlayer=new Map<number,BatterHandProfileInput>();
  const pageSize=250; let offset=0; let requests=0;
  for(let page=0;page<8;page++){
    const u=new URL('https://statsapi.mlb.com/api/v1/stats');
    u.searchParams.set('stats','statSplits');
    u.searchParams.set('group','hitting');
    u.searchParams.set('startDate',startDate);
    u.searchParams.set('endDate',cutoff);
    u.searchParams.set('season',String(season));
    u.searchParams.set('sportIds','1');
    u.searchParams.set('gameType','R');
    u.searchParams.set('sitCodes',pitcherHand==='R'?'vr':'vl');
    u.searchParams.set('limit',String(pageSize));
    u.searchParams.set('offset',String(offset));
    const payload=await fetchMlbJson(u.toString()); requests++;
    const blocks=Array.isArray(payload.stats)?payload.stats as Array<Record<string,unknown>>:[];
    const splits=blocks.flatMap(b=>Array.isArray(b.splits)?b.splits as any[]:[]);
    for(const sp of splits){
      const id=Number(sp?.player?.id); const name=String(sp?.player?.fullName??'');
      const pa=Number(sp?.stat?.plateAppearances??0); const so=Number(sp?.stat?.strikeOuts??0);
      if(!Number.isInteger(id)||id<=0||!name||pa<0||so<0) continue;
      const prior=byPlayer.get(id)??{id,name,pa:0,so:0,teamId:Number(sp?.team?.id)||null};
      prior.pa+=pa; prior.so+=so; if(!prior.teamId)prior.teamId=Number(sp?.team?.id)||null; byPlayer.set(id,prior);
    }
    if(splits.length<pageSize) break;
    offset+=pageSize;
  }
  const rows=[...byPlayer.values()];
  const leaguePa=rows.reduce((a,x)=>a+x.pa,0), leagueSo=rows.reduce((a,x)=>a+x.so,0);
  return {rows,leagueRate:leaguePa>0?leagueSo/leaguePa:0.225,requests};
}

async function syncBatterKHandProfiles(env: Env, asOfDate: string, triggerSource: 'ADMIN'|'CRON'|'API'|'MANUAL'='MANUAL', onlyHand?: 'L'|'R'): Promise<Record<string,unknown>> {
  const safeDate=validateDate(asOfDate), cutoff=previousIsoDate(safeDate), season=Number(safeDate.slice(0,4));
  await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=COALESCE(details_json,'{\"error\":\"stale RUNNING hand-profile run recovered by Build 6.2.2\"}') WHERE dataset_name='BATTER_K_HAND_PROFILES' AND status='RUNNING' AND started_at < datetime('now','-5 minutes')`).run();
  const run=await env.DB.prepare(`INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end) VALUES (?,'MLB_STATS_API','BATTER_K_HAND_PROFILES','FULL',?,'RUNNING',?,?)`).bind(crypto.randomUUID(),triggerSource,`${season}-03-01`,cutoff).run();
  const syncRunId=Number(run.meta.last_row_id); let inserted=0,updated=0,unchanged=0,rejected=0,requests=0;
  try{
    const known=(await env.DB.prepare(`SELECT mlb_batter_id FROM mlb_batters`).all<{mlb_batter_id:number}>()).results;
    const wanted=new Set(known.map(x=>Number(x.mlb_batter_id)));
    const leagueRates:Record<string,number>={};
    const hands = onlyHand ? [onlyHand] as const : ['L','R'] as const;
    for(const hand of hands){
      const fetched=await fetchLeagueBatterHandSplits(safeDate,hand); requests+=fetched.requests; leagueRates[hand]=fetched.leagueRate;
      for(const x of fetched.rows.filter(x=>wanted.has(x.id))){
        try{
          const priorPa=60, raw=x.pa>0?x.so/x.pa:null, shrunk=(x.so+fetched.leagueRate*priorPa)/(x.pa+priorPa), sampleWeight=x.pa/(x.pa+priorPa);
          const flags:string[]=[]; if(x.pa<20)flags.push('VERY_LOW_HAND_PA'); else if(x.pa<60)flags.push('LOW_HAND_PA');
          let quality=Math.min(100,Math.round(35+Math.min(65,x.pa/3))); if(x.pa<20)quality=Math.min(quality,50); else if(x.pa<60)quality=Math.min(quality,72);
          const existing=await env.DB.prepare(`SELECT plate_appearances,strikeouts,shrunk_k_rate FROM batter_k_profiles_hand_daily WHERE mlb_batter_id=? AND as_of_date=? AND pitcher_hand=? AND profile_version='batter-k-hand-v1'`).bind(x.id,safeDate,hand).first<Record<string,unknown>>();
          await env.DB.prepare(`INSERT INTO batter_k_profiles_hand_daily (mlb_batter_id,player_name,as_of_date,source_cutoff_date,season,pitcher_hand,plate_appearances,strikeouts,raw_k_rate,shrunk_k_rate,league_k_rate,sample_weight,data_quality_score,data_quality_flags_json,profile_version,sync_run_id,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'batter-k-hand-v1',?,CURRENT_TIMESTAMP) ON CONFLICT(mlb_batter_id,as_of_date,pitcher_hand,profile_version) DO UPDATE SET player_name=excluded.player_name,source_cutoff_date=excluded.source_cutoff_date,season=excluded.season,plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,raw_k_rate=excluded.raw_k_rate,shrunk_k_rate=excluded.shrunk_k_rate,league_k_rate=excluded.league_k_rate,sample_weight=excluded.sample_weight,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP`).bind(x.id,x.name,safeDate,cutoff,season,hand,x.pa,x.so,featureRound6(raw),featureRound6(shrunk),featureRound6(fetched.leagueRate),featureRound6(sampleWeight),quality,JSON.stringify(flags),syncRunId).run();
          if(!existing)inserted++; else if(Number(existing.plate_appearances)!==x.pa||Number(existing.strikeouts)!==x.so||Number(existing.shrunk_k_rate)!==Number(featureRound6(shrunk)))updated++; else unchanged++;
        }catch(error){rejected++;await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'BATTER_HAND_PROFILE','BATTER_K_HAND_PROFILE_ERROR',?,?,0,?)`).bind(syncRunId,error instanceof Error?error.message:String(error),`${x.id}:${hand}`,JSON.stringify(x).slice(0,1000)).run();}
      }
    }
    const status=rejected===0?'SUCCEEDED':'PARTIAL',health=status==='SUCCEEDED'?'HEALTHY':'INCOMPLETE';
    const details={as_of_date:safeDate,source_cutoff_date:cutoff,hand:onlyHand??'BOTH',known_batters:wanted.size,inserted,updated,unchanged,rejected,requests,league_k_rate_vs_l:leagueRates.L===undefined?null:featureRound6(leagueRates.L),league_k_rate_vs_r:leagueRates.R===undefined?null:featureRound6(leagueRates.R)};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,request_count=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,inserted+updated+unchanged,inserted,updated,unchanged,rejected,requests,cutoff,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES ('FEATURE_STORE','BATTER_K_HAND_PROFILES',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM batter_k_profiles_hand_daily),?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(health,status,safeDate,syncRunId,status,`${inserted+updated+unchanged} handedness profiles through ${cutoff}.`,JSON.stringify(details)).run();
    return {sync_run_id:syncRunId,status,...details};
  }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();throw error;}
}

async function syncLineupKFeaturesV2(env: Env, asOfDate: string, triggerSource: 'ADMIN'|'CRON'|'API'|'MANUAL'='MANUAL'): Promise<Record<string,unknown>> {
  const safeDate=validateDate(asOfDate);
  const lineupCount=Number((await env.DB.prepare(`SELECT COUNT(*) c FROM game_lineup_snapshots WHERE official_date=? AND lineup_status='CONFIRMED'`).bind(safeDate).first<{c:number}>())?.c??0);
  const lineupResult:Record<string,unknown>=lineupCount>0?{status:'REUSED',confirmed_teams:lineupCount}:await syncMlbLineups(env,safeDate,triggerSource);
  const genericCount=Number((await env.DB.prepare(`SELECT COUNT(*) c FROM batter_k_profiles_daily WHERE as_of_date=? AND profile_version='batter-k-v1'`).bind(safeDate).first<{c:number}>())?.c??0);
  const genericResult:Record<string,unknown>=genericCount>0?{status:'REUSED',league_k_rate:(await env.DB.prepare(`SELECT AVG(league_k_rate) v FROM batter_k_profiles_daily WHERE as_of_date=? AND profile_version='batter-k-v1'`).bind(safeDate).first<{v:number}>())?.v??0.225}:await syncBatterKProfiles(env,safeDate,triggerSource);
  const handCounts=(await env.DB.prepare(`SELECT pitcher_hand,COUNT(*) c,AVG(league_k_rate) league_rate FROM batter_k_profiles_hand_daily WHERE as_of_date=? AND profile_version='batter-k-hand-v1' GROUP BY pitcher_hand`).bind(safeDate).all<{pitcher_hand:string;c:number;league_rate:number}>()).results;
  const handMap=new Map(handCounts.map(x=>[String(x.pitcher_hand),x]));
  if(!handMap.get('L')?.c) await syncBatterKHandProfiles(env,safeDate,triggerSource,'L');
  if(!handMap.get('R')?.c) await syncBatterKHandProfiles(env,safeDate,triggerSource,'R');
  const refreshedHandCounts=(await env.DB.prepare(`SELECT pitcher_hand,COUNT(*) c,AVG(league_k_rate) league_rate FROM batter_k_profiles_hand_daily WHERE as_of_date=? AND profile_version='batter-k-hand-v1' GROUP BY pitcher_hand`).bind(safeDate).all<{pitcher_hand:string;c:number;league_rate:number}>()).results;
  const refreshedMap=new Map(refreshedHandCounts.map(x=>[String(x.pitcher_hand),x]));
  const handResult:Record<string,unknown>={status:'REUSED_OR_SYNCED',league_k_rate_vs_l:refreshedMap.get('L')?.league_rate??null,league_k_rate_vs_r:refreshedMap.get('R')?.league_rate??null};
  const run=await env.DB.prepare(`INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_end) VALUES (?,'FEATURE_STORE','LINEUP_K_FEATURES_V2','INCREMENTAL',?,'RUNNING',?)`).bind(crypto.randomUUID(),triggerSource,safeDate).run();
  const syncRunId=Number(run.meta.last_row_id); let inserted=0,updated=0,unchanged=0,rejected=0;
  try{
    const snaps=(await env.DB.prepare(`SELECT ls.* FROM game_lineup_snapshots ls WHERE ls.official_date=? AND ls.lineup_status='CONFIRMED' AND ls.lineup_snapshot_id=(SELECT MAX(x.lineup_snapshot_id) FROM game_lineup_snapshots x WHERE x.mlb_game_pk=ls.mlb_game_pk AND x.batting_team_mlb_id=ls.batting_team_mlb_id AND x.lineup_status='CONFIRMED') ORDER BY ls.mlb_game_pk,ls.batting_team_mlb_id`).bind(safeDate).all<Record<string,unknown>>()).results;
    for(const snap of snaps){const sid=Number(snap.lineup_snapshot_id);try{
      const hand=String(snap.opposing_probable_pitcher_hand??'').toUpperCase();
      const rows=(await env.DB.prepare(`SELECT e.batting_slot,e.mlb_batter_id,e.player_name,g.plate_appearances generic_pa,g.shrunk_k_rate generic_k,g.league_k_rate generic_league,h.plate_appearances hand_pa,h.shrunk_k_rate hand_k,h.league_k_rate hand_league FROM game_lineup_entries e LEFT JOIN batter_k_profiles_daily g ON g.mlb_batter_id=e.mlb_batter_id AND g.as_of_date=? AND g.profile_version='batter-k-v1' LEFT JOIN batter_k_profiles_hand_daily h ON h.mlb_batter_id=e.mlb_batter_id AND h.as_of_date=? AND h.pitcher_hand=? AND h.profile_version='batter-k-hand-v1' WHERE e.lineup_snapshot_id=? ORDER BY e.batting_slot`).bind(safeDate,safeDate,hand,sid).all<Record<string,unknown>>()).results;
      const handProfiled=hand==='L'||hand==='R'?rows.filter(r=>r.hand_k!==null&&r.hand_k!==undefined):[];
      const genericProfiled=rows.filter(r=>r.generic_k!==null&&r.generic_k!==undefined);
      const leagueHand=handProfiled.length?handProfiled.reduce((a,r)=>a+Number(r.hand_league??0),0)/handProfiled.length:Number(hand==='L'?handResult.league_k_rate_vs_l:handResult.league_k_rate_vs_r)||Number(genericResult.league_k_rate??0.225);
      let genericFallback=0,leagueFallback=0; const values=rows.map(r=>{if(r.hand_k!==null&&r.hand_k!==undefined)return Number(r.hand_k);if(r.generic_k!==null&&r.generic_k!==undefined){genericFallback++;return Number(r.generic_k)}leagueFallback++;return leagueHand;});
      const unweighted=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;let wsum=0,vr=0;rows.forEach((r,i)=>{const w=LINEUP_SLOT_WEIGHTS[Math.max(0,Math.min(8,Number(r.batting_slot??i+1)-1))];vr+=values[i]*w;wsum+=w});const weighted=wsum?vr/wsum:null;
      const genericCoverage=rows.length?genericProfiled.length/rows.length:0, handCoverage=rows.length?handProfiled.length/rows.length:0;
      const genericPa=genericProfiled.reduce((a,r)=>a+Number(r.generic_pa??0),0),handPa=handProfiled.reduce((a,r)=>a+Number(r.hand_pa??0),0);
      const teamRef=hand==='L'||hand==='R'?await env.DB.prepare(`SELECT weighted_recent_k_rate FROM team_daily_features WHERE mlb_team_id=? AND as_of_date=? AND pitcher_hand=? ORDER BY team_daily_feature_id DESC LIMIT 1`).bind(Number(snap.batting_team_mlb_id),safeDate,hand).first<{weighted_recent_k_rate:number}>():null;
      const ref=teamRef?.weighted_recent_k_rate===undefined?null:Number(teamRef.weighted_recent_k_rate),delta=weighted!==null&&ref!==null?weighted-ref:null;
      const flags:string[]=[];if(hand!=='L'&&hand!=='R')flags.push('MISSING_PITCHER_HAND');if(handCoverage<1)flags.push('PARTIAL_HAND_PROFILE_COVERAGE');if(genericFallback)flags.push('GENERIC_PROFILE_FALLBACK');if(leagueFallback)flags.push('LEAGUE_RATE_FALLBACK');if(ref===null)flags.push('NO_TEAM_HAND_REFERENCE');
      let quality=100;if(hand!=='L'&&hand!=='R')quality-=30;quality-=genericFallback*3;quality-=leagueFallback*7;if(handPa<500)quality-=10;if(ref===null)quality-=8;quality=Math.max(0,Math.min(100,quality));
      const existing=await env.DB.prepare(`SELECT slot_weighted_lineup_k_rate,handedness_profile_coverage,data_quality_score FROM lineup_k_features_daily WHERE lineup_snapshot_id=? AND feature_version='lineup-k-v2'`).bind(sid).first<Record<string,unknown>>();
      await env.DB.prepare(`INSERT INTO lineup_k_features_daily (lineup_snapshot_id,mlb_game_pk,official_date,batting_team_mlb_id,opponent_team_mlb_id,opposing_probable_pitcher_mlb_id,opposing_probable_pitcher_hand,lineup_size,profiled_batters,profile_coverage,total_profile_pa,unweighted_lineup_k_rate,slot_weighted_lineup_k_rate,team_k_rate_reference,lineup_vs_team_delta,league_k_rate,data_quality_score,data_quality_flags_json,feature_version,sync_run_id,generated_at,handedness_profiled_batters,handedness_profile_coverage,generic_fallback_batters,league_fallback_batters,handedness_total_pa,generic_total_pa,profile_method_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'lineup-k-v2',?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?) ON CONFLICT(lineup_snapshot_id,feature_version) DO UPDATE SET opposing_probable_pitcher_hand=excluded.opposing_probable_pitcher_hand,profiled_batters=excluded.profiled_batters,profile_coverage=excluded.profile_coverage,total_profile_pa=excluded.total_profile_pa,unweighted_lineup_k_rate=excluded.unweighted_lineup_k_rate,slot_weighted_lineup_k_rate=excluded.slot_weighted_lineup_k_rate,team_k_rate_reference=excluded.team_k_rate_reference,lineup_vs_team_delta=excluded.lineup_vs_team_delta,league_k_rate=excluded.league_k_rate,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP,handedness_profiled_batters=excluded.handedness_profiled_batters,handedness_profile_coverage=excluded.handedness_profile_coverage,generic_fallback_batters=excluded.generic_fallback_batters,league_fallback_batters=excluded.league_fallback_batters,handedness_total_pa=excluded.handedness_total_pa,generic_total_pa=excluded.generic_total_pa,profile_method_json=excluded.profile_method_json`).bind(sid,Number(snap.mlb_game_pk),safeDate,Number(snap.batting_team_mlb_id),Number(snap.opponent_team_mlb_id),Number(snap.opposing_probable_pitcher_mlb_id)||null,hand==='L'||hand==='R'?hand:null,rows.length,genericProfiled.length,featureRound6(genericCoverage),genericPa,featureRound6(unweighted),featureRound6(weighted),featureRound6(ref),featureRound6(delta),featureRound6(leagueHand),quality,JSON.stringify(flags),syncRunId,handProfiled.length,featureRound6(handCoverage),genericFallback,leagueFallback,handPa,genericPa,JSON.stringify({handedness:handProfiled.length,generic_fallback:genericFallback,league_fallback:leagueFallback})).run();
      if(!existing)inserted++;else if(Number(existing.slot_weighted_lineup_k_rate)!==Number(featureRound6(weighted))||Number(existing.handedness_profile_coverage)!==Number(featureRound6(handCoverage))||Number(existing.data_quality_score)!==quality)updated++;else unchanged++;
    }catch(error){rejected++;await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'LINEUP_FEATURE_V2','LINEUP_K_FEATURE_V2_ERROR',?,?,0,?)`).bind(syncRunId,error instanceof Error?error.message:String(error),String(sid),JSON.stringify(snap).slice(0,1000)).run();}}
    const status=rejected===0?'SUCCEEDED':rejected<Math.max(1,snaps.length)?'PARTIAL':'FAILED',health=status==='SUCCEEDED'?'HEALTHY':status==='PARTIAL'?'INCOMPLETE':'FAILED';const details={date:safeDate,lineups_seen:snaps.length,inserted,updated,unchanged,rejected,lineup_sync_run_id:lineupResult.sync_run_id,generic_profile_run_id:genericResult.sync_run_id,hand_profile_run_id:handResult.sync_run_id};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,snaps.length,inserted,updated,unchanged,rejected,safeDate,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES ('FEATURE_STORE','LINEUP_K_FEATURES_V2',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,15,60,CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM lineup_k_features_daily WHERE feature_version='lineup-k-v2'),?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(health,status,safeDate,syncRunId,status,`${snaps.length-rejected}/${snaps.length} lineups built with handedness-aware profiles.`,JSON.stringify(details)).run();return {sync_run_id:syncRunId,status,...details,hand_profiles:handResult};
  }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=rows_rejected+1,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();throw error;}
}

async function getLineupKFeatureStatus(env: Env, url: URL): Promise<Response>{
  const date=url.searchParams.get('date')?validateDate(String(url.searchParams.get('date'))):chicagoDateString(Date.now());
  const source=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='FEATURE_STORE' AND dataset_name='LINEUP_K_FEATURES_V2'`).first<Record<string,unknown>>();
  const batterSource=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='FEATURE_STORE' AND dataset_name='BATTER_K_HAND_PROFILES'`).first<Record<string,unknown>>();
  const rows=(await env.DB.prepare(`SELECT f.*, CASE f.batting_team_mlb_id ${Object.entries(MLB_TEAM_ABBREVIATIONS).map(([id,abbr])=>`WHEN ${id} THEN '${abbr}'`).join(' ')} ELSE CAST(f.batting_team_mlb_id AS TEXT) END batting_team, CASE f.opponent_team_mlb_id ${Object.entries(MLB_TEAM_ABBREVIATIONS).map(([id,abbr])=>`WHEN ${id} THEN '${abbr}'`).join(' ')} ELSE CAST(f.opponent_team_mlb_id AS TEXT) END opponent_team FROM lineup_k_features_daily f WHERE f.official_date=? AND f.feature_version='lineup-k-v2' ORDER BY f.slot_weighted_lineup_k_rate DESC`).bind(date).all<Record<string,unknown>>()).results;
  const runs=(await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) error_count FROM sync_runs sr WHERE sr.dataset_name IN ('LINEUP_K_FEATURES_V2','BATTER_K_HAND_PROFILES','BATTER_K_PROFILES','BATTER_K_PROFILE_BACKFILL') ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>()).results;
  return json({date,source_status:source,batter_source_status:batterSource,rows,recent_runs:runs});
}

async function runLineupKFeatureSync(request: Request,env: Env):Promise<Response>{const input=await parseJson<{date?:string}>(request);return json({ok:true,...await syncLineupKFeaturesV2(env,input.date?validateDate(input.date):chicagoDateString(Date.now()),'ADMIN')});}
async function runLineupKHandProfileSync(request: Request,env: Env):Promise<Response>{const input=await parseJson<{date?:string;hand?:string}>(request);const hand=String(input.hand??'').toUpperCase();if(hand!=='L'&&hand!=='R')return json({ok:false,error:'hand must be L or R'},{status:400});const date=input.date?validateDate(input.date):chicagoDateString(Date.now());return json({ok:true,...await syncBatterKHandProfiles(env,date,'ADMIN',hand as 'L'|'R')});}


type LineupProfileGap = {
  mlb_batter_id:number;
  player_name:string;
  pitcher_hand:'L'|'R';
  batting_team_mlb_id:number;
  mlb_game_pk:number;
  batting_slot:number;
  attempt_status:string|null;
  attempt_message:string|null;
};

async function getLineupHandProfileGaps(env: Env, asOfDate: string): Promise<LineupProfileGap[]> {
  const safeDate=validateDate(asOfDate);
  const rows=(await env.DB.prepare(`
    WITH latest AS (
      SELECT ls.*
      FROM game_lineup_snapshots ls
      WHERE ls.official_date=? AND ls.lineup_status='CONFIRMED'
        AND ls.lineup_snapshot_id=(
          SELECT MAX(x.lineup_snapshot_id)
          FROM game_lineup_snapshots x
          WHERE x.mlb_game_pk=ls.mlb_game_pk
            AND x.batting_team_mlb_id=ls.batting_team_mlb_id
            AND x.lineup_status='CONFIRMED'
        )
    )
    SELECT e.mlb_batter_id,e.player_name,l.opposing_probable_pitcher_hand pitcher_hand,
           l.batting_team_mlb_id,l.mlb_game_pk,e.batting_slot,
           a.status attempt_status,a.message attempt_message
    FROM latest l
    JOIN game_lineup_entries e ON e.lineup_snapshot_id=l.lineup_snapshot_id
    LEFT JOIN batter_k_profiles_hand_daily h
      ON h.mlb_batter_id=e.mlb_batter_id AND h.as_of_date=?
      AND h.pitcher_hand=l.opposing_probable_pitcher_hand
      AND h.profile_version='batter-k-hand-v1'
    LEFT JOIN batter_k_profile_backfill_attempts a
      ON a.mlb_batter_id=e.mlb_batter_id AND a.as_of_date=?
      AND a.pitcher_hand=l.opposing_probable_pitcher_hand
    WHERE l.opposing_probable_pitcher_hand IN ('L','R')
      AND h.batter_k_hand_profile_id IS NULL
    ORDER BY l.mlb_game_pk,l.batting_team_mlb_id,e.batting_slot
  `).bind(safeDate,safeDate,safeDate).all<Record<string,unknown>>()).results;
  return rows.map(r=>({
    mlb_batter_id:Number(r.mlb_batter_id),player_name:String(r.player_name??''),
    pitcher_hand:String(r.pitcher_hand).toUpperCase() as 'L'|'R',
    batting_team_mlb_id:Number(r.batting_team_mlb_id),mlb_game_pk:Number(r.mlb_game_pk),
    batting_slot:Number(r.batting_slot),attempt_status:r.attempt_status==null?null:String(r.attempt_status),
    attempt_message:r.attempt_message==null?null:String(r.attempt_message)
  }));
}

async function fetchIndividualBatterHandSplit(mlbBatterId:number, asOfDate:string, pitcherHand:'L'|'R'):Promise<{pa:number;so:number;name:string;requests:number}> {
  const safeDate=validateDate(asOfDate), cutoff=previousIsoDate(safeDate), season=Number(safeDate.slice(0,4));
  const u=new URL(`https://statsapi.mlb.com/api/v1/people/${mlbBatterId}/stats`);
  u.searchParams.set('stats','statSplits');
  u.searchParams.set('group','hitting');
  u.searchParams.set('startDate',`${season}-03-01`);
  u.searchParams.set('endDate',cutoff);
  u.searchParams.set('season',String(season));
  u.searchParams.set('gameType','R');
  u.searchParams.set('sitCodes',pitcherHand==='R'?'vr':'vl');
  const payload=await fetchMlbJson(u.toString());
  const blocks=Array.isArray(payload.stats)?payload.stats as Array<Record<string,unknown>>:[];
  const splits=blocks.flatMap(b=>Array.isArray(b.splits)?b.splits as any[]:[]);
  let pa=0,so=0,name='';
  for(const sp of splits){
    pa+=Number(sp?.stat?.plateAppearances??0);so+=Number(sp?.stat?.strikeOuts??0);
    if(!name)name=String(sp?.player?.fullName??'');
  }
  return {pa,so,name,requests:1};
}

async function backfillLineupHandProfileGaps(env:Env,asOfDate:string,triggerSource:'ADMIN'|'CRON'|'API'|'MANUAL'='MANUAL',batchSize=6):Promise<Record<string,unknown>> {
  const safeDate=validateDate(asOfDate),cutoff=previousIsoDate(safeDate),season=Number(safeDate.slice(0,4));
  const allGaps=await getLineupHandProfileGaps(env,safeDate);
  const retryable=allGaps.filter(g=>g.attempt_status!=='NO_PRIOR_HAND_PA'&&g.attempt_status!=='FAILED_PERMANENT');
  const unique=new Map<string,LineupProfileGap>();
  for(const g of retryable)unique.set(`${g.mlb_batter_id}:${g.pitcher_hand}`,g);
  const targets=[...unique.values()].slice(0,Math.max(1,Math.min(10,Math.floor(batchSize)||6)));
  const run=await env.DB.prepare(`INSERT INTO sync_runs (run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_end) VALUES (?,'MLB_STATS_API','BATTER_K_PROFILE_BACKFILL','INCREMENTAL',?,'RUNNING',?)`).bind(crypto.randomUUID(),triggerSource,cutoff).run();
  const syncRunId=Number(run.meta.last_row_id);let inserted=0,updated=0,unchanged=0,rejected=0,requests=0,noPrior=0;
  try{
    for(const t of targets){
      try{
        const fetched=await fetchIndividualBatterHandSplit(t.mlb_batter_id,safeDate,t.pitcher_hand);requests+=fetched.requests;
        const leagueRow=await env.DB.prepare(`SELECT AVG(league_k_rate) v FROM batter_k_profiles_hand_daily WHERE as_of_date=? AND pitcher_hand=? AND profile_version='batter-k-hand-v1'`).bind(safeDate,t.pitcher_hand).first<{v:number}>();
        const leagueRate=Number(leagueRow?.v??0.225);
        if(fetched.pa<=0){
          noPrior++;
          await env.DB.prepare(`INSERT INTO batter_k_profile_backfill_attempts (mlb_batter_id,player_name,as_of_date,pitcher_hand,status,plate_appearances,strikeouts,message,last_sync_run_id,last_attempt_at) VALUES (?,?,?,?, 'NO_PRIOR_HAND_PA',0,0,?,?,CURRENT_TIMESTAMP) ON CONFLICT(mlb_batter_id,as_of_date,pitcher_hand) DO UPDATE SET player_name=excluded.player_name,status=excluded.status,plate_appearances=0,strikeouts=0,message=excluded.message,last_sync_run_id=excluded.last_sync_run_id,last_attempt_at=CURRENT_TIMESTAMP`).bind(t.mlb_batter_id,t.player_name,safeDate,t.pitcher_hand,'No prior regular-season plate appearances found for this pitcher-hand split.',syncRunId).run();
          continue;
        }
        const priorPa=60,raw=fetched.so/fetched.pa,shrunk=(fetched.so+leagueRate*priorPa)/(fetched.pa+priorPa),sampleWeight=fetched.pa/(fetched.pa+priorPa);
        const flags:string[]=['TARGETED_LINEUP_BACKFILL'];if(fetched.pa<20)flags.push('VERY_LOW_HAND_PA');else if(fetched.pa<60)flags.push('LOW_HAND_PA');
        let quality=Math.min(100,Math.round(35+Math.min(65,fetched.pa/3)));if(fetched.pa<20)quality=Math.min(quality,50);else if(fetched.pa<60)quality=Math.min(quality,72);
        const existing=await env.DB.prepare(`SELECT plate_appearances,strikeouts,shrunk_k_rate FROM batter_k_profiles_hand_daily WHERE mlb_batter_id=? AND as_of_date=? AND pitcher_hand=? AND profile_version='batter-k-hand-v1'`).bind(t.mlb_batter_id,safeDate,t.pitcher_hand).first<Record<string,unknown>>();
        await env.DB.prepare(`INSERT INTO batter_k_profiles_hand_daily (mlb_batter_id,player_name,as_of_date,source_cutoff_date,season,pitcher_hand,plate_appearances,strikeouts,raw_k_rate,shrunk_k_rate,league_k_rate,sample_weight,data_quality_score,data_quality_flags_json,source_name,profile_version,sync_run_id,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'MLB_STATS_API_TARGETED','batter-k-hand-v1',?,CURRENT_TIMESTAMP) ON CONFLICT(mlb_batter_id,as_of_date,pitcher_hand,profile_version) DO UPDATE SET player_name=excluded.player_name,source_cutoff_date=excluded.source_cutoff_date,season=excluded.season,plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,raw_k_rate=excluded.raw_k_rate,shrunk_k_rate=excluded.shrunk_k_rate,league_k_rate=excluded.league_k_rate,sample_weight=excluded.sample_weight,data_quality_score=excluded.data_quality_score,data_quality_flags_json=excluded.data_quality_flags_json,source_name=excluded.source_name,sync_run_id=excluded.sync_run_id,generated_at=CURRENT_TIMESTAMP`).bind(t.mlb_batter_id,fetched.name||t.player_name,safeDate,cutoff,season,t.pitcher_hand,fetched.pa,fetched.so,featureRound6(raw),featureRound6(shrunk),featureRound6(leagueRate),featureRound6(sampleWeight),quality,JSON.stringify(flags),syncRunId).run();
        await env.DB.prepare(`INSERT INTO batter_k_profile_backfill_attempts (mlb_batter_id,player_name,as_of_date,pitcher_hand,status,plate_appearances,strikeouts,message,last_sync_run_id,last_attempt_at) VALUES (?,?,?,?, 'FILLED',?,?,?, ?,CURRENT_TIMESTAMP) ON CONFLICT(mlb_batter_id,as_of_date,pitcher_hand) DO UPDATE SET player_name=excluded.player_name,status='FILLED',plate_appearances=excluded.plate_appearances,strikeouts=excluded.strikeouts,message=excluded.message,last_sync_run_id=excluded.last_sync_run_id,last_attempt_at=CURRENT_TIMESTAMP`).bind(t.mlb_batter_id,fetched.name||t.player_name,safeDate,t.pitcher_hand,fetched.pa,fetched.so,'Targeted lineup-only hand split fetched successfully.',syncRunId).run();
        if(!existing)inserted++;else if(Number(existing.plate_appearances)!==fetched.pa||Number(existing.strikeouts)!==fetched.so||Number(existing.shrunk_k_rate)!==Number(featureRound6(shrunk)))updated++;else unchanged++;
      }catch(error){
        rejected++;const message=error instanceof Error?error.message:String(error);
        await env.DB.prepare(`INSERT INTO batter_k_profile_backfill_attempts (mlb_batter_id,player_name,as_of_date,pitcher_hand,status,message,last_sync_run_id,last_attempt_at) VALUES (?,?,?,?, 'RETRYABLE_ERROR',?,?,CURRENT_TIMESTAMP) ON CONFLICT(mlb_batter_id,as_of_date,pitcher_hand) DO UPDATE SET status='RETRYABLE_ERROR',message=excluded.message,last_sync_run_id=excluded.last_sync_run_id,last_attempt_at=CURRENT_TIMESTAMP`).bind(t.mlb_batter_id,t.player_name,safeDate,t.pitcher_hand,message.slice(0,500),syncRunId).run();
        await env.DB.prepare(`INSERT INTO sync_errors (sync_run_id,error_stage,error_code,error_message,source_record_key,retryable,payload_excerpt) VALUES (?,'LINEUP_PROFILE_BACKFILL','TARGETED_HAND_PROFILE_ERROR',?,?,1,?)`).bind(syncRunId,message,`${t.mlb_batter_id}:${t.pitcher_hand}`,JSON.stringify(t).slice(0,1000)).run();
      }
    }
    const remaining=(await getLineupHandProfileGaps(env,safeDate)).filter(g=>g.attempt_status!=='NO_PRIOR_HAND_PA'&&g.attempt_status!=='FAILED_PERMANENT').length;
    const status=rejected===0?'SUCCEEDED':'PARTIAL';const details={date:safeDate,batch_targets:targets.length,inserted,updated,unchanged,no_prior_hand_pa:noPrior,rejected,requests,remaining_retryable:remaining,total_gaps_after:(await getLineupHandProfileGaps(env,safeDate)).length};
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_updated=?,rows_unchanged=?,rows_rejected=?,request_count=?,freshness_cutoff_at=?,details_json=? WHERE sync_run_id=?`).bind(status,targets.length,inserted,updated,unchanged,rejected,requests,cutoff,JSON.stringify(details),syncRunId).run();
    await env.DB.prepare(`INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES ('FEATURE_STORE','BATTER_K_PROFILE_BACKFILL',?,CURRENT_TIMESTAMP,CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,0,(SELECT COUNT(*) FROM batter_k_profile_backfill_attempts WHERE as_of_date=?),?,?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,last_complete_through_at=excluded.last_complete_through_at,last_sync_run_id=excluded.last_sync_run_id,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(status==='SUCCEEDED'?'HEALTHY':'INCOMPLETE',status,safeDate,syncRunId,safeDate,`${inserted+updated} targeted hand profiles filled; ${details.total_gaps_after} lineup gaps remain.`,JSON.stringify(details)).run();
    return {sync_run_id:syncRunId,status,...details};
  }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE sync_run_id=?`).bind(JSON.stringify({error:message}),syncRunId).run();throw error;}
}

async function getLineupProfileCoverage(env:Env,url:URL):Promise<Response>{
  const date=url.searchParams.get('date')?validateDate(String(url.searchParams.get('date'))):chicagoDateString(Date.now());
  const gaps=await getLineupHandProfileGaps(env,date);
  const rows=(await env.DB.prepare(`
    WITH latest AS (
      SELECT ls.* FROM game_lineup_snapshots ls
      WHERE ls.official_date=? AND ls.lineup_status='CONFIRMED'
        AND ls.lineup_snapshot_id=(SELECT MAX(x.lineup_snapshot_id) FROM game_lineup_snapshots x WHERE x.mlb_game_pk=ls.mlb_game_pk AND x.batting_team_mlb_id=ls.batting_team_mlb_id AND x.lineup_status='CONFIRMED')
    )
    SELECT l.batting_team_mlb_id,l.mlb_game_pk,l.opposing_probable_pitcher_hand,
      COUNT(e.lineup_entry_id) lineup_size,
      SUM(CASE WHEN h.batter_k_hand_profile_id IS NOT NULL THEN 1 ELSE 0 END) hand_profiled,
      SUM(CASE WHEN h.batter_k_hand_profile_id IS NULL AND g.batter_k_profile_id IS NOT NULL THEN 1 ELSE 0 END) generic_only,
      SUM(CASE WHEN h.batter_k_hand_profile_id IS NULL AND g.batter_k_profile_id IS NULL THEN 1 ELSE 0 END) league_only
    FROM latest l JOIN game_lineup_entries e ON e.lineup_snapshot_id=l.lineup_snapshot_id
    LEFT JOIN batter_k_profiles_hand_daily h ON h.mlb_batter_id=e.mlb_batter_id AND h.as_of_date=? AND h.pitcher_hand=l.opposing_probable_pitcher_hand AND h.profile_version='batter-k-hand-v1'
    LEFT JOIN batter_k_profiles_daily g ON g.mlb_batter_id=e.mlb_batter_id AND g.as_of_date=? AND g.profile_version='batter-k-v1'
    GROUP BY l.lineup_snapshot_id ORDER BY l.mlb_game_pk,l.batting_team_mlb_id
  `).bind(date,date,date).all<Record<string,unknown>>()).results;
  const teamCase=`CASE batting_team_mlb_id ${Object.entries(MLB_TEAM_ABBREVIATIONS).map(([id,abbr])=>`WHEN ${id} THEN '${abbr}'`).join(' ')} ELSE CAST(batting_team_mlb_id AS TEXT) END`;
  const labeled=rows.map(r=>({...r,batting_team:MLB_TEAM_ABBREVIATIONS[Number(r.batting_team_mlb_id)]??String(r.batting_team_mlb_id)}));
  return json({date,lineups:labeled,gaps,total_gaps:gaps.length,retryable_gaps:gaps.filter(g=>g.attempt_status!=='NO_PRIOR_HAND_PA'&&g.attempt_status!=='FAILED_PERMANENT').length,team_case:teamCase});
}

async function runLineupProfileBackfill(request:Request,env:Env):Promise<Response>{const input=await parseJson<{date?:string;batch_size?:number}>(request);const date=input.date?validateDate(input.date):chicagoDateString(Date.now());return json({ok:true,...await backfillLineupHandProfileGaps(env,date,'ADMIN',Number(input.batch_size??6))});}



type LineupReplayDatasetRow = {
  backtest_dataset_row_id:number;board_date:string;pitcher_id:number;pitcher_mlb_id:number|null;pitcher_hand:string|null;
  opponent_team_id:number|null;opponent_abbreviation:string|null;prop_line:number;projected_strikeouts:number|null;
  preferred_side:string|null;preferred_outcome:string|null;more_outcome:string|null;less_outcome:string|null;team_features_json:string|null;
};

type HistoricalGameLineup = {
  gamePk:number; scheduledStart:string|null; awayTeamId:number; homeTeamId:number;
  awayStarterId:number|null; homeStarterId:number|null; awayLineup:LineupPlayerView[]; homeLineup:LineupPlayerView[];
};

function starterIdFromFeed(payload: unknown, side:'away'|'home'): number|null {
  const team=(payload as any)?.liveData?.boxscore?.teams?.[side];
  const players=(team?.players??{}) as Record<string,any>;
  for(const player of Object.values(players)){
    const started=Number((player as any)?.stats?.pitching?.gamesStarted??0);
    const id=Number((player as any)?.person?.id??0);
    if(started>0&&id>0)return id;
  }
  const ids=(team?.pitchers??[]).map((v:unknown)=>Number(v)).filter((v:number)=>v>0);
  return ids.length?ids[0]:null;
}

function extractTeamKRateReference(raw:string|null):number|null{
  if(!raw)return null; let obj:any={}; try{obj=JSON.parse(raw)}catch{return null}
  const candidates=[obj.weighted_recent_k_rate,obj.weighted_k_rate,obj.opponent_weighted_k_rate,obj?.opponent?.weighted_recent_k_rate,obj?.window_30?.k_rate,obj?.team?.weighted_recent_k_rate];
  for(const v of candidates){const n=Number(v);if(Number.isFinite(n)&&n>0&&n<1)return n;}
  return null;
}

async function fetchHistoricalGamesWithLineups(date:string):Promise<{games:HistoricalGameLineup[];requests:number}>{
  const u=new URL('https://statsapi.mlb.com/api/v1/schedule');u.searchParams.set('sportId','1');u.searchParams.set('date',date);
  const schedule=await fetchMlbJson(u.toString());let requests=1;
  const dates=Array.isArray((schedule as any).dates)?(schedule as any).dates:[];
  const gamesRaw=dates.flatMap((d:any)=>Array.isArray(d.games)?d.games:[]);
  const out:HistoricalGameLineup[]=[];
  for(const g of gamesRaw){
    const gamePk=Number(g?.gamePk??0);if(!gamePk)continue;
    const feed=await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);requests++;
    const awayTeamId=Number((feed as any)?.gameData?.teams?.away?.id??g?.teams?.away?.team?.id??0);
    const homeTeamId=Number((feed as any)?.gameData?.teams?.home?.id??g?.teams?.home?.team?.id??0);
    out.push({gamePk,scheduledStart:String((feed as any)?.gameData?.datetime?.dateTime??g?.gameDate??'')||null,awayTeamId,homeTeamId,
      awayStarterId:starterIdFromFeed(feed,'away'),homeStarterId:starterIdFromFeed(feed,'home'),
      awayLineup:lineupPlayersFromFeed(feed,'away'),homeLineup:lineupPlayersFromFeed(feed,'home')});
  }
  return {games:out,requests};
}

function replayOutcomeForSide(row:LineupReplayDatasetRow,side:string|null):string|null{
  const s=String(side??'').toUpperCase();return s==='MORE'?row.more_outcome??null:s==='LESS'?row.less_outcome??null:null;
}

async function latestWalkForwardV2(env:Env):Promise<{backtest_run_id:number;backtest_dataset_build_id:number}|null>{
  return env.DB.prepare(`SELECT backtest_run_id,backtest_dataset_build_id FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<{backtest_run_id:number;backtest_dataset_build_id:number}>();
}

async function lineupReplayCandidateDates(env:Env,backtestRunId:number):Promise<string[]>{
  const rows=(await env.DB.prepare(`SELECT DISTINCT r.board_date FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' ORDER BY r.board_date`).bind(backtestRunId).all<{board_date:string}>()).results??[];
  return rows.map(r=>String(r.board_date));
}

async function reconstructLineupReplayDate(request:Request,env:Env):Promise<Response>{
  const input=await parseJson<{date?:string}>(request);const wf=await latestWalkForwardV2(env);if(!wf)return json({ok:false,error:'No walk-forward-v2 run found.'},{status:400});
  const dates=await lineupReplayCandidateDates(env,wf.backtest_run_id);if(!dates.length)return json({ok:false,error:'No executed test dates found.'},{status:400});
  let date=input.date?validateDate(input.date):'';
  let run=await env.DB.prepare(`SELECT * FROM lineup_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? AND replay_version='lineup-challenger-replay-v1' ORDER BY lineup_replay_run_id DESC LIMIT 1`).bind(wf.backtest_run_id,wf.backtest_dataset_build_id).first<Record<string,unknown>>();
  if(!run){const x=await env.DB.prepare(`INSERT INTO lineup_challenger_replay_runs(run_uuid,backtest_run_id,backtest_dataset_build_id,replay_version,status) VALUES (?,?,?,'lineup-challenger-replay-v1','RUNNING')`).bind(crypto.randomUUID(),wf.backtest_run_id,wf.backtest_dataset_build_id).run();run={lineup_replay_run_id:Number(x.meta.last_row_id)};}
  const runId=Number(run.lineup_replay_run_id);
  if(!date){for(const d of dates){const c=await env.DB.prepare(`SELECT COUNT(*) c FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? AND board_date=?`).bind(runId,d).first<{c:number}>();if(Number(c?.c??0)===0){date=d;break;}}}
  if(!date){await env.DB.prepare(`UPDATE lineup_challenger_replay_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP WHERE lineup_replay_run_id=?`).bind(runId).run();return json({ok:true,done:true,lineup_replay_run_id:runId});}
  const tests=(await env.DB.prepare(`SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,r.pitcher_id,p.mlb_id pitcher_mlb_id,COALESCE(r.pitcher_hand,p.throws_hand) pitcher_hand,r.opponent_team_id,t.abbreviation opponent_abbreviation,r.prop_line,r.projected_strikeouts,r.preferred_side,r.preferred_outcome,r.more_outcome,r.less_outcome,r.team_features_json FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id JOIN pitchers p ON p.pitcher_id=r.pitcher_id LEFT JOIN teams t ON t.team_id=r.opponent_team_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND r.board_date=? ORDER BY r.backtest_dataset_row_id`).bind(wf.backtest_run_id,date).all<LineupReplayDatasetRow>()).results??[];
  const hg=await fetchHistoricalGamesWithLineups(date);const handNeeded=new Set<'L'|'R'>();for(const r of tests){const h=String(r.pitcher_hand??'').toUpperCase();if(h==='L'||h==='R')handNeeded.add(h as 'L'|'R');}
  const profiles=new Map<string,{map:Map<number,BatterHandProfileInput>;league:number}>();let profileRequests=0;
  for(const h of handNeeded){const f=await fetchLeagueBatterHandSplits(date,h);profileRequests+=f.requests;profiles.set(h,{map:new Map(f.rows.map(x=>[x.id,x])),league:f.leagueRate});}
  let reconstructed=0,incomplete=0,disagreements=0;
  for(const row of tests){
    const h=String(row.pitcher_hand??'').toUpperCase();const pitcherMlb=Number(row.pitcher_mlb_id??0);let sourceMode='INCOMPLETE',sourceNote='',gamePk:number|null=null,oppMlb:number|null=null,lineup:LineupPlayerView[]=[];
    if(!pitcherMlb||(h!=='L'&&h!=='R'))sourceNote='pitcher MLB id or hand missing';
    else{
      const g=hg.games.find(x=>x.awayStarterId===pitcherMlb||x.homeStarterId===pitcherMlb);
      if(g){gamePk=g.gamePk;if(g.awayStarterId===pitcherMlb){oppMlb=g.homeTeamId;lineup=g.homeLineup;}else{oppMlb=g.awayTeamId;lineup=g.awayLineup;}
        const native=await env.DB.prepare(`SELECT ls.lineup_snapshot_id FROM game_lineup_snapshots ls LEFT JOIN games gm ON gm.mlb_game_pk=ls.mlb_game_pk WHERE ls.mlb_game_pk=? AND ls.batting_team_mlb_id=? AND ls.lineup_status='CONFIRMED' AND gm.scheduled_start IS NOT NULL AND datetime(ls.captured_at)<=datetime(gm.scheduled_start) ORDER BY ls.captured_at DESC LIMIT 1`).bind(gamePk,oppMlb).first<{lineup_snapshot_id:number}>();
        if(native){const es=(await env.DB.prepare(`SELECT batting_slot,mlb_batter_id,player_name,bat_side,position_abbr position,source_order_value order_value FROM game_lineup_entries WHERE lineup_snapshot_id=? ORDER BY batting_slot`).bind(native.lineup_snapshot_id).all<Record<string,unknown>>()).results;lineup=es.map((e:any)=>({id:Number(e.mlb_batter_id),name:String(e.player_name),bat_side:normalizeBatSide(e.bat_side),position:e.position?String(e.position):null,order_value:e.order_value?String(e.order_value):null}));sourceMode='NATIVE_PREGAME';sourceNote='Captured lineup snapshot timestamped at or before scheduled start.';}
        else{sourceMode='RECONSTRUCTED_ACTUAL';sourceNote='Actual batting order reconstructed from MLB game feed; research-only because original pregame publication timestamp is not independently certified.';}
      }else sourceNote='No historical MLB game feed matched this pitcher as the starter.';
    }
    let lineupRate:number|null=null,coverage=0,totalPa=0,teamRate=extractTeamKRateReference(row.team_features_json),lineupProjection:number|null=null,lineupSide:string|null=null,lineupOutcome:string|null=null,quality=0;
    if(sourceMode!=='INCOMPLETE'&&lineup.length>=9&&(h==='L'||h==='R')){
      const prof=profiles.get(h);if(prof){let weighted=0,wsum=0,covered=0;lineup.slice(0,9).forEach((b,i)=>{const x=prof.map.get(b.id);const rate=x&&x.pa>0?(x.so+prof.league*60)/(x.pa+60):prof.league;const w=LINEUP_SLOT_WEIGHTS[i]??1;weighted+=rate*w;wsum+=w;if(x&&x.pa>0){covered++;totalPa+=x.pa;}});lineupRate=wsum?weighted/wsum:null;coverage=covered/9;quality=Math.max(0,Math.min(100,Math.round(55+coverage*35+Math.min(10,totalPa/250))));}
      if(teamRate===null){const teamRow=await env.DB.prepare(`SELECT weighted_recent_k_rate FROM team_daily_features WHERE mlb_team_id=? AND as_of_date=? AND pitcher_hand=? ORDER BY team_daily_feature_id DESC LIMIT 1`).bind(oppMlb,date,h).first<{weighted_recent_k_rate:number}>();if(teamRow?.weighted_recent_k_rate!=null)teamRate=Number(teamRow.weighted_recent_k_rate);}
      const baseProj=Number(row.projected_strikeouts);if(lineupRate!==null&&Number.isFinite(baseProj)&&baseProj>0){const oldM=clamp(1+((teamRate??LEAGUE_BASELINE_K_RATE)-LEAGUE_BASELINE_K_RATE)*2,.88,1.12);const newM=clamp(1+(lineupRate-LEAGUE_BASELINE_K_RATE)*2,.88,1.12);lineupProjection=(baseProj/oldM)*newM;lineupSide=lineupProjection>=Number(row.prop_line)?'MORE':'LESS';lineupOutcome=replayOutcomeForSide(row,lineupSide);}
    }
    const baselineSide=String(row.preferred_side??'').toUpperCase()||null,baselineOutcome=replayOutcomeForSide(row,baselineSide);const disagreement=!!(lineupSide&&baselineSide&&lineupSide!==baselineSide);if(disagreement)disagreements++;
    const baselineHit=baselineOutcome==='WIN'?1:baselineOutcome==='LOSS'?0:null,lineupHit=lineupOutcome==='WIN'?1:lineupOutcome==='LOSS'?0:null;
    if(sourceMode==='INCOMPLETE'||lineupRate===null||lineupSide===null){incomplete++;sourceMode='INCOMPLETE';}else reconstructed++;
    await env.DB.prepare(`INSERT OR REPLACE INTO lineup_challenger_replay_rows(lineup_replay_run_id,backtest_dataset_row_id,board_date,mlb_game_pk,pitcher_id,pitcher_mlb_id,pitcher_hand,opponent_team_id,opponent_mlb_team_id,source_mode,source_note,lineup_size,hand_profiled_batters,hand_profile_coverage,total_hand_pa,lineup_k_rate,team_k_rate_reference,lineup_vs_team_delta,baseline_projection,lineup_projection,prop_line,baseline_side,lineup_side,baseline_outcome,lineup_outcome,disagreement,lineup_hit,baseline_hit,quality_score,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(runId,row.backtest_dataset_row_id,date,gamePk,row.pitcher_id,pitcherMlb||null,h==='L'||h==='R'?h:null,row.opponent_team_id,oppMlb,sourceMode,sourceNote,lineup.length,Math.round(coverage*9),coverage,totalPa,lineupRate,teamRate,lineupRate!==null&&teamRate!==null?lineupRate-teamRate:null,row.projected_strikeouts,lineupProjection,row.prop_line,baselineSide,lineupSide,baselineOutcome,lineupOutcome,disagreement?1:0,lineupHit,baselineHit,quality,JSON.stringify({profile_cutoff:previousIsoDate(date),league_baseline:LEAGUE_BASELINE_K_RATE,projection_rule:'replace team matchup multiplier with lineup matchup multiplier; multiplier=clamp(1+(k_rate-league)*2,.88,1.12)',research_only:sourceMode!=='NATIVE_PREGAME'})).run();
  }
  const doneCount=Number((await env.DB.prepare(`SELECT COUNT(DISTINCT board_date) c FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=?`).bind(runId).first<{c:number}>())?.c??0);const done=doneCount>=dates.length;
  await env.DB.prepare(`UPDATE lineup_challenger_replay_runs SET status=?,completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,dates_seen=?,rows_seen=(SELECT COUNT(*) FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=?),rows_reconstructed=(SELECT COUNT(*) FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? AND source_mode<>'INCOMPLETE'),rows_incomplete=(SELECT COUNT(*) FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? AND source_mode='INCOMPLETE'),details_json=? WHERE lineup_replay_run_id=?`).bind(done?'SUCCEEDED':'RUNNING',done?1:0,doneCount,runId,runId,runId,JSON.stringify({latest_date:date,date_rows:tests.length,date_reconstructed:reconstructed,date_incomplete:incomplete,date_disagreements:disagreements,mlb_requests:hg.requests+profileRequests,total_test_dates:dates.length,provenance_policy:'NATIVE_PREGAME is timestamp-certified; RECONSTRUCTED_ACTUAL is research-only and never promotion evidence'}),runId).run();
  return json({ok:true,lineup_replay_run_id:runId,date,test_rows:tests.length,reconstructed,incomplete,disagreements,dates_completed:doneCount,total_dates:dates.length,done,requests:hg.requests+profileRequests});
}

async function getLineupChallengerReplay(env:Env,url:URL):Promise<Response>{
  const wf=await latestWalkForwardV2(env);if(!wf)return json({run:null,summary:null,months:[],deltas:[],recent:[],dates:[]});
  const run=await env.DB.prepare(`SELECT * FROM lineup_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? ORDER BY lineup_replay_run_id DESC LIMIT 1`).bind(wf.backtest_run_id,wf.backtest_dataset_build_id).first<Record<string,unknown>>();
  const dates=await lineupReplayCandidateDates(env,wf.backtest_run_id);if(!run)return json({walk_forward:wf,run:null,summary:null,months:[],deltas:[],recent:[],dates,total_dates:dates.length});const id=Number(run.lineup_replay_run_id);
  const summary=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(CASE WHEN source_mode<>'INCOMPLETE' THEN 1 ELSE 0 END) usable,SUM(CASE WHEN source_mode='NATIVE_PREGAME' THEN 1 ELSE 0 END) native_pregame,SUM(CASE WHEN source_mode='RECONSTRUCTED_ACTUAL' THEN 1 ELSE 0 END) reconstructed_actual,SUM(CASE WHEN baseline_hit=1 THEN 1 ELSE 0 END) baseline_wins,SUM(CASE WHEN baseline_hit=0 THEN 1 ELSE 0 END) baseline_losses,SUM(CASE WHEN lineup_hit=1 THEN 1 ELSE 0 END) lineup_wins,SUM(CASE WHEN lineup_hit=0 THEN 1 ELSE 0 END) lineup_losses,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 THEN 1 ELSE 0 END) disagreement_losses,AVG(hand_profile_coverage) avg_coverage,AVG(lineup_vs_team_delta) avg_delta FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=?`).bind(id).first<Record<string,unknown>>();
  const months=(await env.DB.prepare(`SELECT substr(board_date,1,7) month,COUNT(*) n,SUM(CASE WHEN lineup_hit=1 THEN 1 ELSE 0 END) wins,SUM(CASE WHEN lineup_hit=0 THEN 1 ELSE 0 END) losses,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? AND source_mode<>'INCOMPLETE' GROUP BY substr(board_date,1,7) ORDER BY month`).bind(id).all<Record<string,unknown>>()).results;
  const deltas=(await env.DB.prepare(`SELECT CASE WHEN ABS(lineup_vs_team_delta)<.01 THEN '<1 pp' WHEN ABS(lineup_vs_team_delta)<.02 THEN '1–2 pp' WHEN ABS(lineup_vs_team_delta)<.04 THEN '2–4 pp' WHEN ABS(lineup_vs_team_delta)<.06 THEN '4–6 pp' ELSE '6+ pp' END bucket,COUNT(*) n,SUM(CASE WHEN lineup_hit=1 THEN 1 ELSE 0 END) wins,SUM(CASE WHEN lineup_hit=0 THEN 1 ELSE 0 END) losses,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,AVG(lineup_vs_team_delta) avg_delta FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? AND source_mode<>'INCOMPLETE' AND lineup_vs_team_delta IS NOT NULL GROUP BY bucket ORDER BY CASE bucket WHEN '<1 pp' THEN 1 WHEN '1–2 pp' THEN 2 WHEN '2–4 pp' THEN 3 WHEN '4–6 pp' THEN 4 ELSE 5 END`).bind(id).all<Record<string,unknown>>()).results;
  const recent=(await env.DB.prepare(`SELECT r.*,p.canonical_name pitcher_name,t.abbreviation opponent FROM lineup_challenger_replay_rows r JOIN pitchers p ON p.pitcher_id=r.pitcher_id LEFT JOIN teams t ON t.team_id=r.opponent_team_id WHERE r.lineup_replay_run_id=? ORDER BY r.board_date DESC,r.lineup_replay_row_id DESC LIMIT 100`).bind(id).all<Record<string,unknown>>()).results;
  const completed=(await env.DB.prepare(`SELECT DISTINCT board_date FROM lineup_challenger_replay_rows WHERE lineup_replay_run_id=? ORDER BY board_date`).bind(id).all<{board_date:string}>()).results.map(x=>String(x.board_date));
  return json({walk_forward:wf,run,summary,months,deltas,recent,dates,total_dates:dates.length,completed_dates:completed,next_date:dates.find(d=>!completed.includes(d))??null});
}

async function getLineupSignalDiagnostics(env:Env,url:URL):Promise<Response>{
  const wf=await latestWalkForwardV2(env);
  if(!wf)return json({walk_forward:null,run:null,summary:null,coverage:[],hands:[],sides:[],signed_deltas:[],coverage_disagreements:[]});
  const run=await env.DB.prepare(`SELECT * FROM lineup_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? ORDER BY lineup_replay_run_id DESC LIMIT 1`).bind(wf.backtest_run_id,wf.backtest_dataset_build_id).first<Record<string,unknown>>();
  if(!run)return json({walk_forward:wf,run:null,summary:null,coverage:[],hands:[],sides:[],signed_deltas:[],coverage_disagreements:[]});
  const id=Number(run.lineup_replay_run_id);
  const usable=`lineup_replay_run_id=? AND source_mode<>'INCOMPLETE' AND lineup_hit IS NOT NULL AND baseline_hit IS NOT NULL`;
  const summary=await env.DB.prepare(`SELECT COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(lineup_hit) lineup_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,AVG(hand_profile_coverage) avg_coverage,AVG(quality_score) avg_quality FROM lineup_challenger_replay_rows WHERE ${usable}`).bind(id).first<Record<string,unknown>>();
  const coverage=(await env.DB.prepare(`SELECT CASE WHEN hand_profile_coverage<.278 THEN '0-2/9' WHEN hand_profile_coverage<.50 THEN '3-4/9' WHEN hand_profile_coverage<.722 THEN '5-6/9' WHEN hand_profile_coverage<.945 THEN '7-8/9' ELSE '9/9' END bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(lineup_hit) lineup_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed,AVG(hand_profile_coverage) avg_coverage,AVG(lineup_vs_team_delta) avg_delta FROM lineup_challenger_replay_rows WHERE ${usable} GROUP BY bucket ORDER BY CASE bucket WHEN '0-2/9' THEN 1 WHEN '3-4/9' THEN 2 WHEN '5-6/9' THEN 3 WHEN '7-8/9' THEN 4 ELSE 5 END`).bind(id).all<Record<string,unknown>>()).results;
  const hands=(await env.DB.prepare(`SELECT COALESCE(pitcher_hand,'?') bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(lineup_hit) lineup_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed FROM lineup_challenger_replay_rows WHERE ${usable} GROUP BY COALESCE(pitcher_hand,'?') ORDER BY bucket`).bind(id).all<Record<string,unknown>>()).results;
  const sides=(await env.DB.prepare(`SELECT COALESCE(baseline_side,'?') bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(lineup_hit) lineup_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed FROM lineup_challenger_replay_rows WHERE ${usable} GROUP BY COALESCE(baseline_side,'?') ORDER BY bucket`).bind(id).all<Record<string,unknown>>()).results;
  const signed=(await env.DB.prepare(`SELECT CASE WHEN lineup_vs_team_delta<=-.06 THEN '<=-6 pp' WHEN lineup_vs_team_delta<=-.04 THEN '-6 to -4 pp' WHEN lineup_vs_team_delta<=-.02 THEN '-4 to -2 pp' WHEN lineup_vs_team_delta<0 THEN '-2 to 0 pp' WHEN lineup_vs_team_delta<.02 THEN '0 to +2 pp' WHEN lineup_vs_team_delta<.04 THEN '+2 to +4 pp' WHEN lineup_vs_team_delta<.06 THEN '+4 to +6 pp' ELSE '>=+6 pp' END bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(lineup_hit) lineup_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(CASE WHEN disagreement=1 AND lineup_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND lineup_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed,AVG(lineup_vs_team_delta) avg_delta FROM lineup_challenger_replay_rows WHERE ${usable} AND lineup_vs_team_delta IS NOT NULL GROUP BY bucket ORDER BY MIN(lineup_vs_team_delta)`).bind(id).all<Record<string,unknown>>()).results;
  const coverageDisagreements=(await env.DB.prepare(`SELECT CASE WHEN hand_profile_coverage<.278 THEN '0-2/9' WHEN hand_profile_coverage<.50 THEN '3-4/9' WHEN hand_profile_coverage<.722 THEN '5-6/9' WHEN hand_profile_coverage<.945 THEN '7-8/9' ELSE '9/9' END coverage_bucket,COALESCE(baseline_side,'?') baseline_side,COUNT(*) n,SUM(lineup_hit) lineup_wins,SUM(baseline_hit) baseline_wins,AVG(ABS(lineup_vs_team_delta)) avg_abs_delta FROM lineup_challenger_replay_rows WHERE ${usable} AND disagreement=1 GROUP BY coverage_bucket,COALESCE(baseline_side,'?') ORDER BY CASE coverage_bucket WHEN '0-2/9' THEN 1 WHEN '3-4/9' THEN 2 WHEN '5-6/9' THEN 3 WHEN '7-8/9' THEN 4 ELSE 5 END,baseline_side`).bind(id).all<Record<string,unknown>>()).results;
  return json({walk_forward:wf,run,summary,coverage,hands,sides,signed_deltas:signed,coverage_disagreements:coverageDisagreements,diagnostic_version:'lineup-signal-diagnostics-v1',promotion_eligible:false,note:'Research diagnostic only. No model thresholds or production behavior are changed.'});
}

function sqlUtcToEpoch(value: unknown): number | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function effectiveSourceHealth(row: Record<string, unknown>, nowMs = Date.now()): string {
  const stored = String(row.status ?? 'UNKNOWN').toUpperCase();
  if (stored === 'FAILED' || stored === 'NEVER_SYNCED' || stored === 'DISABLED') return stored;
  const lastSuccessMs = sqlUtcToEpoch(row.last_success_at);
  const staleAfterMinutes = Number(row.stale_after_minutes ?? 0);
  if (!lastSuccessMs) return stored === 'HEALTHY' ? 'INCOMPLETE' : stored;
  if (staleAfterMinutes > 0 && nowMs - lastSuccessMs > staleAfterMinutes * 60_000) return 'DELAYED';
  return stored;
}

async function getIngestionHealth(env: Env): Promise<Response> {
  const expected = [
    { source_name: 'MLB_STATS_API', dataset_name: 'MLB_SCHEDULE_GAMES', label: 'MLB Schedule', admin_path: '/schedule-sync.html', sync_path: '/api/data-sources/mlb-schedule/sync' },
    { source_name: 'MLB_STATS_API', dataset_name: 'PITCHER_GAME_LOGS', label: 'Pitcher Game Logs', admin_path: '/pitcher-log-sync.html', sync_path: '/api/data-sources/pitcher-game-logs/sync' },
    { source_name: 'MLB_STATS_API', dataset_name: 'TEAM_STRIKEOUT_SPLITS', label: 'Team Strikeout Splits', admin_path: '/team-split-sync.html', sync_path: '/api/data-sources/team-strikeout-splits/sync' },
    { source_name: 'MLB_STATS_API', dataset_name: 'LINEUP_SNAPSHOTS', label: 'Lineup Snapshots', admin_path: '/lineup-sync.html', sync_path: '/api/data-sources/lineups/sync' },
  ];
  const statuses = await env.DB.prepare(`
    SELECT * FROM data_source_status
    WHERE source_name='MLB_STATS_API'
      AND dataset_name IN ('MLB_SCHEDULE_GAMES','PITCHER_GAME_LOGS','TEAM_STRIKEOUT_SPLITS','LINEUP_SNAPSHOTS')
  `).all<Record<string, unknown>>();
  const byDataset = new Map((statuses.results ?? []).map(row => [String(row.dataset_name), row]));
  const now = Date.now();
  const sources = expected.map(def => {
    const row = byDataset.get(def.dataset_name) ?? { source_name: def.source_name, dataset_name: def.dataset_name, status: 'NEVER_SYNCED' };
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(String(row.metadata_json ?? '{}')); } catch {}
    return {
      ...row,
      ...def,
      effective_status: effectiveSourceHealth(row, now),
      metadata,
    };
  });
  const severity = (status: string) => ({ FAILED: 5, NEVER_SYNCED: 4, INCOMPLETE: 3, DELAYED: 2, UNKNOWN: 2, HEALTHY: 0, DISABLED: 0 } as Record<string, number>)[status] ?? 2;
  const worst = sources.reduce((a, b) => severity(String(a.effective_status)) >= severity(String(b.effective_status)) ? a : b);
  const overall = sources.every(s => s.effective_status === 'HEALTHY') ? 'HEALTHY' : String(worst.effective_status);

  const recentRuns = await env.DB.prepare(`
    SELECT sr.*,
      (SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) AS error_count
    FROM sync_runs sr
    WHERE sr.dataset_name IN ('MLB_SCHEDULE_GAMES','PITCHER_GAME_LOGS','TEAM_STRIKEOUT_SPLITS','LINEUP_SNAPSHOTS')
    ORDER BY sr.sync_run_id DESC LIMIT 30
  `).all<Record<string, unknown>>();
  const recentErrors = await env.DB.prepare(`
    SELECT se.sync_error_id,se.sync_run_id,se.error_stage,se.error_code,se.error_message,se.source_record_key,
           se.retryable,se.retry_count,se.occurred_at,se.resolved_at,se.resolution_note,
           sr.dataset_name,sr.trigger_source
    FROM sync_errors se JOIN sync_runs sr ON sr.sync_run_id=se.sync_run_id
    WHERE sr.dataset_name IN ('MLB_SCHEDULE_GAMES','PITCHER_GAME_LOGS','TEAM_STRIKEOUT_SPLITS')
    ORDER BY se.sync_error_id DESC LIMIT 30
  `).all<Record<string, unknown>>();
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM games WHERE source_name='MLB_STATS_API') AS schedule_games,
      (SELECT COUNT(*) FROM raw_pitcher_game_logs) AS pitcher_logs,
      (SELECT COUNT(*) FROM team_strikeout_splits_daily) AS team_split_rows
  `).first<Record<string, unknown>>();

  return json({
    overall_status: overall,
    generated_at: new Date(now).toISOString(),
    sources,
    recent_runs: recentRuns.results,
    recent_errors: recentErrors.results,
    counts: counts ?? {},
  });
}

async function getTeamSplitSyncStatus(env: Env, url: URL): Promise<Response> {
  const asOf=url.searchParams.get("date");
  const date=asOf?validateDate(asOf):chicagoDateString(Date.now());
  const source=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='TEAM_STRIKEOUT_SPLITS'`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) error_count FROM sync_runs sr WHERE sr.dataset_name='TEAM_STRIKEOUT_SPLITS' ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const rows=await env.DB.prepare(`
    SELECT s.*,t.abbreviation FROM team_strikeout_splits_daily s JOIN teams t ON t.team_id=s.team_id
    WHERE s.as_of_date=(SELECT MAX(as_of_date) FROM team_strikeout_splits_daily WHERE as_of_date<=?)
    ORDER BY t.abbreviation,s.pitcher_hand,s.window_days
  `).bind(date).all<Record<string,unknown>>();
  return json({source_status:source,recent_runs:runs.results,splits:rows.results});
}

async function runTeamSplitSync(request: Request, env: Env): Promise<Response> {
  const input=await parseJson<{as_of_date?:string;offset?:number;limit?:number}>(request);
  return json({ok:true,...await syncTeamStrikeoutSplits(env,input.as_of_date?validateDate(input.as_of_date):chicagoDateString(Date.now()),Number(input.offset??0),1,"ADMIN")});
}

async function autoSyncTeamStrikeoutSplits(env: Env, scheduledTime: number): Promise<void> {
  const local=chicagoDateParts(scheduledTime);
  if (local.minute % 10 !== 0) return;
  const status=await env.DB.prepare(`SELECT metadata_json FROM data_source_status WHERE dataset_name='TEAM_STRIKEOUT_SPLITS'`).first<{metadata_json:string|null}>();
  let offset=0;
  try { offset=Number(JSON.parse(status?.metadata_json||'{}').next_offset||0); } catch {}
  await syncTeamStrikeoutSplits(env,chicagoDateString(scheduledTime),offset,1,"CRON");
}


interface SameOpponentHistory {
  start_count: number;
  k_avg: number | null;
  bf_avg: number | null;
  pitch_count_avg: number | null;
  adjustment: number;
}

interface HistoricalCalibration {
  sample_size: number;
  wins: number;
  hit_rate: number | null;
  adjusted_hit_rate: number | null;
  score_adjustment: number;
  scope: string;
}

async function getSameOpponentHistory(
  env: Env,
  pitcherId: number,
  opponentTeamId: number | null,
  asOfDate: string,
  baselineKPerBf: number,
  expectedBf: number,
): Promise<SameOpponentHistory> {
  if (!opponentTeamId) {
    return { start_count: 0, k_avg: null, bf_avg: null, pitch_count_avg: null, adjustment: 0 };
  }
  const rows = await env.DB.prepare(`
    SELECT game_date, strikeouts, batters_faced, pitch_count
    FROM pitcher_game_stats
    WHERE pitcher_id = ? AND opponent_team_id = ? AND starter = 1
      AND game_date < ? AND strikeouts IS NOT NULL
      AND batters_faced IS NOT NULL AND batters_faced > 0
    ORDER BY game_date DESC
    LIMIT 5
  `).bind(pitcherId, opponentTeamId, asOfDate).all<{
    game_date: string; strikeouts: number; batters_faced: number; pitch_count: number | null;
  }>();
  const starts = rows.results;
  const summary = {
    start_count: starts.length,
    k_avg: starts.length ? average(starts.map(row => Number(row.strikeouts))) : null,
    bf_avg: starts.length ? average(starts.map(row => Number(row.batters_faced))) : null,
    pitch_count_avg: average(starts.map(row => Number(row.pitch_count)).filter(Number.isFinite)),
    adjustment: 0,
  };
  if (starts.length < 2) return summary;
  const weights = starts.map((_, index) => Math.pow(0.72, index));
  const weightedKs = starts.reduce((sum, row, index) => sum + Number(row.strikeouts) * weights[index], 0);
  const weightedBf = starts.reduce((sum, row, index) => sum + Number(row.batters_faced) * weights[index], 0);
  const opponentKPerBf = weightedBf > 0 ? weightedKs / weightedBf : baselineKPerBf;
  const reliability = starts.length === 2 ? 0.35 : starts.length === 3 ? 0.50 : starts.length === 4 ? 0.65 : 0.75;
  summary.adjustment = clamp((opponentKPerBf - baselineKPerBf) * expectedBf * reliability, -0.25, 0.25);
  return summary;
}

async function getHistoricalCalibration(
  env: Env,
  boardDate: string,
  preferredSide: string,
  strikeoutLine: number,
  propType: string,
): Promise<HistoricalCalibration> {
  const scopes: Array<{ name: string; min: number; sql: string; args: unknown[] }> = [
    { name: "SIDE+TYPE+LINE", min: 20, sql: "AND r.preferred_side = ? AND p.prop_type = ? AND ABS(p.strikeout_line - ?) <= 0.5", args: [preferredSide, propType, strikeoutLine] },
    { name: "SIDE+LINE", min: 30, sql: "AND r.preferred_side = ? AND ABS(p.strikeout_line - ?) <= 1.0", args: [preferredSide, strikeoutLine] },
    { name: "SIDE", min: 40, sql: "AND r.preferred_side = ?", args: [preferredSide] },
  ];
  for (const scope of scopes) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS sample_size,
        SUM(CASE WHEN (r.preferred_side = 'More' AND pr.result = 'OVER')
          OR (r.preferred_side = 'Less' AND pr.result = 'UNDER') THEN 1 ELSE 0 END) AS wins
      FROM recommendations r
      JOIN props p ON p.prop_id = r.prop_id
      JOIN boards b ON b.board_id = p.board_id
      JOIN prop_results pr ON pr.prop_id = p.prop_id
      WHERE b.board_date < ? AND pr.result_status <> 'PENDING'
        AND pr.result IN ('OVER', 'UNDER') AND r.preferred_side IN ('More', 'Less')
        ${scope.sql}
    `).bind(boardDate, ...scope.args).first<{ sample_size: number; wins: number }>();
    const sample = Number(row?.sample_size ?? 0);
    const wins = Number(row?.wins ?? 0);
    if (sample >= scope.min) {
      const hitRate = wins / sample;
      const priorWeight = 30;
      const adjustedHitRate = (wins + priorWeight * 0.5) / (sample + priorWeight);
      return {
        sample_size: sample, wins, hit_rate: hitRate, adjusted_hit_rate: adjustedHitRate,
        score_adjustment: Math.round(clamp((adjustedHitRate - 0.5) * 24, -4, 4)), scope: scope.name,
      };
    }
  }
  return { sample_size: 0, wins: 0, hit_rate: null, adjusted_hit_rate: null, score_adjustment: 0, scope: "INSUFFICIENT" };
}

function applyCalibrationToV13(v13: ReturnType<typeof scoreRecommendationV13>, adjustment: number) {
  // V13.1 coherence rule: the visible confidence score must agree with the
  // recommendation's eligibility, tier, and final decision. Calibration may
  // adjust a score, but a pick cannot display PLAY-level confidence unless it
  // actually passes the PLAY gates, and it cannot display ELITE confidence
  // unless it passes the CORE gates.
  let score = Math.round(clamp(v13.score + clamp(adjustment, -3, 3), 0, 100));

  const hardConflict = v13.blockers.includes("SIDE_UNAVAILABLE") || v13.blockers.includes("INSUFFICIENT_SAMPLE");
  const unstableRole = v13.blockers.includes("UNSTABLE_ROLE");
  const playEligible = v13.eligibility.morePlayEligible || v13.eligibility.lessPlayEligible;
  const coreGateEligible = v13.eligibility.coreEligible;

  if (hardConflict) score = Math.min(score, 39);
  if (unstableRole) score = Math.min(score, 44);

  // Keep confidence, tier, and decision on one ladder:
  // 84-100 = CORE / PLAY, 74-83 = SECONDARY / PLAY,
  // 64-73 = LEAN / LEAN, 48-63 = WATCH, below 48 = PASS.
  if (!hardConflict && !playEligible) score = Math.min(score, 73);
  if (!hardConflict && playEligible && !coreGateEligible) score = Math.min(score, 83);

  const band = hardConflict ? "AUTO PASS"
    : coreGateEligible && score >= 84 ? "CORE CANDIDATE"
    : playEligible && score >= 74 ? "STRONG LEAN"
    : score >= 64 ? "LEAN"
    : score >= 48 ? "WATCH"
    : "PASS";
  const modelDecision = band === "CORE CANDIDATE" || band === "STRONG LEAN" ? "PLAY"
    : band === "LEAN" ? "LEAN"
    : band === "WATCH" ? "WATCH"
    : band === "AUTO PASS" ? "AUTO PASS" : "PASS";
  const decisionTier = band === "CORE CANDIDATE" ? "CORE"
    : band === "STRONG LEAN" ? "SECONDARY"
    : band === "LEAN" ? "LEAN" : modelDecision;

  return { ...v13, score, band, modelDecision, decisionTier };
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
    const finalReason = `WATCH: insufficient sample â€” ${sampleLabel}. No normal projection was generated.`;

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
  const matchupProjectedStrikeouts = baselineProjection * matchupMultiplier;
  const sameOpponent = await getSameOpponentHistory(
    env, prop.pitcher_id, prop.opponent_team_id, prop.board_date, strikeoutRate, averageBf,
  );
  const projectedStrikeouts = matchupProjectedStrikeouts + sameOpponent.adjustment;
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

  const rawV13 = scoreRecommendationV13({
    modelEdge,
    estimatedOverRate,
    formDelta,
    recentFormGate,
    volumeGate,
    matchupGate,
    roleGate,
    completenessScore,
    availableSide: prop.available_side,
    preferredSide: classification.preferredSide,
    usableStarts: validStarts.length,
  });
  const calibration = await getHistoricalCalibration(
    env, prop.board_date, classification.preferredSide, Number(prop.strikeout_line), prop.prop_type,
  );
  const v13 = applyCalibrationToV13(rawV13, calibration.score_adjustment);
  for (const blocker of v13.blockers) negativeFactors.push(`V13 blocker: ${blocker.replaceAll("_", " ").toLowerCase()}`);
  if (sameOpponent.start_count >= 2 && sameOpponent.adjustment !== 0) {
    const text = `Same-opponent history (${sameOpponent.start_count} starts) adjusted projection ${sameOpponent.adjustment >= 0 ? "+" : ""}${sameOpponent.adjustment.toFixed(2)} K`;
    if (sameOpponent.adjustment > 0) positiveFactors.push(text); else negativeFactors.push(text);
  }
  if (calibration.sample_size > 0 && calibration.score_adjustment !== 0) {
    const text = `Historical calibration ${calibration.score_adjustment >= 0 ? "+" : ""}${calibration.score_adjustment} score (${calibration.scope}, n=${calibration.sample_size}, ${(Number(calibration.hit_rate) * 100).toFixed(1)}% hit)`;
    if (calibration.score_adjustment > 0) positiveFactors.push(text); else negativeFactors.push(text);
  }

  const projectionStatus = matchup ? "FULL" : "PARTIAL";
  const matchupText = matchup
    ? ` Opponent: season vs ${prop.throws_hand}HP ${(matchup.season_opponent_k_rate * 100).toFixed(1)}%, ` +
      `L30 ${matchup.recent_30_k_rate === null ? "n/a" : `${(matchup.recent_30_k_rate * 100).toFixed(1)}%`}, ` +
      `L14 ${matchup.recent_14_k_rate === null ? "n/a" : `${(matchup.recent_14_k_rate * 100).toFixed(1)}%`}, ` +
      `blended ${(matchup.opponent_k_rate * 100).toFixed(1)}% (${matchup.opponent_sample_confidence} confidence).`
    : " Opponent handedness and trend adjustment unavailable.";
  const volumeText = ` Volume: ${averageBf.toFixed(1)} BF, ${averagePitchCount === null ? "n/a" : averagePitchCount.toFixed(0)} pitches, ${Math.round(starterRate * 100)}% starter rate.`;
  const formText = ` Form: L3 ${l3KAvg.toFixed(1)}, L5 ${l5KAvg.toFixed(1)}, L10 ${l10KAvg.toFixed(1)} (${recentFormGate}).`;
  const historyText = sameOpponent.start_count >= 2
    ? ` Same opponent: ${sameOpponent.start_count} prior starts, ${sameOpponent.k_avg?.toFixed(1) ?? "n/a"} K average, ${sameOpponent.adjustment >= 0 ? "+" : ""}${sameOpponent.adjustment.toFixed(2)} K adjustment.`
    : ` Same opponent: ${sameOpponent.start_count} prior start${sameOpponent.start_count === 1 ? "" : "s"}; informational only.`;
  const calibrationText = calibration.sample_size > 0
    ? ` Calibration: ${calibration.scope}, n=${calibration.sample_size}, ${(Number(calibration.hit_rate) * 100).toFixed(1)}% raw hit rate, ${calibration.score_adjustment >= 0 ? "+" : ""}${calibration.score_adjustment} score.`
    : " Calibration: insufficient historical sample; no adjustment.";
  const finalReason =
    `${v13.band} (${v13.score}/100): projection ${projectedStrikeouts.toFixed(1)} ` +
    `versus line ${Number(prop.strikeout_line).toFixed(1)} ` +
    `(${modelEdge >= 0 ? "+" : ""}${modelEdge.toFixed(1)} edge).` +
    formText + volumeText + matchupText + historyText + calibrationText;

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
        same_opponent_start_count,
        same_opponent_k_avg,
        same_opponent_bf_avg,
        same_opponent_adjustment,
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
        ?, ?, ?, ?,
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
      sameOpponent.start_count,
      sameOpponent.k_avg,
      sameOpponent.bf_avg,
      sameOpponent.adjustment,
      recentFormGate,
      volumeGate,
      roleGate,
      matchupGate,
    ),
    env.DB.prepare(`
      INSERT INTO recommendations (
        prop_id, model_version_id, projected_strikeouts, base_projected_strikeouts, matchup_projected_strikeouts,
        same_opponent_adjustment, calibration_adjustment, calibration_sample_size, calibration_hit_rate, model_edge,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, COALESCE((SELECT final_classification FROM recommendations WHERE prop_id = ? AND model_version_id = ?), ?),
              ?, COALESCE((SELECT recommended_line FROM recommendations WHERE prop_id = ? AND model_version_id = ?), ?), ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CURRENT_TIMESTAMP)
      ON CONFLICT(prop_id, model_version_id) DO UPDATE SET
        projected_strikeouts = excluded.projected_strikeouts,
        base_projected_strikeouts = excluded.base_projected_strikeouts,
        matchup_projected_strikeouts = excluded.matchup_projected_strikeouts,
        same_opponent_adjustment = excluded.same_opponent_adjustment,
        calibration_adjustment = excluded.calibration_adjustment,
        calibration_sample_size = excluded.calibration_sample_size,
        calibration_hit_rate = excluded.calibration_hit_rate,
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
      baselineProjection,
      matchupProjectedStrikeouts,
      sameOpponent.adjustment,
      calibration.score_adjustment,
      calibration.sample_size,
      calibration.hit_rate,
      modelEdge,
      estimatedOverRate,
      classification.preferredSide,
      Math.abs(modelEdge) >= 1 ? "STRONG" : Math.abs(modelEdge) >= 0.5 ? "FAIR" : "THIN",
      projectionStatus,
      v13.score,
      v13.score >= 84 ? "ELITE" : v13.score >= 74 ? "HIGH" : v13.score >= 64 ? "MEDIUM" : "LOW",
      String(classification.confidenceCap),
      classification.coreBlockCount,
      v13.decisionTier,
      v13.modelDecision,
      v13.modelDecision,
      JSON.stringify(positiveFactors),
      JSON.stringify(negativeFactors),
      finalReason,
      v13.band,
      prop.prop_id,
      modelVersionId,
      v13.band,
      prop.strikeout_line,
      prop.prop_id,
      modelVersionId,
      prop.strikeout_line,
      prop.prop_type,
      completenessScore,
      v13.score,
      v13.band,
      v13.components.projection,
      v13.components.recent_form,
      v13.components.volume,
      v13.components.matchup,
      v13.components.role,
      v13.components.completeness,
      JSON.stringify({
        components: v13.components,
        blockers: v13.blockers,
        base_score: rawV13.score,
        calibration,
        same_opponent: sameOpponent,
        projections: { base: baselineProjection, matchup: matchupProjectedStrikeouts, final: projectedStrikeouts },
      }),
    ),
  ]);
}


interface RuntimeModelVersion {
  model_version_id: number;
  version_name: string;
  model_role: "PRODUCTION" | "CHALLENGER" | "ARCHIVED" | "DISABLED";
  code_identifier: string | null;
  execution_enabled: number;
  execution_priority: number;
  shadow_source_model_version_id: number | null;
}

function normalizePredictionSide(side: string | null): "MORE" | "LESS" | "NONE" {
  if (side === "More") return "MORE";
  if (side === "Less") return "LESS";
  return "NONE";
}

type SnapshotQualityGrade = "A" | "B" | "C" | "D" | "F";
type SnapshotQualityGate = "PASS" | "CAUTION" | "BLOCK";

interface SnapshotQualityEvaluation {
  score: number;
  grade: SnapshotQualityGrade;
  gate: SnapshotQualityGate;
  eligible: number;
  flags: string[];
  criticalFlags: string[];
}

function numericFeature(row: Record<string, unknown> | null, key: string): number | null {
  if (!row || row[key] === null || row[key] === undefined || row[key] === "") return null;
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function isoDayGap(laterDate: string, earlierDate: unknown): number | null {
  const earlier = String(earlierDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(laterDate) || !/^\d{4}-\d{2}-\d{2}$/.test(earlier)) return null;
  const laterMs = Date.parse(`${laterDate}T00:00:00Z`);
  const earlierMs = Date.parse(`${earlier}T00:00:00Z`);
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
  return Math.max(0, Math.round((laterMs - earlierMs) / 86400000));
}

function evaluateSnapshotDataQuality(
  prop: ProcessPropRow,
  pitcherFeature: Record<string, unknown> | null,
  teamFeature: Record<string, unknown> | null,
  legacyFeature: Record<string, unknown> | null,
  pitcherHand: "L" | "R" | null,
): SnapshotQualityEvaluation {
  let score = 100;
  const flags: string[] = [];
  const criticalFlags: string[] = [];
  const add = (flag: string, penalty: number, critical = false) => {
    if (!flags.includes(flag)) flags.push(flag);
    if (critical && !criticalFlags.includes(flag)) criticalFlags.push(flag);
    score -= penalty;
  };

  if (!pitcherHand) add("PITCHER_HAND_MISSING", 25, true);
  if (!pitcherFeature) add("PITCHER_FEATURES_MISSING", 45, true);
  if (!teamFeature) add("TEAM_FEATURES_MISSING", 25, true);
  if (!legacyFeature) add("LEGACY_CONTEXT_MISSING", 5);

  if (pitcherFeature) {
    const quality = numericFeature(pitcherFeature, "data_quality_score");
    if (quality !== null) score -= Math.round(Math.max(0, 100 - quality) * 0.35);
    const seasonStarts = numericFeature(pitcherFeature, "season_starts") ?? 0;
    const last5Starts = numericFeature(pitcherFeature, "last5_starts") ?? 0;
    if (seasonStarts < 5) add("PITCHER_SEASON_SAMPLE_VERY_SMALL", 15);
    else if (seasonStarts < 10) add("PITCHER_SEASON_SAMPLE_SMALL", 8);
    if (last5Starts < 5) add("PITCHER_RECENT_SAMPLE_INCOMPLETE", 5);
    const gap = isoDayGap(prop.board_date, pitcherFeature.as_of_date);
    if (gap !== null && gap > 1) add("PITCHER_FEATURES_STALE", Math.min(15, (gap - 1) * 5));
  }

  if (teamFeature) {
    const quality = numericFeature(teamFeature, "data_quality_score");
    if (quality !== null) score -= Math.round(Math.max(0, 100 - quality) * 0.35);
    const last30Pa = numericFeature(teamFeature, "last30_plate_appearances") ?? 0;
    const last7Pa = numericFeature(teamFeature, "last7_plate_appearances") ?? 0;
    const stability = String(teamFeature.stability_status ?? "").toUpperCase();
    if (last30Pa < 100) add("TEAM_30D_SAMPLE_VERY_SMALL", 15);
    else if (last30Pa < 200) add("TEAM_30D_SAMPLE_SMALL", 8);
    if (last7Pa < 25) add("TEAM_7D_SAMPLE_SMALL", 5);
    if (stability === "LOW") add("TEAM_SPLIT_STABILITY_LOW", 10);
    else if (stability === "MEDIUM") add("TEAM_SPLIT_STABILITY_MEDIUM", 4);
    const gap = isoDayGap(prop.board_date, teamFeature.as_of_date);
    if (gap !== null && gap > 1) add("TEAM_FEATURES_STALE", Math.min(15, (gap - 1) * 5));
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade: SnapshotQualityGrade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const gate: SnapshotQualityGate = criticalFlags.length > 0 || score < 60 ? "BLOCK" : score < 85 ? "CAUTION" : "PASS";
  return { score, grade, gate, eligible: gate !== "BLOCK" && score >= 75 ? 1 : 0, flags, criticalFlags };
}

async function capturePropFeatureSnapshot(
  env: Env,
  prop: ProcessPropRow,
  modelVersionId: number,
): Promise<number> {
  const pitcherFeature = await env.DB.prepare(`
    SELECT *
    FROM pitcher_daily_features
    WHERE pitcher_id = ? AND as_of_date <= ?
    ORDER BY as_of_date DESC, pitcher_daily_feature_id DESC
    LIMIT 1
  `).bind(prop.pitcher_id, prop.board_date).first<Record<string, unknown>>();

  const rawPitcherHand = String(prop.throws_hand ?? "").trim().toUpperCase();
  const pitcherHand: "L" | "R" | null = rawPitcherHand.startsWith("L") ? "L" : rawPitcherHand.startsWith("R") ? "R" : null;

  // Legacy boards may contain an opponent_team_id that was populated while
  // foreign-key enforcement was relaxed. Snapshot capture must not let that
  // legacy bookkeeping issue break the production board-processing path.
  const resolvedOpponent = prop.opponent_team_id === null ? null : await env.DB.prepare(`
    SELECT team_id
    FROM teams
    WHERE team_id = ?
    LIMIT 1
  `).bind(prop.opponent_team_id).first<{ team_id: number }>();
  const snapshotOpponentTeamId = resolvedOpponent ? Number(resolvedOpponent.team_id) : null;

  const teamFeature = snapshotOpponentTeamId === null ? null : await env.DB.prepare(`
    SELECT *
    FROM team_daily_features
    WHERE team_id = ? AND pitcher_hand = ? AND as_of_date <= ?
    ORDER BY as_of_date DESC, team_daily_feature_id DESC
    LIMIT 1
  `).bind(snapshotOpponentTeamId, pitcherHand, prop.board_date).first<Record<string, unknown>>();

  const legacyFeature = await env.DB.prepare(`
    SELECT *
    FROM feature_snapshots
    WHERE prop_id = ? AND model_version_id = ?
    ORDER BY snapshot_time DESC, feature_snapshot_id DESC
    LIMIT 1
  `).bind(prop.prop_id, modelVersionId).first<Record<string, unknown>>();

  const missing: string[] = [];
  if (!pitcherHand) missing.push("pitcher_hand");
  if (!pitcherFeature) missing.push("pitcher_daily_features");
  if (!teamFeature) missing.push("team_daily_features");
  if (!legacyFeature) missing.push("legacy_feature_snapshot");
  const snapshotStatus = pitcherFeature && teamFeature && pitcherHand ? "COMPLETE"
    : pitcherFeature || teamFeature || legacyFeature ? "PARTIAL"
    : "INSUFFICIENT";
  const quality = evaluateSnapshotDataQuality(prop, pitcherFeature ?? null, teamFeature ?? null, legacyFeature ?? null, pitcherHand);

  const insert = await env.DB.prepare(`
    INSERT INTO prop_feature_snapshots (
      snapshot_uuid, prop_id, board_id, model_version_id,
      captured_at, information_cutoff_at, board_date, prop_line,
      available_side, prop_type, pitcher_id, opponent_team_id, pitcher_hand,
      pitcher_daily_feature_id, team_daily_feature_id, legacy_feature_snapshot_id,
      pitcher_feature_as_of_date, team_feature_as_of_date,
      pitcher_source_cutoff_date, team_source_cutoff_date,
      pitcher_data_quality_score, team_data_quality_score,
      snapshot_status, missing_features_json,
      overall_data_quality_score, data_quality_grade, quality_gate, challenger_eligible,
      quality_flags_json, critical_quality_flags_json, quality_policy_version,
      pitcher_features_json, team_features_json, legacy_features_json, context_json
    ) VALUES (
      ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    crypto.randomUUID(),
    prop.prop_id,
    prop.board_id,
    modelVersionId,
    prop.board_date,
    Number(prop.strikeout_line),
    prop.available_side,
    prop.prop_type,
    prop.pitcher_id,
    snapshotOpponentTeamId,
    pitcherHand,
    pitcherFeature ? Number(pitcherFeature.pitcher_daily_feature_id) : null,
    teamFeature ? Number(teamFeature.team_daily_feature_id) : null,
    legacyFeature ? Number(legacyFeature.feature_snapshot_id) : null,
    pitcherFeature ? String(pitcherFeature.as_of_date ?? "") : null,
    teamFeature ? String(teamFeature.as_of_date ?? "") : null,
    pitcherFeature ? String(pitcherFeature.source_cutoff_date ?? "") : null,
    teamFeature ? String(teamFeature.source_cutoff_date ?? "") : null,
    pitcherFeature?.data_quality_score === undefined ? null : Number(pitcherFeature.data_quality_score),
    teamFeature?.data_quality_score === undefined ? null : Number(teamFeature.data_quality_score),
    snapshotStatus,
    JSON.stringify(missing),
    quality.score,
    quality.grade,
    quality.gate,
    quality.eligible,
    JSON.stringify(quality.flags),
    JSON.stringify(quality.criticalFlags),
    "prop-quality-v1",
    pitcherFeature ? JSON.stringify(pitcherFeature) : null,
    teamFeature ? JSON.stringify(teamFeature) : null,
    legacyFeature ? JSON.stringify(legacyFeature) : null,
    JSON.stringify({
      feature_store_version: "prop-snapshot-v1",
      board_date: prop.board_date,
      pitcher_name: prop.canonical_name,
      mlb_pitcher_id: prop.mlb_id,
      raw_opponent_team_id: prop.opponent_team_id,
      resolved_opponent_team_id: snapshotOpponentTeamId,
      source_rule: "latest feature row with as_of_date <= board_date",
      quality_policy_version: "prop-quality-v1",
      quality_gate: quality.gate,
      immutable: true,
    }),
  ).run();

  const snapshotId = Number(insert.meta.last_row_id);
  if (!snapshotId) throw new Error(`Unable to create prop feature snapshot for prop ${prop.prop_id}.`);
  return snapshotId;
}

async function getPropFeatureSnapshotStatus(env: Env, url: URL): Promise<Response> {
  const boardDate = url.searchParams.get("date")?.trim() || null;
  const summary = await env.DB.prepare(`
    SELECT
      COUNT(*) AS snapshot_count,
      SUM(CASE WHEN snapshot_status='COMPLETE' THEN 1 ELSE 0 END) AS complete_count,
      SUM(CASE WHEN snapshot_status='PARTIAL' THEN 1 ELSE 0 END) AS partial_count,
      SUM(CASE WHEN snapshot_status='INSUFFICIENT' THEN 1 ELSE 0 END) AS insufficient_count,
      SUM(CASE WHEN quality_gate='PASS' THEN 1 ELSE 0 END) AS quality_pass_count,
      SUM(CASE WHEN quality_gate='CAUTION' THEN 1 ELSE 0 END) AS quality_caution_count,
      SUM(CASE WHEN quality_gate='BLOCK' THEN 1 ELSE 0 END) AS quality_block_count,
      ROUND(AVG(overall_data_quality_score),1) AS average_quality_score,
      MAX(captured_at) AS last_captured_at
    FROM prop_feature_snapshots
    WHERE (? IS NULL OR board_date = ?)
  `).bind(boardDate, boardDate).first<Record<string, unknown>>();

  const rows = await env.DB.prepare(`
    SELECT
      pfs.prop_feature_snapshot_id, pfs.snapshot_uuid, pfs.prop_id, pfs.board_id,
      pfs.board_date, pfs.prop_line, pfs.pitcher_hand, pfs.snapshot_status,
      pfs.pitcher_feature_as_of_date, pfs.team_feature_as_of_date,
      pfs.pitcher_data_quality_score, pfs.team_data_quality_score,
      pfs.overall_data_quality_score, pfs.data_quality_grade, pfs.quality_gate,
      pfs.challenger_eligible, pfs.quality_flags_json, pfs.critical_quality_flags_json,
      pfs.quality_policy_version, pfs.missing_features_json, pfs.captured_at,
      pi.canonical_name AS pitcher_name,
      t.abbreviation AS opponent
    FROM prop_feature_snapshots pfs
    JOIN pitchers pi ON pi.pitcher_id = pfs.pitcher_id
    LEFT JOIN teams t ON t.team_id = pfs.opponent_team_id
    WHERE (? IS NULL OR pfs.board_date = ?)
    ORDER BY pfs.captured_at DESC, pfs.prop_feature_snapshot_id DESC
    LIMIT 100
  `).bind(boardDate, boardDate).all<Record<string, unknown>>();

  return json({ summary: summary ?? {}, snapshots: rows.results });
}

async function capturePredictionLedger(
  env: Env,
  prop: ProcessPropRow,
  sourceModelVersionId: number,
  targetModel: RuntimeModelVersion,
  predictionMode: "PRODUCTION" | "SHADOW",
  propFeatureSnapshotId: number | null = null,
): Promise<void> {
  const recommendation = await env.DB.prepare(`
    SELECT
      r.projected_strikeouts,
      r.model_edge,
      r.estimated_over_rate,
      r.preferred_side,
      r.model_decision,
      r.recommendation_score,
      r.recommendation_band,
      r.projection_status,
      r.completeness_score,
      r.score_explanation,
      r.generated_at
    FROM recommendations r
    WHERE r.prop_id = ? AND r.model_version_id = ?
    LIMIT 1
  `).bind(prop.prop_id, sourceModelVersionId).first<{
    projected_strikeouts: number | null;
    model_edge: number | null;
    estimated_over_rate: number | null;
    preferred_side: string | null;
    model_decision: string | null;
    recommendation_score: number | null;
    recommendation_band: string | null;
    projection_status: string | null;
    completeness_score: number | null;
    score_explanation: string | null;
    generated_at: string | null;
  }>();

  if (!recommendation) {
    throw new Error(`Production recommendation is unavailable for prop ${prop.prop_id}.`);
  }

  const snapshot = await env.DB.prepare(`
    SELECT *
    FROM feature_snapshots
    WHERE prop_id = ? AND model_version_id = ?
    ORDER BY snapshot_time DESC, feature_snapshot_id DESC
    LIMIT 1
  `).bind(prop.prop_id, sourceModelVersionId).first<Record<string, unknown>>();

  const predictionUuid = crypto.randomUUID();
  const rawMore = recommendation.estimated_over_rate === null
    ? null
    : clamp(Number(recommendation.estimated_over_rate), 0, 1);
  const rawLess = rawMore === null ? null : 1 - rawMore;
  const preferredSide = normalizePredictionSide(recommendation.preferred_side);
  const dataQualityStatus = recommendation.projection_status === "FULL"
    ? "COMPLETE"
    : recommendation.projection_status === "INSUFFICIENT_SAMPLE"
      ? "INSUFFICIENT_SAMPLE"
      : "PARTIAL";

  const insert = await env.DB.prepare(`
    INSERT INTO model_predictions (
      prediction_uuid, prop_id, model_version_id, feature_snapshot_id, prop_feature_snapshot_id,
      prediction_mode, prediction_status, predicted_at, information_cutoff_at,
      prop_line, projected_strikeouts, raw_more_probability, raw_less_probability,
      calibrated_more_probability, calibrated_less_probability, preferred_side,
      model_edge, decision, confidence_score, confidence_label,
      data_quality_status, source_fingerprint, input_hash, output_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'COMPLETE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    predictionUuid,
    prop.prop_id,
    targetModel.model_version_id,
    predictionMode === "PRODUCTION" && snapshot ? Number(snapshot.feature_snapshot_id) : null,
    propFeatureSnapshotId,
    predictionMode,
    Number(prop.strikeout_line),
    recommendation.projected_strikeouts,
    rawMore,
    rawLess,
    rawMore,
    rawLess,
    preferredSide,
    recommendation.model_edge,
    recommendation.model_decision,
    recommendation.recommendation_score,
    recommendation.recommendation_band,
    dataQualityStatus,
    `recommendations:${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}`,
    `${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}`,
    JSON.stringify({
      adapter: predictionMode === "SHADOW" ? "production_mirror_v1" : "production_capture_v1",
      source_model_version_id: sourceModelVersionId,
      target_model_version_id: targetModel.model_version_id,
      recommendation,
    }),
  ).run();

  const predictionId = Number(insert.meta.last_row_id);
  if (!predictionId || !snapshot) return;

  const excluded = new Set(["feature_snapshot_id", "prop_id", "model_version_id", "snapshot_time"]);
  const statements: D1PreparedStatement[] = [];
  for (const [featureName, value] of Object.entries(snapshot)) {
    if (excluded.has(featureName)) continue;
    let valueType: "REAL" | "INTEGER" | "TEXT" | "BOOLEAN" | "JSON" | "NULL" = "NULL";
    let valueReal: number | null = null;
    let valueInteger: number | null = null;
    let valueText: string | null = null;
    let valueJson: string | null = null;

    if (value === null || value === undefined) {
      valueType = "NULL";
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        valueType = "INTEGER";
        valueInteger = value;
      } else {
        valueType = "REAL";
        valueReal = value;
      }
    } else if (typeof value === "boolean") {
      valueType = "BOOLEAN";
      valueInteger = value ? 1 : 0;
    } else if (typeof value === "string") {
      valueType = "TEXT";
      valueText = value;
    } else {
      valueType = "JSON";
      valueJson = JSON.stringify(value);
    }

    statements.push(env.DB.prepare(`
      INSERT INTO model_feature_values (
        model_prediction_id, feature_name, feature_group, value_type,
        value_real, value_integer, value_text, value_json,
        source_name, source_record_key, source_observed_at
      ) VALUES (?, ?, 'legacy_feature_snapshot', ?, ?, ?, ?, ?, 'feature_snapshots', ?, ?)
    `).bind(
      predictionId,
      featureName,
      valueType,
      valueReal,
      valueInteger,
      valueText,
      valueJson,
      String(snapshot.feature_snapshot_id),
      String(snapshot.snapshot_time ?? recommendation.generated_at ?? ""),
    ));
  }
  if (statements.length) await env.DB.batch(statements);
}


interface V14CalibrationSummary {
  training_rows: number;
  wins: number;
  observed_hit_rate: number;
  calibrated_probability: number;
  raw_preferred_probability: number;
  bucket_low: number;
  bucket_high: number;
  bucket_width: number;
  side: "MORE" | "LESS";
  dataset_build_id: number | null;
  fallback_level: "NARROW_BUCKET" | "WIDE_BUCKET" | "SIDE_POOL" | "CONSERVATIVE_PRIOR";
}

async function getV14BaselineCalibration(
  env: Env,
  boardDate: string,
  side: "MORE" | "LESS",
  rawPreferredProbability: number,
): Promise<V14CalibrationSummary> {
  const build = await env.DB.prepare(`
    SELECT backtest_dataset_build_id
    FROM backtest_dataset_builds
    WHERE status='SUCCEEDED' AND dataset_mode='CERTIFIED'
    ORDER BY backtest_dataset_build_id DESC
    LIMIT 1
  `).first<{ backtest_dataset_build_id: number }>();

  const buildId = build ? Number(build.backtest_dataset_build_id) : null;
  const raw = clamp(rawPreferredProbability, 0.5, 0.999999);
  const preferredProbExpr = side === "MORE"
    ? "COALESCE(raw_more_probability, calibrated_more_probability)"
    : "COALESCE(raw_less_probability, calibrated_less_probability)";

  const attempts: Array<{ width: number; fallback: V14CalibrationSummary["fallback_level"] }> = [
    { width: 0.05, fallback: "NARROW_BUCKET" },
    { width: 0.10, fallback: "WIDE_BUCKET" },
  ];

  if (buildId !== null) {
    for (const attempt of attempts) {
      const low = Math.max(0.5, Math.floor(raw / attempt.width) * attempt.width);
      const high = Math.min(1.000001, low + attempt.width);
      const row = await env.DB.prepare(`
        SELECT
          COUNT(*) AS n,
          SUM(CASE WHEN preferred_outcome='WIN' THEN 1 ELSE 0 END) AS wins
        FROM backtest_dataset_rows_v3
        WHERE backtest_dataset_build_id=?
          AND backtest_eligible=1
          AND board_date < ?
          AND preferred_side=?
          AND preferred_outcome IN ('WIN','LOSS')
          AND ${preferredProbExpr} >= ?
          AND ${preferredProbExpr} < ?
      `).bind(buildId, boardDate, side, low, high).first<{ n: number; wins: number }>();
      const n = Number(row?.n ?? 0);
      const wins = Number(row?.wins ?? 0);
      if (n >= 40) {
        // Mild beta-binomial shrinkage toward 50%, then a hard baseline cap.
        const observed = wins / n;
        const calibrated = clamp((wins + 10) / (n + 20), 0.50, 0.70);
        return {
          training_rows: n, wins, observed_hit_rate: observed,
          calibrated_probability: calibrated, raw_preferred_probability: raw,
          bucket_low: low, bucket_high: high, bucket_width: attempt.width,
          side, dataset_build_id: buildId, fallback_level: attempt.fallback,
        };
      }
    }

    const pooled = await env.DB.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN preferred_outcome='WIN' THEN 1 ELSE 0 END) AS wins
      FROM backtest_dataset_rows_v3
      WHERE backtest_dataset_build_id=?
        AND backtest_eligible=1
        AND board_date < ?
        AND preferred_side=?
        AND preferred_outcome IN ('WIN','LOSS')
    `).bind(buildId, boardDate, side).first<{ n: number; wins: number }>();
    const n = Number(pooled?.n ?? 0);
    const wins = Number(pooled?.wins ?? 0);
    if (n >= 40) {
      const observed = wins / n;
      const calibrated = clamp((wins + 20) / (n + 40), 0.50, 0.62);
      return {
        training_rows: n, wins, observed_hit_rate: observed,
        calibrated_probability: calibrated, raw_preferred_probability: raw,
        bucket_low: 0.5, bucket_high: 1.0, bucket_width: 0.5,
        side, dataset_build_id: buildId, fallback_level: "SIDE_POOL",
      };
    }
  }

  return {
    training_rows: 0, wins: 0, observed_hit_rate: 0.5,
    calibrated_probability: 0.52, raw_preferred_probability: raw,
    bucket_low: 0.5, bucket_high: 1.0, bucket_width: 0.5,
    side, dataset_build_id: buildId, fallback_level: "CONSERVATIVE_PRIOR",
  };
}


interface V14AdaptiveEvidence {
  dimension: string;
  bucket: string;
  n: number;
  wins: number;
  posterior_hit_rate: number;
  reliability: number;
  weight: number;
}

interface V14AdaptiveSelection {
  baseline_probability: number;
  adaptive_probability: number;
  selection_score: number;
  decision: "PLAY" | "WATCH";
  uncertainty_penalty: number;
  evidence_count: number;
  evidence: V14AdaptiveEvidence[];
  policy: string;
}

type V14AdaptiveHistoryRow = {
  board_date: string;
  preferred_side: string | null;
  preferred_outcome: string | null;
  model_edge: number | null;
  prop_line: number;
  pitcher_hand: string | null;
};

function adaptivePosterior(rows: V14AdaptiveHistoryRow[]): { n:number; wins:number; posterior:number } {
  const graded = rows.filter(r => ['WIN','LOSS'].includes(String(r.preferred_outcome ?? '').toUpperCase()));
  const wins = graded.filter(r => String(r.preferred_outcome ?? '').toUpperCase() === 'WIN').length;
  const n = graded.length;
  // Beta(25,25) prior: enough shrinkage to stop a short hot/cold segment from dominating selection.
  return { n, wins, posterior: n ? (wins + 25) / (n + 50) : 0.5 };
}

function calculateV14AdaptiveSelection(
  priorRows: V14AdaptiveHistoryRow[],
  target: { preferred_side:string|null; model_edge:number|null; prop_line:number; pitcher_hand:string|null },
  baselineProbability: number,
): V14AdaptiveSelection {
  const side = String(target.preferred_side ?? '').toUpperCase();
  const targetEdge = edgeBucket(target.model_edge);
  const targetLine = lineBucket(Number(target.prop_line));
  const targetHand = String(target.pitcher_hand ?? '').toUpperCase() || 'UNKNOWN';
  const specs = [
    { dimension:'Side × edge', bucket:`${side} · ${targetEdge}`, min:50, weight:0.45, filter:(r:V14AdaptiveHistoryRow)=>String(r.preferred_side??'').toUpperCase()===side && edgeBucket(r.model_edge)===targetEdge },
    { dimension:'Side × line', bucket:`${side} · ${targetLine}`, min:60, weight:0.25, filter:(r:V14AdaptiveHistoryRow)=>String(r.preferred_side??'').toUpperCase()===side && lineBucket(Number(r.prop_line))===targetLine },
    { dimension:'Absolute edge', bucket:targetEdge, min:75, weight:0.20, filter:(r:V14AdaptiveHistoryRow)=>edgeBucket(r.model_edge)===targetEdge },
    { dimension:'Pitcher hand', bucket:targetHand, min:100, weight:0.10, filter:(r:V14AdaptiveHistoryRow)=>String(r.pitcher_hand??'').toUpperCase()===targetHand },
  ];
  const evidence:V14AdaptiveEvidence[]=[];
  let weightedDelta=0, weightTotal=0;
  for(const spec of specs){
    const st=adaptivePosterior(priorRows.filter(spec.filter));
    if(st.n < spec.min) continue;
    const reliability=Math.min(1, st.n / (spec.min * 2));
    const effectiveWeight=spec.weight * reliability;
    weightedDelta += effectiveWeight * (st.posterior - baselineProbability);
    weightTotal += effectiveWeight;
    evidence.push({dimension:spec.dimension,bucket:spec.bucket,n:st.n,wins:st.wins,posterior_hit_rate:st.posterior,reliability,weight:spec.weight});
  }
  const blendedDelta = weightTotal > 0 ? weightedDelta / weightTotal : 0;
  // Preserve Build 5.1 calibration as the anchor. Segment evidence can move it, but only partially.
  const adaptiveProbability = clamp(baselineProbability + 0.65 * blendedDelta, 0.50, 0.62);
  const uncertaintyPenalty = evidence.length >= 3 ? 0.005 : evidence.length === 2 ? 0.010 : 0.015;
  const selectionScore = clamp(adaptiveProbability - uncertaintyPenalty, 0.50, 0.62);
  const decision = evidence.length > 0 && selectionScore >= 0.55 ? 'PLAY' : 'WATCH';
  return {
    baseline_probability: baselineProbability,
    adaptive_probability: adaptiveProbability,
    selection_score: selectionScore,
    decision,
    uncertainty_penalty: uncertaintyPenalty,
    evidence_count: evidence.length,
    evidence,
    policy: 'v14-adaptive-selection-v1',
  };
}

async function getV14AdaptiveHistory(env:Env, boardDate:string, datasetBuildId:number|null):Promise<V14AdaptiveHistoryRow[]> {
  if(datasetBuildId===null) return [];
  return (await env.DB.prepare(`
    SELECT board_date,preferred_side,preferred_outcome,model_edge,prop_line,pitcher_hand
    FROM backtest_dataset_rows_v3
    WHERE backtest_dataset_build_id=?
      AND backtest_eligible=1
      AND board_date < ?
      AND preferred_outcome IN ('WIN','LOSS')
    ORDER BY board_date,backtest_dataset_row_id
  `).bind(datasetBuildId,boardDate).all<V14AdaptiveHistoryRow>()).results ?? [];
}

async function captureV14BaselinePredictionLedger(
  env: Env,
  prop: ProcessPropRow,
  sourceModelVersionId: number,
  targetModel: RuntimeModelVersion,
  propFeatureSnapshotId: number | null,
): Promise<void> {
  const recommendation = await env.DB.prepare(`
    SELECT projected_strikeouts, model_edge, estimated_over_rate, preferred_side,
           model_decision, recommendation_score, recommendation_band,
           projection_status, completeness_score, score_explanation, generated_at
    FROM recommendations
    WHERE prop_id=? AND model_version_id=?
    LIMIT 1
  `).bind(prop.prop_id, sourceModelVersionId).first<{
    projected_strikeouts: number | null; model_edge: number | null; estimated_over_rate: number | null;
    preferred_side: string | null; model_decision: string | null; recommendation_score: number | null;
    recommendation_band: string | null; projection_status: string | null; completeness_score: number | null;
    score_explanation: string | null; generated_at: string | null;
  }>();
  if (!recommendation) throw new Error(`Production recommendation is unavailable for prop ${prop.prop_id}.`);

  const side = normalizePredictionSide(recommendation.preferred_side);
  if (side === "NONE") {
    await env.DB.prepare(`
      INSERT INTO model_predictions(
        prediction_uuid,prop_id,model_version_id,prop_feature_snapshot_id,prediction_mode,prediction_status,
        predicted_at,information_cutoff_at,prop_line,projected_strikeouts,raw_more_probability,raw_less_probability,
        calibrated_more_probability,calibrated_less_probability,preferred_side,model_edge,decision,confidence_score,
        confidence_label,data_quality_status,source_fingerprint,input_hash,output_json,error_message
      ) VALUES(?,?,?,?, 'SHADOW','WITHHELD',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crypto.randomUUID(), prop.prop_id, targetModel.model_version_id, propFeatureSnapshotId,
      Number(prop.strikeout_line), recommendation.projected_strikeouts,
      recommendation.estimated_over_rate === null ? null : clamp(Number(recommendation.estimated_over_rate),0,1),
      recommendation.estimated_over_rate === null ? null : 1-clamp(Number(recommendation.estimated_over_rate),0,1),
      null,null,'NONE',recommendation.model_edge,'WITHHELD',null,'WITHHELD',
      recommendation.projection_status === 'FULL' ? 'COMPLETE' : 'PARTIAL',
      `v14-baseline-withheld:${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}`,
      `${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}:v14-baseline-withheld-nondirectional-v1`,
      JSON.stringify({adapter:'v14_baseline_calibrated_v1',withheld_reason:'SOURCE_NON_DIRECTIONAL',source_model_version_id:sourceModelVersionId,target_model_version_id:targetModel.model_version_id,source_recommendation:recommendation,production_unchanged:true}),
      'Certification-ineligible: source production recommendation is non-directional.'
    ).run();
    return;
  }
  const rawMore = recommendation.estimated_over_rate === null ? 0.5 : clamp(Number(recommendation.estimated_over_rate), 0, 1);
  const rawLess = 1 - rawMore;
  const rawPreferred = side === "MORE" ? rawMore : rawLess;
  const calibration = await getV14BaselineCalibration(env, prop.board_date, side, rawPreferred);
  const preferredCalibrated = calibration.calibrated_probability;
  const calibratedMore = side === "MORE" ? preferredCalibrated : 1 - preferredCalibrated;
  const calibratedLess = 1 - calibratedMore;
  const confidenceScore = Math.round(preferredCalibrated * 1000) / 10;
  const confidenceLabel = preferredCalibrated >= 0.60 ? "MODERATE" : preferredCalibrated >= 0.55 ? "LEAN" : "WATCH";
  const decision = preferredCalibrated >= 0.54 ? "PLAY" : "WATCH";
  const dataQualityStatus = recommendation.projection_status === "FULL" ? "COMPLETE"
    : recommendation.projection_status === "INSUFFICIENT_SAMPLE" ? "INSUFFICIENT_SAMPLE" : "PARTIAL";

  const insert = await env.DB.prepare(`
    INSERT INTO model_predictions(
      prediction_uuid,prop_id,model_version_id,prop_feature_snapshot_id,prediction_mode,prediction_status,
      predicted_at,information_cutoff_at,prop_line,projected_strikeouts,raw_more_probability,raw_less_probability,
      calibrated_more_probability,calibrated_less_probability,preferred_side,model_edge,decision,confidence_score,
      confidence_label,data_quality_status,source_fingerprint,input_hash,output_json
    ) VALUES(?,?,?,?, 'SHADOW','COMPLETE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), prop.prop_id, targetModel.model_version_id, propFeatureSnapshotId,
    Number(prop.strikeout_line), recommendation.projected_strikeouts, rawMore, rawLess,
    calibratedMore, calibratedLess, side, recommendation.model_edge, decision, confidenceScore,
    confidenceLabel, dataQualityStatus,
    `v14-baseline:${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}`,
    `${prop.prop_id}:${sourceModelVersionId}:${recommendation.generated_at ?? "unknown"}:v14-baseline-calibrated-v1`,
    JSON.stringify({
      adapter: "v14_baseline_calibrated_v1",
      source_model_version_id: sourceModelVersionId,
      target_model_version_id: targetModel.model_version_id,
      source_recommendation: recommendation,
      calibration,
      rules: {
        training_cutoff: `board_date < ${prop.board_date}`,
        minimum_bucket_rows: 40,
        beta_shrinkage: true,
        probability_cap: calibration.fallback_level === "SIDE_POOL" ? 0.62 : 0.70,
        play_threshold: 0.54,
        edge_used_as_rank_signal_only: true,
        production_unchanged: true,
      },
    }),
  ).run();

  const predictionId = Number(insert.meta.last_row_id);
  if (!predictionId) return;
  const derived: Array<[string,string,number | string]> = [
    ["v14.raw_preferred_probability","REAL",rawPreferred],
    ["v14.calibrated_preferred_probability","REAL",preferredCalibrated],
    ["v14.calibration_training_rows","INTEGER",calibration.training_rows],
    ["v14.calibration_observed_hit_rate","REAL",calibration.observed_hit_rate],
    ["v14.calibration_bucket_low","REAL",calibration.bucket_low],
    ["v14.calibration_bucket_high","REAL",calibration.bucket_high],
    ["v14.calibration_fallback_level","TEXT",calibration.fallback_level],
  ];
  await env.DB.batch(derived.map(([name,type,value]) => env.DB.prepare(`
    INSERT INTO model_feature_values(model_prediction_id,feature_name,feature_group,value_type,value_real,value_integer,value_text,source_name,source_record_key,source_observed_at)
    VALUES(?,?,'v14_calibration',?,?,?,?, 'backtest_dataset_rows_v3',?,CURRENT_TIMESTAMP)
  `).bind(
    predictionId, name, type,
    type === "REAL" ? Number(value) : null,
    type === "INTEGER" ? Number(value) : null,
    type === "TEXT" ? String(value) : null,
    calibration.dataset_build_id === null ? "none" : String(calibration.dataset_build_id),
  )));
}

async function recordShadowFailure(
  env: Env,
  prop: ProcessPropRow,
  model: RuntimeModelVersion,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(`
    INSERT INTO model_predictions (
      prediction_uuid, prop_id, model_version_id, prediction_mode,
      prediction_status, predicted_at, information_cutoff_at, prop_line,
      preferred_side, decision, data_quality_status, error_message, output_json
    ) VALUES (?, ?, ?, 'SHADOW', 'FAILED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?,
              'NONE', 'FAILED', 'ERROR', ?, ?)
  `).bind(
    crypto.randomUUID(),
    prop.prop_id,
    model.model_version_id,
    Number(prop.strikeout_line),
    message,
    JSON.stringify({ adapter: model.code_identifier, error: message }),
  ).run();
  const failed=await env.DB.prepare(`SELECT model_prediction_id,predicted_at FROM model_predictions WHERE prop_id=? AND model_version_id=? AND prediction_mode='SHADOW' AND prediction_status='FAILED' ORDER BY model_prediction_id DESC LIMIT 1`).bind(prop.prop_id,model.model_version_id).first<{model_prediction_id:number;predicted_at:string}>();
  if(failed){
    const cert=await env.DB.prepare(`SELECT live_shadow_certification_id,started_at FROM live_shadow_certifications WHERE candidate_model_version_id=? AND status IN ('COLLECTING','TECHNICALLY_READY') ORDER BY live_shadow_certification_id DESC LIMIT 1`).bind(model.model_version_id).first<{live_shadow_certification_id:number;started_at:string}>();
    const inWindow=Boolean(cert&&String(failed.predicted_at)>=String(cert.started_at));
    await env.DB.prepare(`INSERT OR IGNORE INTO live_shadow_failure_ledger(live_shadow_certification_id,model_prediction_id,prop_id,board_date,failed_at,failure_scope,failure_type,error_message,details_json) SELECT ?,?,?,b.board_date,?,?,'SHADOW_RUNTIME',?,? FROM props p JOIN boards b ON b.board_id=p.board_id WHERE p.prop_id=?`).bind(inWindow?cert!.live_shadow_certification_id:null,failed.model_prediction_id,prop.prop_id,failed.predicted_at,inWindow?'CERTIFICATION_WINDOW':'PRE_CERTIFICATION',message,JSON.stringify({adapter:model.code_identifier,error:message,build:'9.2'}),prop.prop_id).run();
  }
}


async function getModelControl(env: Env): Promise<Response> {
  const models = await env.DB.prepare(`
    SELECT
      mv.model_version_id,
      mv.version_name,
      mv.description,
      mv.model_role,
      mv.lifecycle_status,
      mv.code_identifier,
      mv.feature_schema_version,
      mv.release_notes,
      mv.created_at,
      mv.activated_at,
      mv.retired_at,
      mv.updated_at,
      mv.execution_enabled,
      mv.execution_priority,
      mv.shadow_source_model_version_id,
      source.version_name AS shadow_source_version_name,
      mv.last_execution_at,
      mv.last_execution_status,
      mv.last_execution_error,
      COUNT(mp.model_prediction_id) AS prediction_count,
      SUM(CASE WHEN mp.prediction_mode = 'PRODUCTION' THEN 1 ELSE 0 END) AS production_prediction_count,
      SUM(CASE WHEN mp.prediction_mode = 'SHADOW' THEN 1 ELSE 0 END) AS shadow_prediction_count,
      SUM(CASE WHEN mp.prediction_status = 'FAILED' THEN 1 ELSE 0 END) AS failed_prediction_count,
      MAX(mp.predicted_at) AS latest_prediction_at
    FROM model_versions mv
    LEFT JOIN model_versions source ON source.model_version_id = mv.shadow_source_model_version_id
    LEFT JOIN model_predictions mp ON mp.model_version_id = mv.model_version_id
    GROUP BY mv.model_version_id
    ORDER BY CASE mv.model_role WHEN 'PRODUCTION' THEN 0 WHEN 'CHALLENGER' THEN 1 ELSE 2 END,
             mv.execution_priority,
             mv.model_version_id
  `).all();

  const summary = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN model_role = 'PRODUCTION' AND lifecycle_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_production_models,
      SUM(CASE WHEN model_role = 'CHALLENGER' AND lifecycle_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_challengers,
      SUM(CASE WHEN model_role = 'CHALLENGER' AND lifecycle_status = 'ACTIVE' AND execution_enabled = 1 THEN 1 ELSE 0 END) AS enabled_challengers,
      SUM(CASE WHEN last_execution_status = 'FAILED' THEN 1 ELSE 0 END) AS models_with_failed_status
    FROM model_versions
  `).first();

  return json({ models: models.results, summary });
}

async function updateModelControl(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  modelVersionId: number,
): Promise<Response> {
  const body = await request.json<{
    execution_enabled?: boolean;
    description?: string | null;
    release_notes?: string | null;
    execution_priority?: number;
  }>();

  const model = await env.DB.prepare(`
    SELECT model_version_id, version_name, model_role, execution_enabled
    FROM model_versions WHERE model_version_id = ?
  `).bind(modelVersionId).first<{
    model_version_id: number;
    version_name: string;
    model_role: string;
    execution_enabled: number;
  }>();
  if (!model) return json({ error: "Model version not found." }, { status: 404 });

  if (body.execution_enabled === false && model.model_role === "PRODUCTION") {
    return json({ error: "The production model cannot be disabled from Model Control." }, { status: 409 });
  }

  const priority = body.execution_priority === undefined ? undefined : Number(body.execution_priority);
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 10000)) {
    return json({ error: "execution_priority must be an integer from 0 through 10000." }, { status: 400 });
  }

  const enabled = body.execution_enabled === undefined
    ? model.execution_enabled
    : body.execution_enabled ? 1 : 0;
  const description = body.description === undefined ? undefined : String(body.description ?? '').trim() || null;
  const releaseNotes = body.release_notes === undefined ? undefined : String(body.release_notes ?? '').trim() || null;

  await env.DB.prepare(`
    UPDATE model_versions
    SET execution_enabled = ?,
        execution_priority = COALESCE(?, execution_priority),
        description = CASE WHEN ? = 1 THEN ? ELSE description END,
        release_notes = CASE WHEN ? = 1 THEN ? ELSE release_notes END,
        last_execution_status = CASE WHEN ? = 0 THEN 'DISABLED' ELSE last_execution_status END,
        last_execution_error = CASE WHEN ? = 1 THEN NULL ELSE last_execution_error END,
        updated_at = CURRENT_TIMESTAMP
    WHERE model_version_id = ?
  `).bind(
    enabled,
    priority ?? null,
    body.description === undefined ? 0 : 1,
    description,
    body.release_notes === undefined ? 0 : 1,
    releaseNotes,
    enabled,
    enabled,
    modelVersionId,
  ).run();

  await audit(env, identity, "MODEL_CONTROL_UPDATED", "MODEL_VERSION", modelVersionId, {
    version_name: model.version_name,
    model_role: model.model_role,
    execution_enabled: enabled === 1,
    execution_priority: priority,
    description_updated: body.description !== undefined,
    release_notes_updated: body.release_notes !== undefined,
  });

  return json({ ok: true, model_version_id: modelVersionId });
}

async function getModelRuntime(env: Env): Promise<Response> {
  const models = await env.DB.prepare(`
    SELECT model_version_id, version_name, description, model_role, lifecycle_status,
           code_identifier, execution_enabled, execution_priority,
           shadow_source_model_version_id, last_execution_at,
           last_execution_status, last_execution_error, updated_at
    FROM model_versions
    ORDER BY CASE model_role WHEN 'PRODUCTION' THEN 0 WHEN 'CHALLENGER' THEN 1 ELSE 2 END,
             execution_priority, model_version_id
  `).all();
  return json({ models: models.results });
}

async function updateModelRuntime(
  request: Request,
  env: Env,
  identity: AccessIdentity,
  modelVersionId: number,
): Promise<Response> {
  const body = await request.json<{ execution_enabled?: boolean }>();
  if (typeof body.execution_enabled !== "boolean") {
    return json({ error: "execution_enabled must be true or false." }, { status: 400 });
  }
  const model = await env.DB.prepare(`
    SELECT model_version_id, version_name, model_role
    FROM model_versions WHERE model_version_id = ?
  `).bind(modelVersionId).first<{ model_version_id: number; version_name: string; model_role: string }>();
  if (!model) return json({ error: "Model version not found." }, { status: 404 });
  if (model.model_role === "PRODUCTION" && !body.execution_enabled) {
    return json({ error: "The production model cannot be disabled through the shadow runtime endpoint." }, { status: 409 });
  }
  await env.DB.prepare(`
    UPDATE model_versions
    SET execution_enabled = ?,
        last_execution_status = CASE WHEN ? = 1 THEN last_execution_status ELSE 'DISABLED' END,
        last_execution_error = CASE WHEN ? = 1 THEN NULL ELSE last_execution_error END,
        updated_at = CURRENT_TIMESTAMP
    WHERE model_version_id = ?
  `).bind(body.execution_enabled ? 1 : 0, body.execution_enabled ? 1 : 0, body.execution_enabled ? 1 : 0, modelVersionId).run();
  await audit(env, identity, body.execution_enabled ? "MODEL_RUNTIME_ENABLED" : "MODEL_RUNTIME_DISABLED", "MODEL_VERSION", modelVersionId, {
    version_name: model.version_name,
    model_role: model.model_role,
  });
  return json({ ok: true, model_version_id: modelVersionId, execution_enabled: body.execution_enabled });
}

async function processBoard(
  env: Env,
  identity: AccessIdentity,
  boardId: number,
): Promise<Response> {
  await assertRefreshableBoard(env, boardId);

  const productionModel = await env.DB.prepare(`
    SELECT model_version_id, version_name, model_role, code_identifier,
           execution_enabled, execution_priority, shadow_source_model_version_id
    FROM model_versions
    WHERE model_role = 'PRODUCTION' AND lifecycle_status = 'ACTIVE' AND execution_enabled = 1
    ORDER BY execution_priority, model_version_id DESC
    LIMIT 1
  `).first<RuntimeModelVersion>();

  if (!productionModel) {
    return json(
      { error: "No enabled production model version is configured." },
      { status: 409 },
    );
  }

  const challengers = await env.DB.prepare(`
    SELECT model_version_id, version_name, model_role, code_identifier,
           execution_enabled, execution_priority, shadow_source_model_version_id
    FROM model_versions
    WHERE model_role = 'CHALLENGER'
      AND lifecycle_status = 'ACTIVE'
      AND execution_enabled = 1
    ORDER BY execution_priority, model_version_id
  `).all<RuntimeModelVersion>();

  const props = await env.DB.prepare(`
    SELECT
      p.prop_id,
      p.board_id,
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
  let productionPredictions = 0;
  let shadowPredictions = 0;
  let shadowFailures = 0;
  const warnings: Array<Record<string, unknown>> = [];

  for (const prop of props.results) {
    try {
      await processProp(env, productionModel.model_version_id, prop);
      processed += 1;

      // Release 3.2 Build 3.3.1 safety rule: feature-store bookkeeping is
      // additive and must never turn a successful production recommendation
      // into a failed board refresh. Capture errors are surfaced as warnings.
      let propFeatureSnapshotId: number | null = null;
      try {
        propFeatureSnapshotId = await capturePropFeatureSnapshot(
          env, prop, productionModel.model_version_id,
        );
      } catch (error) {
        warnings.push({
          prop_id: prop.prop_id,
          pitcher: prop.canonical_name,
          model: productionModel.version_name,
          stage: "FEATURE_SNAPSHOT",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await capturePredictionLedger(
          env,
          prop,
          productionModel.model_version_id,
          productionModel,
          "PRODUCTION",
          propFeatureSnapshotId,
        );
        productionPredictions += 1;
      } catch (error) {
        warnings.push({
          prop_id: prop.prop_id,
          pitcher: prop.canonical_name,
          model: productionModel.version_name,
          stage: "PRODUCTION_LEDGER",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      for (const challenger of challengers.results) {
        try {
          const sourceModelVersionId = challenger.shadow_source_model_version_id
            ?? productionModel.model_version_id;
          if (challenger.code_identifier === "shadow-adapter:production-mirror-v1") {
            await capturePredictionLedger(env, prop, sourceModelVersionId, challenger, "SHADOW", propFeatureSnapshotId);
          } else if (challenger.code_identifier === "shadow-adapter:v14-baseline-calibrated-v1" || challenger.code_identifier === "shadow-adapter:v14-adaptive-selection-v1") {
            await captureV14BaselinePredictionLedger(env, prop, sourceModelVersionId, challenger, propFeatureSnapshotId);
          } else {
            throw new Error(`Unsupported shadow adapter: ${challenger.code_identifier ?? "none"}`);
          }
          shadowPredictions += 1;
        } catch (error) {
          shadowFailures += 1;
          await recordShadowFailure(env, prop, challenger, error);
          warnings.push({
            prop_id: prop.prop_id,
            pitcher: prop.canonical_name,
            model: challenger.version_name,
            stage: "SHADOW",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      warnings.push({
        prop_id: prop.prop_id,
        pitcher: prop.canonical_name,
        model: productionModel.version_name,
        stage: "PRODUCTION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await env.DB.prepare(`
    UPDATE model_versions
    SET last_execution_at = CURRENT_TIMESTAMP,
        last_execution_status = ?,
        last_execution_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE model_version_id = ?
  `).bind(
    processed === props.results.length ? "SUCCEEDED" : processed > 0 ? "PARTIAL" : "FAILED",
    processed === props.results.length ? null : `${props.results.length - processed} production prop(s) failed`,
    productionModel.model_version_id,
  ).run();

  for (const challenger of challengers.results) {
    const challengerFailures = warnings.filter((warning) => warning.model === challenger.version_name).length;
    await env.DB.prepare(`
      UPDATE model_versions
      SET last_execution_at = CURRENT_TIMESTAMP,
          last_execution_status = ?,
          last_execution_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE model_version_id = ?
    `).bind(
      challengerFailures === 0 ? "SUCCEEDED" : shadowPredictions > 0 ? "PARTIAL" : "FAILED",
      challengerFailures === 0 ? null : `${challengerFailures} shadow prediction(s) failed`,
      challenger.model_version_id,
    ).run();
  }

  await audit(env, identity, "BOARD_PROCESSED", "BOARD", boardId, {
    model_version_id: productionModel.model_version_id,
    model_version: productionModel.version_name,
    processed,
    production_predictions: productionPredictions,
    enabled_challengers: challengers.results.map((model) => model.version_name),
    shadow_predictions: shadowPredictions,
    shadow_failures: shadowFailures,
    warnings,
  });

  return json({
    ok: true,
    board_id: boardId,
    model_version: productionModel.version_name,
    processed,
    production_predictions: productionPredictions,
    enabled_challengers: challengers.results.length,
    shadow_predictions: shadowPredictions,
    shadow_failures: shadowFailures,
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



interface MlbScheduleTeamSide {
  score?: number;
  team?: { id?: number; name?: string };
  probablePitcher?: { id?: number; fullName?: string; pitchHand?: { code?: string } };
}

interface MlbScheduleSyncGame {
  gamePk?: number;
  gameDate?: string;
  officialDate?: string;
  doubleHeader?: string;
  gameNumber?: number;
  dayNight?: string;
  status?: {
    abstractGameState?: string;
    detailedState?: string;
    codedGameState?: string;
    statusCode?: string;
  };
  venue?: { name?: string };
  teams?: { away?: MlbScheduleTeamSide; home?: MlbScheduleTeamSide };
}

function compactHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isoDateOffset(baseDate: string, days: number): string {
  const parsed = new Date(`${baseDate}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function recordScheduleSyncError(
  env: Env,
  syncRunId: number,
  stage: string,
  error: unknown,
  sourceRecordKey: string | null = null,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(`
    INSERT INTO sync_errors (
      sync_run_id, error_stage, error_code, error_message,
      source_record_key, retryable, payload_excerpt
    ) VALUES (?, ?, 'MLB_SCHEDULE_SYNC_ERROR', ?, ?, 1, ?)
  `).bind(syncRunId, stage, message, sourceRecordKey, message.slice(0, 1000)).run();
}

async function ensureScheduleTeam(
  env: Env,
  mlbTeamId: number,
  name: string | null,
): Promise<number> {
  const abbreviation = MLB_TEAM_ABBREVIATIONS[mlbTeamId];
  if (!abbreviation) throw new Error(`No team abbreviation mapping exists for MLB team ${mlbTeamId}.`);
  await env.DB.prepare(`
    INSERT INTO teams (abbreviation, full_name, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(abbreviation) DO UPDATE SET
      full_name = COALESCE(excluded.full_name, teams.full_name),
      updated_at = CURRENT_TIMESTAMP
  `).bind(abbreviation, name).run();
  const team = await env.DB.prepare(`SELECT team_id FROM teams WHERE abbreviation = ?`)
    .bind(abbreviation).first<{ team_id: number }>();
  if (!team) throw new Error(`Unable to resolve local team row for ${abbreviation}.`);
  return Number(team.team_id);
}

async function ensureProbablePitcher(
  env: Env,
  pitcher: MlbScheduleTeamSide["probablePitcher"],
  currentTeam: string,
): Promise<void> {
  const mlbId = Number(pitcher?.id ?? 0);
  const fullName = String(pitcher?.fullName ?? "").trim();
  if (!mlbId || !fullName) return;
  const hand = String(pitcher?.pitchHand?.code ?? "").toUpperCase();
  const validHand = hand === "L" || hand === "R" ? hand : null;
  const existing = await env.DB.prepare(`
    SELECT pitcher_id FROM pitchers WHERE mlb_id = ? OR canonical_name = ? LIMIT 1
  `).bind(mlbId, fullName).first<{ pitcher_id: number }>();
  if (existing) {
    await env.DB.prepare(`
      UPDATE pitchers SET mlb_id = ?, canonical_name = ?,
        throws_hand = COALESCE(?, throws_hand), current_team = ?, active = 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE pitcher_id = ?
    `).bind(mlbId, fullName, validHand, currentTeam, existing.pitcher_id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO pitchers (
        canonical_name, mlb_id, throws_hand, active, current_team,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(fullName, mlbId, validHand, currentTeam).run();
  }
}

interface ScheduleSyncResult {
  sync_run_id: number;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  start_date: string;
  end_date: string;
  games_read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  snapshots_inserted: number;
  rejected: number;
}

async function syncMlbScheduleGames(
  env: Env,
  startDate: string,
  endDate: string,
  triggerSource: "CRON" | "ADMIN" | "API" | "MANUAL" = "MANUAL",
): Promise<ScheduleSyncResult> {
  const safeStart = validateDate(startDate);
  const safeEnd = validateDate(endDate);
  if (safeEnd < safeStart) throw new Response(JSON.stringify({ error: "end_date must be on or after start_date" }), { status: 400 });
  const runUuid = crypto.randomUUID();
  const runInsert = await env.DB.prepare(`
    INSERT INTO sync_runs (
      run_uuid, source_name, dataset_name, sync_mode, trigger_source,
      status, source_cursor_start, source_cursor_end, request_count
    ) VALUES (?, 'MLB_STATS_API', 'MLB_SCHEDULE_GAMES', 'INCREMENTAL', ?,
      'RUNNING', ?, ?, 1)
  `).bind(runUuid, triggerSource, safeStart, safeEnd).run();
  const syncRunId = Number(runInsert.meta.last_row_id);

  let gamesRead = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let snapshotsInserted = 0;
  let rejected = 0;

  try {
    const endpoint = new URL("https://statsapi.mlb.com/api/v1/schedule");
    endpoint.searchParams.set("sportId", "1");
    endpoint.searchParams.set("startDate", safeStart);
    endpoint.searchParams.set("endDate", safeEnd);
    endpoint.searchParams.set("hydrate", "probablePitcher(note,pitchHand),team,venue");
    const payload = await fetchMlbJson(endpoint.toString()) as { dates?: Array<{ date?: string; games?: MlbScheduleSyncGame[] }> };
    const games = (payload.dates ?? []).flatMap((date) =>
      (date.games ?? []).map((game) => ({ ...game, officialDate: game.officialDate ?? date.date })),
    );
    gamesRead = games.length;

    for (const game of games) {
      const gamePk = Number(game.gamePk ?? 0);
      try {
        if (!gamePk) throw new Error("Schedule record is missing gamePk.");
        const awayMlbId = Number(game.teams?.away?.team?.id ?? 0);
        const homeMlbId = Number(game.teams?.home?.team?.id ?? 0);
        if (!awayMlbId || !homeMlbId) throw new Error("Schedule record is missing one or both team IDs.");
        const awayAbbr = MLB_TEAM_ABBREVIATIONS[awayMlbId];
        const homeAbbr = MLB_TEAM_ABBREVIATIONS[homeMlbId];
        if (!awayAbbr || !homeAbbr) throw new Error(`Unknown MLB team mapping for game ${gamePk}.`);

        const awayTeamId = await ensureScheduleTeam(env, awayMlbId, game.teams?.away?.team?.name ?? null);
        const homeTeamId = await ensureScheduleTeam(env, homeMlbId, game.teams?.home?.team?.name ?? null);
        await ensureProbablePitcher(env, game.teams?.away?.probablePitcher, awayAbbr);
        await ensureProbablePitcher(env, game.teams?.home?.probablePitcher, homeAbbr);

        const officialDate = String(game.officialDate ?? game.gameDate?.slice(0, 10) ?? safeStart);
        const serialized = JSON.stringify(game);
        const payloadHash = compactHash(serialized);
        const snapshot = await env.DB.prepare(`
          INSERT OR IGNORE INTO raw_mlb_schedule_snapshots (
            mlb_game_pk, official_date, payload_hash, payload_json, sync_run_id
          ) VALUES (?, ?, ?, ?, ?)
        `).bind(gamePk, officialDate, payloadHash, serialized, syncRunId).run();
        snapshotsInserted += Number(snapshot.meta.changes ?? 0);

        const existing = await env.DB.prepare(`
          SELECT game_id, scheduled_start, game_status, status_detailed,
                 away_score, home_score, away_probable_pitcher_mlb_id,
                 home_probable_pitcher_mlb_id
          FROM games WHERE mlb_game_pk = ?
        `).bind(gamePk).first<Record<string, unknown>>();

        const scheduledStart = game.gameDate ?? null;
        const abstractStatus = game.status?.abstractGameState ?? null;
        const detailedStatus = game.status?.detailedState ?? null;
        const codedStatus = game.status?.codedGameState ?? game.status?.statusCode ?? null;
        const awayPitcher = game.teams?.away?.probablePitcher;
        const homePitcher = game.teams?.home?.probablePitcher;

        await env.DB.prepare(`
          INSERT INTO games (
            mlb_game_pk, game_date, official_date, away_team_id, home_team_id,
            scheduled_start, game_status, status_abstract, status_detailed,
            status_code, venue_name, day_night, doubleheader, game_number,
            away_score, home_score,
            away_probable_pitcher_mlb_id, away_probable_pitcher_name, away_probable_pitcher_hand,
            home_probable_pitcher_mlb_id, home_probable_pitcher_name, home_probable_pitcher_hand,
            source_name, first_seen_at, last_synced_at, source_updated_at,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'MLB_STATS_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT(mlb_game_pk) DO UPDATE SET
            game_date = excluded.game_date,
            official_date = excluded.official_date,
            away_team_id = excluded.away_team_id,
            home_team_id = excluded.home_team_id,
            scheduled_start = excluded.scheduled_start,
            game_status = excluded.game_status,
            status_abstract = excluded.status_abstract,
            status_detailed = excluded.status_detailed,
            status_code = excluded.status_code,
            venue_name = excluded.venue_name,
            day_night = excluded.day_night,
            doubleheader = excluded.doubleheader,
            game_number = excluded.game_number,
            away_score = excluded.away_score,
            home_score = excluded.home_score,
            away_probable_pitcher_mlb_id = excluded.away_probable_pitcher_mlb_id,
            away_probable_pitcher_name = excluded.away_probable_pitcher_name,
            away_probable_pitcher_hand = excluded.away_probable_pitcher_hand,
            home_probable_pitcher_mlb_id = excluded.home_probable_pitcher_mlb_id,
            home_probable_pitcher_name = excluded.home_probable_pitcher_name,
            home_probable_pitcher_hand = excluded.home_probable_pitcher_hand,
            source_name = 'MLB_STATS_API',
            last_synced_at = CURRENT_TIMESTAMP,
            source_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          gamePk, officialDate, officialDate, awayTeamId, homeTeamId,
          scheduledStart, detailedStatus ?? abstractStatus, abstractStatus, detailedStatus,
          codedStatus, game.venue?.name ?? null, game.dayNight ?? null,
          game.doubleHeader ?? null, game.gameNumber ?? null,
          game.teams?.away?.score ?? null, game.teams?.home?.score ?? null,
          awayPitcher?.id ?? null, awayPitcher?.fullName ?? null, awayPitcher?.pitchHand?.code ?? null,
          homePitcher?.id ?? null, homePitcher?.fullName ?? null, homePitcher?.pitchHand?.code ?? null,
        ).run();

        if (!existing) inserted += 1;
        else {
          const changed =
            String(existing.scheduled_start ?? "") !== String(scheduledStart ?? "") ||
            String(existing.game_status ?? "") !== String(detailedStatus ?? abstractStatus ?? "") ||
            String(existing.status_detailed ?? "") !== String(detailedStatus ?? "") ||
            Number(existing.away_score ?? -1) !== Number(game.teams?.away?.score ?? -1) ||
            Number(existing.home_score ?? -1) !== Number(game.teams?.home?.score ?? -1) ||
            Number(existing.away_probable_pitcher_mlb_id ?? 0) !== Number(awayPitcher?.id ?? 0) ||
            Number(existing.home_probable_pitcher_mlb_id ?? 0) !== Number(homePitcher?.id ?? 0);
          if (changed) updated += 1;
          else unchanged += 1;
        }
      } catch (error) {
        rejected += 1;
        await recordScheduleSyncError(env, syncRunId, "GAME_UPSERT", error, String(game.gamePk ?? "UNKNOWN"));
      }
    }

    const status: ScheduleSyncResult["status"] = rejected === 0 ? "SUCCEEDED" : rejected < gamesRead ? "PARTIAL" : "FAILED";
    const completedStatus = status === "SUCCEEDED" ? "HEALTHY" : status === "PARTIAL" ? "INCOMPLETE" : "FAILED";
    await env.DB.prepare(`
      UPDATE sync_runs SET
        status = ?, completed_at = CURRENT_TIMESTAMP, rows_read = ?, rows_inserted = ?,
        rows_updated = ?, rows_unchanged = ?, rows_rejected = ?,
        freshness_cutoff_at = ?, details_json = ?
      WHERE sync_run_id = ?
    `).bind(status, gamesRead, inserted, updated, unchanged, rejected, safeEnd,
      JSON.stringify({ snapshots_inserted: snapshotsInserted }), syncRunId).run();
    await env.DB.prepare(`
      INSERT INTO data_source_status (
        source_name, dataset_name, status, last_attempt_at, last_success_at,
        last_complete_through_at, last_sync_run_id, expected_refresh_minutes,
        stale_after_minutes, consecutive_failures, record_count, status_message,
        metadata_json, updated_at
      ) VALUES (
        'MLB_STATS_API', 'MLB_SCHEDULE_GAMES', ?, CURRENT_TIMESTAMP,
        CASE WHEN ? = 'SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,
        ?, ?, 30, 90, CASE WHEN ? = 'FAILED' THEN 1 ELSE 0 END,
        (SELECT COUNT(*) FROM games WHERE source_name='MLB_STATS_API'), ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(source_name, dataset_name) DO UPDATE SET
        status = excluded.status,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,
        last_complete_through_at = CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,
        last_sync_run_id = excluded.last_sync_run_id,
        consecutive_failures = CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures + 1 ELSE 0 END,
        record_count = excluded.record_count,
        status_message = excluded.status_message,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(completedStatus, status, safeEnd, syncRunId, status,
      `${gamesRead} games read; ${inserted} inserted; ${updated} updated; ${unchanged} unchanged; ${rejected} rejected.`,
      JSON.stringify({ start_date: safeStart, end_date: safeEnd, snapshots_inserted: snapshotsInserted })).run();

    return { sync_run_id: syncRunId, status, start_date: safeStart, end_date: safeEnd,
      games_read: gamesRead, inserted, updated, unchanged, snapshots_inserted: snapshotsInserted, rejected };
  } catch (error) {
    await recordScheduleSyncError(env, syncRunId, "FETCH", error);
    await env.DB.prepare(`
      UPDATE sync_runs SET status='FAILED', completed_at=CURRENT_TIMESTAMP,
        rows_read=?, rows_inserted=?, rows_updated=?, rows_unchanged=?, rows_rejected=?,
        details_json=? WHERE sync_run_id=?
    `).bind(gamesRead, inserted, updated, unchanged, Math.max(1, rejected),
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), syncRunId).run();
    await env.DB.prepare(`
      UPDATE data_source_status SET status='FAILED', last_attempt_at=CURRENT_TIMESTAMP,
        last_sync_run_id=?, consecutive_failures=consecutive_failures+1,
        status_message=?, updated_at=CURRENT_TIMESTAMP
      WHERE source_name='MLB_STATS_API' AND dataset_name='MLB_SCHEDULE_GAMES'
    `).bind(syncRunId, error instanceof Error ? error.message : String(error)).run();
    throw error;
  }
}

async function getScheduleSyncStatus(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const gamesWhere = date ? "WHERE g.official_date = ?" : "WHERE g.official_date >= date('now','-1 day')";
  const games = date
    ? await env.DB.prepare(`
        SELECT g.*, at.abbreviation AS away_team, ht.abbreviation AS home_team
        FROM games g LEFT JOIN teams at ON at.team_id=g.away_team_id
        LEFT JOIN teams ht ON ht.team_id=g.home_team_id
        ${gamesWhere} ORDER BY g.scheduled_start, g.mlb_game_pk
      `).bind(validateDate(date)).all<Record<string, unknown>>()
    : await env.DB.prepare(`
        SELECT g.*, at.abbreviation AS away_team, ht.abbreviation AS home_team
        FROM games g LEFT JOIN teams at ON at.team_id=g.away_team_id
        LEFT JOIN teams ht ON ht.team_id=g.home_team_id
        ${gamesWhere} ORDER BY g.official_date DESC, g.scheduled_start, g.mlb_game_pk LIMIT 100
      `).all<Record<string, unknown>>();
  const source = await env.DB.prepare(`
    SELECT * FROM data_source_status
    WHERE source_name='MLB_STATS_API' AND dataset_name='MLB_SCHEDULE_GAMES'
  `).first<Record<string, unknown>>();
  const runs = await env.DB.prepare(`
    SELECT sr.*,
      (SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) AS error_count
    FROM sync_runs sr
    WHERE sr.source_name='MLB_STATS_API' AND sr.dataset_name='MLB_SCHEDULE_GAMES'
    ORDER BY sr.sync_run_id DESC LIMIT 20
  `).all<Record<string, unknown>>();
  return json({ source_status: source, recent_runs: runs.results, games: games.results });
}

async function runScheduleSync(request: Request, env: Env): Promise<Response> {
  const input = await parseJson<{ start_date?: string; end_date?: string }>(request);
  const today = chicagoDateString(Date.now());
  const startDate = input.start_date ? validateDate(input.start_date) : isoDateOffset(today, -1);
  const endDate = input.end_date ? validateDate(input.end_date) : isoDateOffset(today, 2);
  return json({ ok: true, ...(await syncMlbScheduleGames(env, startDate, endDate, "ADMIN")) });
}

async function autoSyncMlbSchedule(env: Env, scheduledTime: number): Promise<void> {
  const local = chicagoDateParts(scheduledTime);
  if (local.minute % 30 !== 0) return;
  const today = chicagoDateString(scheduledTime);
  await syncMlbScheduleGames(env, isoDateOffset(today, -1), isoDateOffset(today, 2), "CRON");
}


interface PitcherLogSyncResult {
  sync_run_id: number;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  start_date: string;
  end_date: string;
  games_read: number;
  games_fetched: number;
  logs_inserted: number;
  logs_updated: number;
  logs_unchanged: number;
  snapshots_inserted: number;
  rejected: number;
}

function inningsToOuts(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const [wholeText, partialText = "0"] = text.split(".");
  const whole = Number(wholeText);
  const partial = Number(partialText);
  if (!Number.isFinite(whole) || !Number.isFinite(partial) || partial < 0 || partial > 2) return null;
  return whole * 3 + partial;
}

function integerStat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

async function recordPitcherLogSyncError(
  env: Env,
  syncRunId: number,
  stage: string,
  error: unknown,
  sourceRecordKey: string | null = null,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(`
    INSERT INTO sync_errors (
      sync_run_id, error_stage, error_code, error_message,
      source_record_key, retryable, payload_excerpt
    ) VALUES (?, ?, 'PITCHER_GAME_LOG_SYNC_ERROR', ?, ?, 1, ?)
  `).bind(syncRunId, stage, message, sourceRecordKey, message.slice(0, 1000)).run();
}

async function ensureGameLogPitcher(
  env: Env,
  mlbId: number,
  fullName: string,
  currentTeam: string,
): Promise<number | null> {
  if (!mlbId || !fullName) return null;
  const existing = await env.DB.prepare(`
    SELECT pitcher_id FROM pitchers WHERE mlb_id = ? OR canonical_name = ? LIMIT 1
  `).bind(mlbId, fullName).first<{ pitcher_id: number }>();
  if (existing) {
    await env.DB.prepare(`
      UPDATE pitchers SET mlb_id=?, canonical_name=?, current_team=?, active=1,
        updated_at=CURRENT_TIMESTAMP WHERE pitcher_id=?
    `).bind(mlbId, fullName, currentTeam, existing.pitcher_id).run();
    return Number(existing.pitcher_id);
  }
  const inserted = await env.DB.prepare(`
    INSERT INTO pitchers (canonical_name, mlb_id, active, current_team, created_at, updated_at)
    VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(fullName, mlbId, currentTeam).run();
  return Number(inserted.meta.last_row_id);
}

async function syncMlbPitcherGameLogs(
  env: Env,
  startDate: string,
  endDate: string,
  triggerSource: "CRON" | "ADMIN" | "API" | "MANUAL" = "MANUAL",
): Promise<PitcherLogSyncResult> {
  const safeStart = validateDate(startDate);
  const safeEnd = validateDate(endDate);
  if (safeEnd < safeStart) throw new Response(JSON.stringify({ error: "end_date must be on or after start_date" }), { status: 400 });
  const runInsert = await env.DB.prepare(`
    INSERT INTO sync_runs (
      run_uuid, source_name, dataset_name, sync_mode, trigger_source,
      status, source_cursor_start, source_cursor_end
    ) VALUES (?, 'MLB_STATS_API', 'PITCHER_GAME_LOGS', 'INCREMENTAL', ?, 'RUNNING', ?, ?)
  `).bind(crypto.randomUUID(), triggerSource, safeStart, safeEnd).run();
  const syncRunId = Number(runInsert.meta.last_row_id);
  let gamesRead=0, gamesFetched=0, logsInserted=0, logsUpdated=0, logsUnchanged=0, snapshotsInserted=0, rejected=0;
  try {
    const games = await env.DB.prepare(`
      SELECT g.game_id, g.mlb_game_pk, g.official_date, g.game_status,
             at.abbreviation AS away_team, ht.abbreviation AS home_team
      FROM games g
      JOIN teams at ON at.team_id=g.away_team_id
      JOIN teams ht ON ht.team_id=g.home_team_id
      WHERE g.official_date BETWEEN ? AND ? AND g.mlb_game_pk IS NOT NULL
      ORDER BY g.official_date, g.mlb_game_pk
    `).bind(safeStart, safeEnd).all<Record<string, unknown>>();
    gamesRead = games.results.length;
    for (const game of games.results) {
      const gamePk=Number(game.mlb_game_pk);
      try {
        const payload=await fetchMlbJson(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`) as {
          teams?: Record<string,{ team?:{id?:number;abbreviation?:string}; pitchers?:number[]; players?:Record<string,{
            person?:{id?:number;fullName?:string}; stats?:{pitching?:Record<string,unknown>};
          }> }>;
        };
        gamesFetched += 1;
        const serialized=JSON.stringify(payload);
        const snapshot=await env.DB.prepare(`
          INSERT OR IGNORE INTO raw_mlb_boxscore_snapshots
            (mlb_game_pk, game_date, payload_hash, payload_json, sync_run_id)
          VALUES (?, ?, ?, ?, ?)
        `).bind(gamePk, String(game.official_date), compactHash(serialized), serialized, syncRunId).run();
        snapshotsInserted += Number(snapshot.meta.changes ?? 0);
        for (const side of ["away","home"] as const) {
          const teamBox=payload.teams?.[side];
          const teamAbbr=String(side === "away" ? game.away_team : game.home_team);
          const opponentAbbr=String(side === "away" ? game.home_team : game.away_team);
          const pitcherIds=teamBox?.pitchers ?? [];
          for (let index=0; index<pitcherIds.length; index+=1) {
            const mlbPitcherId=Number(pitcherIds[index]);
            const player=teamBox?.players?.[`ID${mlbPitcherId}`];
            const pitching=player?.stats?.pitching;
            if (!pitching) continue;
            const fullName=String(player?.person?.fullName ?? `MLB ${mlbPitcherId}`);
            const localPitcherId=await ensureGameLogPitcher(env, mlbPitcherId, fullName, teamAbbr);
            const existing=await env.DB.prepare(`
              SELECT pitcher_game_log_id, strikeouts, batters_faced, pitch_count, innings_pitched_text,
                     walks, hits_allowed, earned_runs, starter
              FROM raw_pitcher_game_logs WHERE mlb_game_pk=? AND mlb_pitcher_id=?
            `).bind(gamePk, mlbPitcherId).first<Record<string,unknown>>();
            const innings=String(pitching.inningsPitched ?? "");
            const values={
              strikeouts: integerStat(pitching.strikeOuts), batters: integerStat(pitching.battersFaced),
              pitches: integerStat(pitching.numberOfPitches), walks: integerStat(pitching.baseOnBalls),
              hits: integerStat(pitching.hits), runs: integerStat(pitching.runs),
              earned: integerStat(pitching.earnedRuns), homers: integerStat(pitching.homeRuns),
              strikes: integerStat(pitching.strikes), balls: integerStat(pitching.balls), starter: index===0?1:0,
            };
            await env.DB.prepare(`
              INSERT INTO raw_pitcher_game_logs (
                mlb_game_pk, mlb_pitcher_id, pitcher_name, pitcher_id, game_id, game_date,
                team_abbreviation, opponent_abbreviation, home_away, starter, decision_code,
                innings_pitched_text, outs_recorded, strikeouts, batters_faced, pitch_count,
                walks, hits_allowed, runs_allowed, earned_runs, home_runs_allowed, strikes, balls,
                game_status, source_updated_at, last_synced_at, sync_run_id
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)
              ON CONFLICT(mlb_game_pk, mlb_pitcher_id) DO UPDATE SET
                pitcher_name=excluded.pitcher_name, pitcher_id=excluded.pitcher_id, game_id=excluded.game_id,
                team_abbreviation=excluded.team_abbreviation, opponent_abbreviation=excluded.opponent_abbreviation,
                home_away=excluded.home_away, starter=excluded.starter, decision_code=excluded.decision_code,
                innings_pitched_text=excluded.innings_pitched_text, outs_recorded=excluded.outs_recorded,
                strikeouts=excluded.strikeouts, batters_faced=excluded.batters_faced,
                pitch_count=excluded.pitch_count, walks=excluded.walks, hits_allowed=excluded.hits_allowed,
                runs_allowed=excluded.runs_allowed, earned_runs=excluded.earned_runs,
                home_runs_allowed=excluded.home_runs_allowed, strikes=excluded.strikes, balls=excluded.balls,
                game_status=excluded.game_status, source_updated_at=CURRENT_TIMESTAMP,
                last_synced_at=CURRENT_TIMESTAMP, sync_run_id=excluded.sync_run_id
            `).bind(
              gamePk, mlbPitcherId, fullName, localPitcherId, Number(game.game_id), String(game.official_date),
              teamAbbr, opponentAbbr, side.toUpperCase(), values.starter, pitching.note ?? null,
              innings, inningsToOuts(innings), values.strikeouts, values.batters, values.pitches,
              values.walks, values.hits, values.runs, values.earned, values.homers, values.strikes, values.balls,
              String(game.game_status ?? ""), syncRunId,
            ).run();
            if (!existing) logsInserted += 1;
            else {
              const changed = Number(existing.strikeouts ?? -1)!==Number(values.strikeouts ?? -1)
                || Number(existing.batters_faced ?? -1)!==Number(values.batters ?? -1)
                || Number(existing.pitch_count ?? -1)!==Number(values.pitches ?? -1)
                || String(existing.innings_pitched_text ?? "")!==innings
                || Number(existing.walks ?? -1)!==Number(values.walks ?? -1)
                || Number(existing.hits_allowed ?? -1)!==Number(values.hits ?? -1)
                || Number(existing.earned_runs ?? -1)!==Number(values.earned ?? -1)
                || Number(existing.starter ?? 0)!==values.starter;
              if (changed) logsUpdated += 1; else logsUnchanged += 1;
            }
          }
        }
      } catch (error) {
        rejected += 1;
        await recordPitcherLogSyncError(env, syncRunId, "GAME_BOXSCORE", error, String(gamePk));
      }
    }
    const status: PitcherLogSyncResult["status"] = rejected===0 ? "SUCCEEDED" : rejected<gamesRead ? "PARTIAL" : "FAILED";
    const sourceStatus=status==="SUCCEEDED" ? "HEALTHY" : status==="PARTIAL" ? "INCOMPLETE" : "FAILED";
    await env.DB.prepare(`UPDATE sync_runs SET status=?, completed_at=CURRENT_TIMESTAMP, request_count=?,
      rows_read=?, rows_inserted=?, rows_updated=?, rows_unchanged=?, rows_rejected=?, freshness_cutoff_at=?, details_json=?
      WHERE sync_run_id=?`).bind(status,gamesFetched,gamesRead,logsInserted,logsUpdated,logsUnchanged,rejected,safeEnd,
      JSON.stringify({games_fetched:gamesFetched,snapshots_inserted:snapshotsInserted}),syncRunId).run();
    await env.DB.prepare(`
      INSERT INTO data_source_status (source_name,dataset_name,status,last_attempt_at,last_success_at,
        last_complete_through_at,last_sync_run_id,expected_refresh_minutes,stale_after_minutes,
        consecutive_failures,record_count,status_message,metadata_json,updated_at)
      VALUES ('MLB_STATS_API','PITCHER_GAME_LOGS',?,CURRENT_TIMESTAMP,
        CASE WHEN ?='SUCCEEDED' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,60,180,
        CASE WHEN ?='FAILED' THEN 1 ELSE 0 END,
        (SELECT COUNT(*) FROM raw_pitcher_game_logs),?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_name,dataset_name) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,
        last_success_at=CASE WHEN excluded.status='HEALTHY' THEN CURRENT_TIMESTAMP ELSE data_source_status.last_success_at END,
        last_complete_through_at=CASE WHEN excluded.status='HEALTHY' THEN excluded.last_complete_through_at ELSE data_source_status.last_complete_through_at END,
        last_sync_run_id=excluded.last_sync_run_id,consecutive_failures=CASE WHEN excluded.status='FAILED' THEN data_source_status.consecutive_failures+1 ELSE 0 END,
        record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP
    `).bind(sourceStatus,status,safeEnd,syncRunId,status,
      `${gamesRead} games found; ${gamesFetched} fetched; ${logsInserted} logs inserted; ${logsUpdated} updated; ${rejected} rejected.`,
      JSON.stringify({start_date:safeStart,end_date:safeEnd,snapshots_inserted:snapshotsInserted})).run();
    return {sync_run_id:syncRunId,status,start_date:safeStart,end_date:safeEnd,games_read:gamesRead,games_fetched:gamesFetched,
      logs_inserted:logsInserted,logs_updated:logsUpdated,logs_unchanged:logsUnchanged,snapshots_inserted:snapshotsInserted,rejected};
  } catch (error) {
    await recordPitcherLogSyncError(env,syncRunId,"SYNC",error);
    await env.DB.prepare(`UPDATE sync_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,rows_rejected=1,details_json=? WHERE sync_run_id=?`)
      .bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),syncRunId).run();
    throw error;
  }
}

async function getPitcherLogSyncStatus(env: Env, url: URL): Promise<Response> {
  const date=url.searchParams.get("date");
  const logs=date
    ? await env.DB.prepare(`SELECT * FROM raw_pitcher_game_logs WHERE game_date=? ORDER BY game_date DESC,starter DESC,team_abbreviation,mlb_pitcher_id`).bind(validateDate(date)).all<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM raw_pitcher_game_logs ORDER BY game_date DESC,starter DESC,pitcher_game_log_id DESC LIMIT 200`).all<Record<string,unknown>>();
  const source=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='PITCHER_GAME_LOGS'`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT sr.*,(SELECT COUNT(*) FROM sync_errors se WHERE se.sync_run_id=sr.sync_run_id) AS error_count
    FROM sync_runs sr WHERE sr.source_name='MLB_STATS_API' AND sr.dataset_name='PITCHER_GAME_LOGS' ORDER BY sr.sync_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  return json({source_status:source,recent_runs:runs.results,logs:logs.results});
}

async function runPitcherLogSync(request: Request, env: Env): Promise<Response> {
  const input=await parseJson<{start_date?:string;end_date?:string}>(request);
  const today=chicagoDateString(Date.now());
  const start=input.start_date?validateDate(input.start_date):isoDateOffset(today,-2);
  const end=input.end_date?validateDate(input.end_date):today;
  return json({ok:true,...(await syncMlbPitcherGameLogs(env,start,end,"ADMIN"))});
}

async function autoSyncMlbPitcherLogs(env: Env, scheduledTime: number): Promise<void> {
  const local=chicagoDateParts(scheduledTime);
  if (local.minute!==10) return;
  const today=chicagoDateString(scheduledTime);
  await syncMlbPitcherGameLogs(env,isoDateOffset(today,-2),today,"CRON");
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

interface FeedPitchingLine {
  strikeouts: number;
  innings_pitched: number | null;
  pitch_count: number | null;
  batters_faced: number | null;
  starter: number;
  walks: number | null;
  earned_runs: number | null;
  source: string;
}

async function fetchPitchingLineFromGameFeed(gamePk: number, mlbId: number): Promise<FeedPitchingLine | null> {
  const payload = await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  const root = payload as {
    liveData?: {
      boxscore?: {
        teams?: {
          away?: { players?: Record<string, { stats?: { pitching?: Record<string, unknown> } }> };
          home?: { players?: Record<string, { stats?: { pitching?: Record<string, unknown> } }> };
        };
      };
    };
  };

  const key = `ID${mlbId}`;
  const player = root.liveData?.boxscore?.teams?.away?.players?.[key]
    ?? root.liveData?.boxscore?.teams?.home?.players?.[key];
  const pitching = player?.stats?.pitching;
  if (!pitching || pitching.strikeOuts == null) return null;

  return {
    strikeouts: Number(pitching.strikeOuts),
    innings_pitched: inningsToDecimal(pitching.inningsPitched),
    pitch_count: optionalNumber(pitching.numberOfPitches),
    batters_faced: optionalNumber(pitching.battersFaced),
    starter: Number(pitching.gamesStarted ?? 0) > 0 ? 1 : 0,
    walks: optionalNumber(pitching.baseOnBalls),
    earned_runs: optionalNumber(pitching.earnedRuns),
    source: `MLB live feed game ${gamePk}`,
  };
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
      p.board_id,
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

    let game = await env.DB.prepare(`
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

    const scheduledGame = findPropGame(prop);

    // Game-log endpoints can occasionally miss a same-day appearance even when the
    // official final box score contains it. Fall back to the game feed before deciding
    // that a pitcher did not play.
    if ((!game || game.strikeouts == null) && scheduledGame?.gamePk) {
      try {
        let mlbId = prop.mlb_id == null ? null : Number(prop.mlb_id);
        if (!mlbId) mlbId = await resolveMlbId(env, prop.pitcher_id, prop.canonical_name);
        const feedLine = await fetchPitchingLineFromGameFeed(Number(scheduledGame.gamePk), mlbId);
        if (feedLine) {
          game = feedLine;
          await env.DB.prepare(`
            INSERT INTO pitcher_game_stats (
              pitcher_id, game_date, opponent_team_id, innings_pitched, strikeouts,
              batters_faced, pitch_count, starter, walks, earned_runs, source, created_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(pitcher_id, game_date) DO UPDATE SET
              innings_pitched = excluded.innings_pitched,
              strikeouts = excluded.strikeouts,
              batters_faced = excluded.batters_faced,
              pitch_count = excluded.pitch_count,
              starter = excluded.starter,
              walks = excluded.walks,
              earned_runs = excluded.earned_runs,
              source = excluded.source
          `).bind(
            prop.pitcher_id,
            board.board_date,
            feedLine.innings_pitched,
            feedLine.strikeouts,
            feedLine.batters_faced,
            feedLine.pitch_count,
            feedLine.starter,
            feedLine.walks,
            feedLine.earned_runs,
            feedLine.source,
          ).run();
        }
      } catch (error) {
        warnings.push({
          prop_id: prop.prop_id,
          pitcher: prop.canonical_name,
          message: `Final-box-score fallback failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (!game || game.strikeouts == null) {
      const detailedState = String(scheduledGame?.status?.detailedState ?? "").trim();
      const normalizedState = detailedState.toLowerCase();

      if (scheduledGame && terminalVoidStates.has(normalizedState)) {
        await saveVoidResult(prop, "POSTPONED_OR_CANCELLED", `MLB Stats API: ${detailedState || "Postponed"}`);
        graded += 1;
        voids += 1;
        continue;
      }

      // A missing local row is not proof that a pitcher did not appear. Keep the
      // result pending for review unless MLB explicitly reports a postponed/cancelled game.
      warnings.push({
        prop_id: prop.prop_id,
        pitcher: prop.canonical_name,
        message: scheduledGame
          ? `No pitching line found after game-log and final-box-score checks; MLB game status is ${detailedState || "unknown"}. Result remains pending for review.`
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

    try {
      await recordLiveShadowCertificationMonitoring(env, scheduledTime, "AUTO_POST_GRADE");
    } catch (monitorError) {
      console.error("CERT_MONITOR post-grade capture failed:", monitorError);
    }

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


interface PlaySlipInput {
  board_id?: number;
  entry_name?: string;
  entry_type?: string;
  amount_wagered?: number;
  full_hit_multiplier?: number;
  power_play_multiplier?: number;
  flex_play_multiplier?: number;
  boost_percentage?: number;
  promo_label?: string;
  notes?: string;
  prop_ids?: number[];
  rules?: Array<{ eligible_legs?: number; hits?: number; multiplier?: number }>;
}

function money(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Response(JSON.stringify({ error: "Amount must be a non-negative number." }), { status: 400, headers: { "content-type": "application/json" } });
  return Math.round(n * 100) / 100;
}

function multiplier(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Response(JSON.stringify({ error: "Multiplier must be between 0 and 1000." }), { status: 400, headers: { "content-type": "application/json" } });
  return Math.round(n * 1000) / 1000;
}

async function playAudit(env: Env, slipId: number | null, eventType: string, details: Record<string, unknown>, email: string | null): Promise<void> {
  await env.DB.prepare(`INSERT INTO play_audit_events (slip_id, event_type, event_details, actor_email) VALUES (?, ?, ?, ?)`)
    .bind(slipId, eventType, JSON.stringify(details), email).run();
}

function analyzeMiss(row: Record<string, unknown>): { category: string; text: string } {
  const actual = Number(row.actual_strikeouts ?? 0);
  const projection = Number(row.projected_strikeouts ?? row.strikeout_line ?? 0);
  const innings = Number(row.innings_pitched ?? 0);
  const pitchCount = Number(row.pitch_count ?? 0);
  const battersFaced = Number(row.batters_faced ?? 0);
  const avgPc = Number(row.average_pitch_count_last_5 ?? 0);
  const avgBf = Number(row.average_bf_last_5 ?? 0);
  const side = String(row.preferred_side ?? "").toUpperCase();
  const reason = String(row.suggested_reason_code ?? "");

  if (reason.includes("INJURY") || reason.includes("EARLY") || innings > 0 && innings < 3) {
    return { category: "EARLY_EXIT", text: `The outing ended early (${innings || "limited"} IP), cutting off the volume needed to reach the ${side} side.` };
  }
  if (avgPc > 0 && pitchCount > 0 && pitchCount <= avgPc - 15) {
    return { category: "LOW_PITCH_COUNT", text: `Pitch count (${pitchCount}) was well below the recent five-start average (${avgPc.toFixed(1)}), reducing strikeout opportunity.` };
  }
  if (avgBf > 0 && battersFaced > 0 && battersFaced <= avgBf - 4) {
    return { category: "LOW_BATTERS_FACED", text: `Batters faced (${battersFaced}) came in below the recent baseline (${avgBf.toFixed(1)}), so the volume assumption missed.` };
  }
  if (side === "MORE" && actual + 1.5 < projection) {
    return { category: "STRIKEOUT_EFFICIENCY", text: `Actual strikeouts (${actual}) finished materially below the projection (${projection.toFixed(1)}). The miss was primarily strikeout efficiency rather than the offered line alone.` };
  }
  if (side === "LESS" && actual - 1.5 > projection) {
    return { category: "STRIKEOUT_EFFICIENCY", text: `Actual strikeouts (${actual}) materially exceeded the projection (${projection.toFixed(1)}). The pitcher generated more whiffs/finishes than the model expected.` };
  }
  return { category: "NORMAL_VARIANCE", text: `The result landed on the wrong side of the line without a clear workload failure. Treat this as normal game-level variance unless manual review identifies a lineup, role, weather, or command issue.` };
}

async function settleTrackedPlays(env: Env, boardId?: number): Promise<{ slips_checked: number; slips_settled: number; needs_review: number }> {
  const slips = await env.DB.prepare(`
    SELECT slip_id, entry_type, amount_wagered, full_hit_multiplier, power_play_multiplier, flex_play_multiplier, boost_percentage
    FROM play_slips
    WHERE status IN ('PENDING', 'NEEDS_REVIEW')
      AND (? IS NULL OR board_id = ?)
    ORDER BY slip_id
  `).bind(boardId ?? null, boardId ?? null).all<Record<string, unknown>>();

  let settled = 0;
  let review = 0;
  for (const slip of slips.results) {
    const slipId = Number(slip.slip_id);
    const legs = await env.DB.prepare(`
      SELECT l.leg_id, l.prop_id, l.preferred_side, l.strikeout_line,
             pr.actual_strikeouts, pr.result, pr.result_status, pr.source,
             pr.innings_pitched, pr.pitch_count, pr.batters_faced,
             pr.suggested_reason_code,
             r.projected_strikeouts,
             fs.average_pitch_count_last_5, fs.average_bf_last_5
      FROM play_slip_legs l
      LEFT JOIN prop_results pr ON pr.prop_id = l.prop_id
      LEFT JOIN recommendations r ON r.recommendation_id = l.recommendation_id
      LEFT JOIN feature_snapshots fs ON fs.feature_snapshot_id = (
        SELECT fs2.feature_snapshot_id FROM feature_snapshots fs2
        WHERE fs2.prop_id = l.prop_id
          AND (r.model_version_id IS NULL OR fs2.model_version_id = r.model_version_id)
        ORDER BY fs2.snapshot_time DESC, fs2.feature_snapshot_id DESC LIMIT 1
      )
      WHERE l.slip_id = ?
      ORDER BY l.leg_id
    `).bind(slipId).all<Record<string, unknown>>();

    let pending = 0, wins = 0, losses = 0, pushes = 0, voids = 0;
    for (const leg of legs.results) {
      const status = String(leg.result_status ?? "PENDING");
      const market = String(leg.result ?? "").toUpperCase();
      const side = String(leg.preferred_side ?? "").toUpperCase();
      let legResult = "PENDING";
      if (status === "GRADED") {
        if (market === "VOID") legResult = "VOID";
        else if (market === "PUSH") legResult = "PUSH";
        else if ((side === "MORE" && market === "OVER") || (side === "LESS" && market === "UNDER")) legResult = "WIN";
        else if (market === "OVER" || market === "UNDER") legResult = "LOSS";
      }
      if (legResult === "PENDING") pending += 1;
      if (legResult === "WIN") wins += 1;
      if (legResult === "LOSS") losses += 1;
      if (legResult === "PUSH") pushes += 1;
      if (legResult === "VOID") voids += 1;

      let analysisCategory: string | null = null;
      let analysisText: string | null = null;
      let analysisStatus = "PENDING";
      if (legResult === "LOSS") {
        const analysis = analyzeMiss(leg);
        analysisCategory = analysis.category;
        analysisText = analysis.text;
        analysisStatus = "AUTO";
      }
      await env.DB.prepare(`
        UPDATE play_slip_legs
        SET leg_result = ?, actual_strikeouts = ?, result_source = ?,
            postgame_category = CASE WHEN analysis_status = 'REVIEWED' THEN postgame_category ELSE ? END,
            postgame_analysis = CASE WHEN analysis_status = 'REVIEWED' THEN postgame_analysis ELSE ? END,
            analysis_status = CASE WHEN analysis_status = 'REVIEWED' THEN analysis_status ELSE ? END,
            updated_at = CURRENT_TIMESTAMP
        WHERE leg_id = ?
      `).bind(legResult, leg.actual_strikeouts ?? null, leg.source ?? null, analysisCategory, analysisText, analysisStatus, leg.leg_id).run();
    }

    if (pending > 0) continue;
    const eligible = wins + losses;
    const rules = await env.DB.prepare(`SELECT eligible_legs, hits, multiplier FROM play_slip_rules WHERE slip_id = ?`).bind(slipId).all<Record<string, unknown>>();
    const exact = rules.results.find(r => Number(r.eligible_legs) === eligible && Number(r.hits) === wins);
    const totalLegs = legs.results.length;
    let actualBaseMultiplier: number | null = null;
    let actualMultiplier: number | null = null;
    const boostPercent = Math.max(0, Number(slip.boost_percentage ?? 0));
    let status = "SETTLED";
    let note = "Settled automatically from prop results.";

    if (eligible === 0) {
      actualBaseMultiplier = 1;
      actualMultiplier = 1;
    } else if (exact) {
      actualBaseMultiplier = Number(exact.multiplier);
    } else if (String(slip.entry_type) === "POWER" && losses > 0) {
      actualBaseMultiplier = 0;
    } else if (wins === eligible && eligible === totalLegs) {
      actualBaseMultiplier = String(slip.entry_type) === "POWER"
        ? Number(slip.power_play_multiplier ?? slip.full_hit_multiplier)
        : Number(slip.flex_play_multiplier ?? slip.full_hit_multiplier);
    } else {
      status = "NEEDS_REVIEW";
      note = `No payout rule was saved for ${wins}/${eligible} after ${pushes} push(es) and ${voids} void(s).`;
    }

    if (actualMultiplier == null && actualBaseMultiplier != null) {
      actualMultiplier = Math.round(actualBaseMultiplier * (1 + boostPercent / 100) * 1000) / 1000;
      if (boostPercent > 0) note = `${note} Base ${actualBaseMultiplier}x with ${boostPercent}% boost = ${actualMultiplier}x.`;
    }

    const wagered = Number(slip.amount_wagered);
    const returned = actualMultiplier == null ? null : Math.round(wagered * actualMultiplier * 100) / 100;
    const net = returned == null ? null : Math.round((returned - wagered) * 100) / 100;
    await env.DB.prepare(`
      UPDATE play_slips SET status = ?, eligible_legs = ?, hit_count = ?, loss_count = ?, push_count = ?, void_count = ?,
        base_actual_multiplier = ?, actual_multiplier = ?, amount_returned = ?, net_profit = ?, settlement_note = ?,
        settled_at = CASE WHEN ? = 'SETTLED' THEN CURRENT_TIMESTAMP ELSE settled_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE slip_id = ?
    `).bind(status, eligible, wins, losses, pushes, voids, actualBaseMultiplier, actualMultiplier, returned, net, note, status, slipId).run();
    if (status === "SETTLED") settled += 1; else review += 1;
  }
  return { slips_checked: slips.results.length, slips_settled: settled, needs_review: review };
}

async function getPlaysPage(env: Env, url: URL): Promise<Response> {
  const boardIdRaw = Number(url.searchParams.get("board_id") ?? 0);
  const boardId = Number.isInteger(boardIdRaw) && boardIdRaw > 0 ? boardIdRaw : null;
  const warnings: string[] = [];

  // Board selection must remain available even when one of the richer joins or
  // the tracking tables has a schema/data problem. Start with the smallest
  // possible query and add prop counts separately.
  let boardRows: Record<string, unknown>[] = [];
  try {
    const boardResult = await env.DB.prepare(`
      SELECT board_id, board_date, board_name, status
      FROM boards
      ORDER BY board_date DESC, board_id DESC
      LIMIT 365
    `).all<Record<string, unknown>>();
    boardRows = boardResult.results;

    if (boardRows.length) {
      try {
        const counts = await env.DB.prepare(`
          SELECT board_id, COUNT(*) AS prop_count
          FROM props
          GROUP BY board_id
        `).all<Record<string, unknown>>();
        const countByBoard = new Map(counts.results.map(row => [Number(row.board_id), Number(row.prop_count ?? 0)]));
        boardRows = boardRows
          .map(row => ({ ...row, prop_count: countByBoard.get(Number(row.board_id)) ?? 0 }))
          .filter(row => Number(row.prop_count) > 0);
      } catch (error) {
        console.error("plays board prop-count query failed", error);
        warnings.push(`Board prop counts could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
        boardRows = boardRows.map(row => ({ ...row, prop_count: null }));
      }
    }
  } catch (error) {
    console.error("plays board list query failed", error);
    warnings.push(`Board list could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }

  let selected: Record<string, unknown> | null = null;
  try {
    selected = boardId
      ? await env.DB.prepare(`SELECT board_id, board_date, board_name, status FROM boards WHERE board_id = ?`).bind(boardId).first<Record<string, unknown>>()
      : boardRows[0] ?? null;
  } catch (error) {
    console.error("plays selected-board query failed", error);
    warnings.push(`Selected board could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const selectedId = Number(selected?.board_id ?? 0);

  let candidateRows: Record<string, unknown>[] = [];
  if (selectedId) {
    try {
      const candidates = await env.DB.prepare(`
        SELECT p.prop_id, p.strikeout_line, p.prop_type,
          pi.canonical_name AS pitcher, t.abbreviation AS opponent,
          r.recommendation_id, r.preferred_side, r.model_decision,
          r.confidence_score, r.projected_strikeouts,
          mv.version_name AS model_version,
          pr.actual_strikeouts, pr.result,
          CASE WHEN pr.result IS NULL THEN 'PENDING' ELSE 'GRADED' END AS result_status
        FROM props p
        JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id
        LEFT JOIN teams t ON t.team_id = p.opponent_team_id
        JOIN recommendations r ON r.recommendation_id = (
          SELECT r2.recommendation_id
          FROM recommendations r2
          WHERE r2.prop_id = p.prop_id
          ORDER BY r2.generated_at DESC, r2.recommendation_id DESC
          LIMIT 1
        )
        LEFT JOIN model_versions mv ON mv.model_version_id = r.model_version_id
        LEFT JOIN prop_results pr ON pr.prop_id = p.prop_id
        WHERE p.board_id = ?
          AND UPPER(r.preferred_side) IN ('MORE', 'LESS')
        ORDER BY
          CASE UPPER(COALESCE(r.model_decision, ''))
            WHEN 'PLAY' THEN 0
            WHEN 'LEAN' THEN 1
            WHEN 'WATCH' THEN 2
            ELSE 3
          END,
          COALESCE(r.confidence_score, 0) DESC,
          pi.canonical_name
      `).bind(selectedId).all<Record<string, unknown>>();
      candidateRows = candidates.results;
    } catch (error) {
      console.error("plays candidates query failed", error);
      warnings.push("Recommendations could not be loaded for the selected board.");
    }
  }

  let enriched: Record<string, unknown>[] = [];
  try {
    const slips = await env.DB.prepare(`
      SELECT s.*, b.board_name
      FROM play_slips s
      JOIN boards b ON b.board_id = s.board_id
      ORDER BY s.entry_date DESC, s.slip_id DESC
      LIMIT 150
    `).all<Record<string, unknown>>();
    const slipIds = slips.results.map(s => Number(s.slip_id)).filter(Number.isInteger);
    let legs: Record<string, unknown>[] = [];
    let rules: Record<string, unknown>[] = [];
    if (slipIds.length) {
      const marks = slipIds.map(() => "?").join(",");
      legs = (await env.DB.prepare(`SELECT * FROM play_slip_legs WHERE slip_id IN (${marks}) ORDER BY slip_id, leg_id`).bind(...slipIds).all<Record<string, unknown>>()).results;
      rules = (await env.DB.prepare(`SELECT * FROM play_slip_rules WHERE slip_id IN (${marks}) ORDER BY slip_id, eligible_legs DESC, hits DESC`).bind(...slipIds).all<Record<string, unknown>>()).results;
    }
    const bySlip = new Map<number, Record<string, unknown>[]>();
    const rulesBySlip = new Map<number, Record<string, unknown>[]>();
    for (const leg of legs) {
      const id = Number(leg.slip_id);
      bySlip.set(id, [...(bySlip.get(id) ?? []), leg]);
    }
    for (const rule of rules) {
      const id = Number(rule.slip_id);
      rulesBySlip.set(id, [...(rulesBySlip.get(id) ?? []), rule]);
    }
    enriched = slips.results.map(s => ({
      ...s,
      legs: bySlip.get(Number(s.slip_id)) ?? [],
      rules: rulesBySlip.get(Number(s.slip_id)) ?? [],
    }));
  } catch (error) {
    console.error("plays slip history query failed", error);
    warnings.push("Tracked-entry history is temporarily unavailable.");
  }

  let summary: Record<string, unknown> = {
    slips: 0,
    total_wagered: 0,
    total_returned: 0,
    net_profit: 0,
    pending_slips: 0,
    review_slips: 0,
  };
  try {
    summary = (await env.DB.prepare(`
      SELECT COUNT(*) AS slips,
        COALESCE(SUM(amount_wagered), 0) AS total_wagered,
        COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN amount_returned ELSE 0 END), 0) AS total_returned,
        COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN net_profit ELSE 0 END), 0) AS net_profit,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_slips,
        COALESCE(SUM(CASE WHEN status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END), 0) AS review_slips
      FROM play_slips
    `).first<Record<string, unknown>>()) ?? summary;
  } catch (error) {
    console.error("plays summary query failed", error);
    warnings.push("Wager totals are temporarily unavailable.");
  }

  let bankroll: Record<string, unknown> = { adjustment_total: 0 };
  try {
    bankroll = (await env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS adjustment_total FROM bankroll_transactions`).first<Record<string, unknown>>()) ?? bankroll;
  } catch (error) {
    console.error("plays bankroll query failed", error);
    warnings.push("Bankroll adjustments are temporarily unavailable.");
  }

  return json({
    boards: boardRows,
    selected_board: selected,
    candidates: candidateRows,
    slips: enriched,
    summary,
    bankroll,
    warnings,
  });
}

async function createPlaySlip(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  const input = await parseJson<PlaySlipInput>(request);
  const boardId = Number(input.board_id);
  const propIds = Array.isArray(input.prop_ids) ? [...new Set(input.prop_ids.map(Number).filter(Number.isInteger))] : [];
  if (!Number.isInteger(boardId) || boardId < 1 || propIds.length < 1) return json({ error: "Select a board and at least one play." }, { status: 400 });
  const entryType = String(input.entry_type ?? "POWER").toUpperCase();
  if (!['POWER','FLEX'].includes(entryType)) return json({ error: "Entry type must be POWER or FLEX." }, { status: 400 });
  const amount = money(input.amount_wagered);
  const legacyFull = multiplier(input.full_hit_multiplier ?? 0);
  const power = multiplier(input.power_play_multiplier ?? legacyFull);
  const flexFull = multiplier(input.flex_play_multiplier ?? legacyFull);
  const boostPercent = Number(input.boost_percentage ?? 0);
  if (!Number.isFinite(boostPercent) || boostPercent < 0 || boostPercent > 1000) return json({ error: "Boost percentage must be between 0 and 1000." }, { status: 400 });
  const full = entryType === 'POWER' ? power : flexFull;
  const board = await env.DB.prepare(`SELECT board_id, board_date FROM boards WHERE board_id = ?`).bind(boardId).first<{ board_id: number; board_date: string }>();
  if (!board) return json({ error: "Board not found." }, { status: 404 });
  const placeholders = propIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(`
    SELECT p.prop_id, p.strikeout_line, p.prop_type, pi.canonical_name pitcher, t.abbreviation opponent,
      r.recommendation_id, r.preferred_side, r.model_decision, r.confidence_score, mv.version_name model_version
    FROM props p JOIN pitchers pi ON pi.pitcher_id=p.pitcher_id
    LEFT JOIN teams t ON t.team_id=p.opponent_team_id
    LEFT JOIN recommendations r ON r.recommendation_id=(SELECT r2.recommendation_id FROM recommendations r2 WHERE r2.prop_id=p.prop_id ORDER BY r2.generated_at DESC,r2.recommendation_id DESC LIMIT 1)
    LEFT JOIN model_versions mv ON mv.model_version_id=r.model_version_id
    WHERE p.board_id=? AND p.prop_id IN (${placeholders})
  `).bind(boardId, ...propIds).all<Record<string, unknown>>();
  if (rows.results.length !== propIds.length || rows.results.some(r => !r.preferred_side)) return json({ error: "One or more selected props has no recommendation." }, { status: 409 });
  const insert = await env.DB.prepare(`INSERT INTO play_slips (board_id,entry_date,entry_name,entry_type,amount_wagered,full_hit_multiplier,power_play_multiplier,flex_play_multiplier,boost_percentage,promo_label,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(boardId, board.board_date, String(input.entry_name ?? '').trim() || null, entryType, amount, full, power, flexFull, Math.round(boostPercent * 100) / 100, String(input.promo_label ?? '').trim() || null, String(input.notes ?? '').trim() || null, identity.email).run();
  const slipId = Number(insert.meta.last_row_id);
  const statements = rows.results.map(r => env.DB.prepare(`INSERT INTO play_slip_legs (slip_id,prop_id,recommendation_id,pitcher_name,opponent,strikeout_line,preferred_side,prop_type,model_decision,confidence_score,model_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(slipId,r.prop_id,r.recommendation_id,r.pitcher,r.opponent,r.strikeout_line,r.preferred_side,r.prop_type,r.model_decision,r.confidence_score,r.model_version));
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const cleanedRules = rules.map(r => ({ eligible: Number(r.eligible_legs), hits: Number(r.hits), mult: multiplier(r.multiplier) }))
    .filter(r => Number.isInteger(r.eligible) && r.eligible > 0 && Number.isInteger(r.hits) && r.hits >= 0 && r.hits <= r.eligible);
  if (!cleanedRules.some(r => r.eligible === propIds.length && r.hits === propIds.length)) cleanedRules.push({ eligible: propIds.length, hits: propIds.length, mult: full });
  if (entryType === 'FLEX') {
    const requiredPartialHits = propIds.length === 3 ? [2] : propIds.length === 4 ? [3] : propIds.length === 5 ? [4, 3] : [];
    const missing = requiredPartialHits.filter(h => !cleanedRules.some(r => r.eligible === propIds.length && r.hits === h));
    if (missing.length) return json({ error: `Enter Flex payout multiplier(s) for ${missing.map(h => `${h}/${propIds.length}`).join(', ')}.` }, { status: 400 });
  }
  statements.push(...cleanedRules.map(r => env.DB.prepare(`INSERT OR REPLACE INTO play_slip_rules (slip_id,eligible_legs,hits,multiplier) VALUES (?,?,?,?)`).bind(slipId,r.eligible,r.hits,r.mult)));
  await env.DB.batch(statements);
  await playAudit(env, slipId, 'SLIP_CREATED', { board_id: boardId, prop_ids: propIds, amount_wagered: amount, entry_type: entryType }, identity.email);
  await settleTrackedPlays(env, boardId);
  return json({ ok: true, slip_id: slipId }, { status: 201 });
}

async function updatePlayAnalysis(request: Request, env: Env, identity: AccessIdentity, legId: number): Promise<Response> {
  const input = await parseJson<{ postgame_category?: string; postgame_analysis?: string }>(request);
  const existing = await env.DB.prepare(`SELECT leg_id, slip_id FROM play_slip_legs WHERE leg_id=?`).bind(legId).first<{leg_id:number;slip_id:number}>();
  if (!existing) return json({ error: "Tracked leg not found." }, { status: 404 });
  await env.DB.prepare(`UPDATE play_slip_legs SET postgame_category=?, postgame_analysis=?, analysis_status='REVIEWED', updated_at=CURRENT_TIMESTAMP WHERE leg_id=?`)
    .bind(String(input.postgame_category ?? '').trim() || null, String(input.postgame_analysis ?? '').trim() || null, legId).run();
  await playAudit(env, existing.slip_id, 'POSTGAME_ANALYSIS_UPDATED', { leg_id: legId }, identity.email);
  return json({ ok: true });
}

async function deletePlaySlip(env: Env, identity: AccessIdentity, slipId: number): Promise<Response> {
  const slip = await env.DB.prepare(`SELECT status FROM play_slips WHERE slip_id=?`).bind(slipId).first<{status:string}>();
  if (!slip) return json({ error: "Slip not found." }, { status: 404 });
  await playAudit(env, slipId, 'SLIP_DELETED', { status: slip.status }, identity.email);
  await env.DB.prepare(`DELETE FROM play_slips WHERE slip_id=?`).bind(slipId).run();
  return json({ ok: true });
}

async function addBankrollTransaction(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  const input = await parseJson<{ transaction_date?: string; transaction_type?: string; amount?: number; note?: string }>(request);
  const type = String(input.transaction_type ?? '').toUpperCase();
  if (!['STARTING_BALANCE','DEPOSIT','WITHDRAWAL','ADJUSTMENT'].includes(type)) return json({ error: "Invalid transaction type." }, { status: 400 });
  let amount = Number(input.amount);
  if (!Number.isFinite(amount)) return json({ error: "Amount is required." }, { status: 400 });
  if (type === 'WITHDRAWAL' && amount > 0) amount *= -1;
  const date = validateDate(input.transaction_date ?? new Date().toISOString().slice(0,10));
  await env.DB.prepare(`INSERT INTO bankroll_transactions (transaction_date,transaction_type,amount,note,created_by) VALUES (?,?,?,?,?)`).bind(date,type,Math.round(amount*100)/100,String(input.note??'').trim()||null,identity.email).run();
  return json({ ok: true }, { status: 201 });
}



type HistoricalDatasetCandidate = {
  prop_feature_snapshot_id: number;
  prop_id: number;
  board_id: number;
  board_date: string;
  model_version_id: number;
  pitcher_id: number;
  opponent_team_id: number | null;
  pitcher_hand: string | null;
  prop_line: number;
  captured_at: string;
  information_cutoff_at: string;
  pitcher_source_cutoff_date: string | null;
  team_source_cutoff_date: string | null;
  snapshot_status: string;
  overall_data_quality_score: number | null;
  data_quality_grade: string | null;
  quality_gate: string | null;
  challenger_eligible: number;
  pitcher_features_json: string | null;
  team_features_json: string | null;
  quality_flags_json: string | null;
  critical_quality_flags_json: string | null;
  context_json: string | null;
  model_prediction_id: number | null;
  projected_strikeouts: number | null;
  raw_more_probability: number | null;
  raw_less_probability: number | null;
  calibrated_more_probability: number | null;
  calibrated_less_probability: number | null;
  preferred_side: string | null;
  model_edge: number | null;
  model_decision: string | null;
  confidence_score: number | null;
  confidence_label: string | null;
  actual_strikeouts: number | null;
  market_result: string | null;
  graded_at: string | null;
  innings_pitched: number | null;
  pitch_count: number | null;
  batters_faced: number | null;
  starter: number | null;
};

function historicalOutcome(side: 'MORE' | 'LESS', marketResult: string): string | null {
  const result = marketResult.toUpperCase();
  if (result === 'PUSH') return 'PUSH';
  if (result === 'VOID') return 'VOID';
  if (result !== 'OVER' && result !== 'UNDER') return null;
  if (side === 'MORE') return result === 'OVER' ? 'WIN' : 'LOSS';
  return result === 'UNDER' ? 'WIN' : 'LOSS';
}

function featureCutoffStatus(row: HistoricalDatasetCandidate): 'PASS' | 'UNKNOWN' | 'FAIL' {
  const boardDate = String(row.board_date ?? '').slice(0, 10);
  const pitcherCutoff = String(row.pitcher_source_cutoff_date ?? '').slice(0, 10);
  const teamCutoff = String(row.team_source_cutoff_date ?? '').slice(0, 10);
  if (!boardDate || !pitcherCutoff || !teamCutoff) return 'UNKNOWN';
  if (pitcherCutoff >= boardDate || teamCutoff >= boardDate) return 'FAIL';
  return 'PASS';
}



type HistoricalReconstructionCandidate = {
  prop_id: number; board_id: number; board_date: string; strikeout_line: number;
  pitcher_id: number; opponent_team_id: number | null; pitcher_hand: string | null;
  recommendation_id: number | null; model_version_id: number | null; recommendation_generated_at: string | null;
  projected_strikeouts: number | null; model_edge: number | null; estimated_over_rate: number | null;
  preferred_side: string | null; model_decision: string | null; final_decision: string | null;
  confidence_score: number | null; confidence_band: string | null;
  legacy_feature_snapshot_id: number | null; legacy_snapshot_time: string | null;
  last_3_k_avg: number | null; last_5_k_avg: number | null; last_10_k_avg: number | null;
  average_ip_last_3: number | null; average_bf_last_5: number | null; average_pitch_count_last_5: number | null;
  starter_rate_last_10: number | null; form_delta_l3_l10: number | null;
  opponent_k_rate: number | null; season_opponent_k_rate: number | null; recent_30_k_rate: number | null;
  recent_14_k_rate: number | null; opponent_trend_delta: number | null; opponent_sample_confidence: string | null;
  same_opponent_start_count: number | null; same_opponent_k_avg: number | null; same_opponent_bf_avg: number | null;
  prop_result_id: number | null; actual_strikeouts: number | null; market_result: string | null; graded_at: string | null;
};

type ReconstructionStart = { game_date: string; strikeouts: number; batters_faced: number; innings_pitched: number; pitch_count: number; starter: number };

function reconstructionMean(values: number[]): number | null {
  const clean = values.filter(v => Number.isFinite(v));
  return clean.length ? clean.reduce((a,b)=>a+b,0)/clean.length : null;
}
function reconstructionRatio(n: number, d: number): number | null { return d > 0 ? n/d : null; }
function reconstructionRound(v: number | null, digits=6): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const m=10**digits; return Math.round(v*m)/m;
}

async function runHistoricalFeatureReconstruction(request: Request, env: Env): Promise<Response> {
  const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(()=>({} as Record<string, unknown>));
  const requested = Math.max(1, Math.min(50, Number(body.limit ?? 25) || 25));
  const latestCursor = await env.DB.prepare(`
    SELECT COALESCE(MAX(cursor_end_prop_id),0) AS cursor
    FROM historical_feature_reconstruction_runs
    WHERE status IN ('SUCCEEDED','PARTIAL')
  `).first<{cursor:number}>();
  let cursor = Number(latestCursor?.cursor ?? 0);
  if (Number(body.restart ?? 0) === 1) cursor = 0;

  const runInsert = await env.DB.prepare(`
    INSERT INTO historical_feature_reconstruction_runs
      (run_uuid,reconstruction_version,status,trigger_source,cursor_start_prop_id,started_at)
    VALUES (?,'historical-reconstruction-v1','RUNNING','ADMIN',?,CURRENT_TIMESTAMP)
  `).bind(crypto.randomUUID(), cursor).run();
  const runId = Number(runInsert.meta.last_row_id);

  try {
    const candidates = await env.DB.prepare(`
      SELECT
        p.prop_id,p.board_id,b.board_date,p.strikeout_line,p.pitcher_id,p.opponent_team_id,
        pi.throws_hand AS pitcher_hand,
        r.recommendation_id,r.model_version_id,r.generated_at AS recommendation_generated_at,
        r.projected_strikeouts,r.model_edge,r.estimated_over_rate,r.preferred_side,r.model_decision,r.final_decision,
        r.confidence_score,r.confidence_band,
        fs.feature_snapshot_id AS legacy_feature_snapshot_id,fs.snapshot_time AS legacy_snapshot_time,
        fs.last_3_k_avg,fs.last_5_k_avg,fs.last_10_k_avg,fs.average_ip_last_3,fs.average_bf_last_5,
        fs.average_pitch_count_last_5,fs.starter_rate_last_10,fs.form_delta_l3_l10,fs.opponent_k_rate,
        fs.season_opponent_k_rate,fs.recent_30_k_rate,fs.recent_14_k_rate,fs.opponent_trend_delta,
        fs.opponent_sample_confidence,fs.same_opponent_start_count,fs.same_opponent_k_avg,fs.same_opponent_bf_avg,
        pr.prop_result_id,pr.actual_strikeouts,pr.result AS market_result,pr.graded_at
      FROM props p
      JOIN boards b ON b.board_id=p.board_id
      JOIN pitchers pi ON pi.pitcher_id=p.pitcher_id
      JOIN prop_results pr ON pr.prop_id=p.prop_id AND pr.result_status<>'PENDING'
      LEFT JOIN recommendations r ON r.recommendation_id=(
        SELECT r2.recommendation_id FROM recommendations r2 WHERE r2.prop_id=p.prop_id
        ORDER BY r2.generated_at DESC,r2.recommendation_id DESC LIMIT 1
      )
      LEFT JOIN feature_snapshots fs ON fs.feature_snapshot_id=(
        SELECT fs2.feature_snapshot_id FROM feature_snapshots fs2 WHERE fs2.prop_id=p.prop_id
        ORDER BY fs2.snapshot_time DESC,fs2.feature_snapshot_id DESC LIMIT 1
      )
      WHERE p.prop_id>?
        AND NOT EXISTS (SELECT 1 FROM prop_feature_snapshots pfs WHERE pfs.prop_id=p.prop_id)
      ORDER BY p.prop_id
      LIMIT ?
    `).bind(cursor, requested).all<HistoricalReconstructionCandidate>();

    let a=0,b=0,incomplete=0, inserted=0, endCursor=cursor;
    for (const row of candidates.results ?? []) {
      endCursor=Math.max(endCursor,Number(row.prop_id));
      const startsRes=await env.DB.prepare(`
        SELECT game_date,COALESCE(strikeouts,0) strikeouts,COALESCE(batters_faced,0) batters_faced,
               COALESCE(innings_pitched,0) innings_pitched,COALESCE(pitch_count,0) pitch_count,COALESCE(starter,1) starter
        FROM pitcher_game_stats
        WHERE pitcher_id=? AND starter=1 AND game_date<?
        ORDER BY game_date DESC LIMIT 40
      `).bind(row.pitcher_id,row.board_date).all<ReconstructionStart>();
      const starts=startsRes.results ?? [];
      const l3=starts.slice(0,3), l5=starts.slice(0,5), l10=starts.slice(0,10);
      const sum=(rs:ReconstructionStart[], key:keyof ReconstructionStart)=>rs.reduce((n,x)=>n+Number(x[key]??0),0);
      const latestPitcherGame=starts[0]?.game_date ?? null;
      const pitcherJson={
        source:'RECONSTRUCTED_FROM_PITCHER_GAME_STATS',board_date:row.board_date,source_rule:'game_date < board_date',
        starts_before_board:starts.length,last_start_date:latestPitcherGame,
        season_k_per_bf:reconstructionRound(reconstructionRatio(sum(starts,'strikeouts'),sum(starts,'batters_faced'))),
        season_avg_strikeouts:reconstructionRound(reconstructionMean(starts.map(x=>Number(x.strikeouts)))),
        season_avg_batters_faced:reconstructionRound(reconstructionMean(starts.map(x=>Number(x.batters_faced)))),
        season_avg_innings:reconstructionRound(reconstructionMean(starts.map(x=>Number(x.innings_pitched)))),
        season_avg_pitch_count:reconstructionRound(reconstructionMean(starts.map(x=>Number(x.pitch_count)))),
        last3_k_per_bf:reconstructionRound(reconstructionRatio(sum(l3,'strikeouts'),sum(l3,'batters_faced'))),
        last3_avg_strikeouts:reconstructionRound(reconstructionMean(l3.map(x=>Number(x.strikeouts)))),
        last5_k_per_bf:reconstructionRound(reconstructionRatio(sum(l5,'strikeouts'),sum(l5,'batters_faced'))),
        last5_avg_strikeouts:reconstructionRound(reconstructionMean(l5.map(x=>Number(x.strikeouts)))),
        last5_avg_batters_faced:reconstructionRound(reconstructionMean(l5.map(x=>Number(x.batters_faced)))),
        last5_avg_innings:reconstructionRound(reconstructionMean(l5.map(x=>Number(x.innings_pitched)))),
        last5_avg_pitch_count:reconstructionRound(reconstructionMean(l5.map(x=>Number(x.pitch_count)))),
        last10_avg_strikeouts:reconstructionRound(reconstructionMean(l10.map(x=>Number(x.strikeouts))))
      };
      const opponentJson=row.legacy_feature_snapshot_id?{
        source:'LEGACY_FEATURE_SNAPSHOT',snapshot_time:row.legacy_snapshot_time,
        opponent_k_rate:row.opponent_k_rate,season_opponent_k_rate:row.season_opponent_k_rate,
        recent_30_k_rate:row.recent_30_k_rate,recent_14_k_rate:row.recent_14_k_rate,
        opponent_trend_delta:row.opponent_trend_delta,opponent_sample_confidence:row.opponent_sample_confidence,
        same_opponent_start_count:row.same_opponent_start_count,same_opponent_k_avg:row.same_opponent_k_avg,
        same_opponent_bf_avg:row.same_opponent_bf_avg
      }:null;
      const modelJson=row.recommendation_id?{
        source:'LEGACY_RECOMMENDATION',recommendation_generated_at:row.recommendation_generated_at,
        projected_strikeouts:row.projected_strikeouts,model_edge:row.model_edge,estimated_over_rate:row.estimated_over_rate,
        preferred_side:row.preferred_side,model_decision:row.model_decision,final_decision:row.final_decision,
        confidence_score:row.confidence_score,confidence_band:row.confidence_band
      }:null;
      const hand=String(row.pitcher_hand??'').toUpperCase().startsWith('L')?'L':String(row.pitcher_hand??'').toUpperCase().startsWith('R')?'R':null;
      const opponentAvailable=!!row.legacy_feature_snapshot_id && [row.season_opponent_k_rate,row.opponent_k_rate,row.recent_30_k_rate,row.recent_14_k_rate].some(v=>typeof v==='number' && Number.isFinite(v));
      const reasons:string[]=[];
      if(!hand) reasons.push('pitcher_hand_missing');
      if(starts.length<3) reasons.push('fewer_than_3_prior_starts');
      if(!row.legacy_feature_snapshot_id) reasons.push('legacy_feature_snapshot_missing');
      if(!opponentAvailable) reasons.push('opponent_context_missing');
      if(!row.recommendation_id) reasons.push('legacy_recommendation_missing');
      if(!row.prop_result_id) reasons.push('graded_result_missing');
      const legacyDate=String(row.legacy_snapshot_time??'').slice(0,10);
      if(legacyDate && legacyDate>row.board_date) reasons.push('legacy_snapshot_after_board_date');
      let score=100;
      if(starts.length<10) score-=10;
      if(starts.length<5) score-=15;
      if(!opponentAvailable) score-=25;
      if(!row.recommendation_id) score-=20;
      if(!hand) score-=20;
      if(!row.legacy_feature_snapshot_id) score-=20;
      score=Math.max(0,Math.min(100,score));
      let klass:'RECONSTRUCTED_A_CANDIDATE'|'RECONSTRUCTED_B_CANDIDATE'|'INCOMPLETE';
      if(hand && starts.length>=5 && opponentAvailable && row.recommendation_id && row.prop_result_id && !reasons.includes('legacy_snapshot_after_board_date')) klass='RECONSTRUCTED_A_CANDIDATE';
      else if(hand && starts.length>=3 && row.recommendation_id && row.prop_result_id && row.legacy_feature_snapshot_id) klass='RECONSTRUCTED_B_CANDIDATE';
      else klass='INCOMPLETE';
      if(klass==='RECONSTRUCTED_A_CANDIDATE') a++; else if(klass==='RECONSTRUCTED_B_CANDIDATE') b++; else incomplete++;
      await env.DB.prepare(`
        INSERT INTO historical_feature_reconstructions (
          reconstruction_run_id,reconstruction_version,prop_id,board_id,board_date,model_version_id,recommendation_id,
          legacy_feature_snapshot_id,prop_result_id,pitcher_id,opponent_team_id,pitcher_hand,prop_line,recommendation_generated_at,
          legacy_snapshot_time,latest_pitcher_game_date,pitcher_starts_before_board,pitcher_last5_complete,opponent_context_available,
          result_available,model_output_available,reconstruction_class,reconstruction_score,blocking_reasons_json,evidence_json,
          pitcher_features_json,opponent_features_json,model_output_json,actual_strikeouts,market_result,graded_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        runId,'historical-reconstruction-v1',row.prop_id,row.board_id,row.board_date,row.model_version_id,row.recommendation_id,
        row.legacy_feature_snapshot_id,row.prop_result_id,row.pitcher_id,row.opponent_team_id,hand,row.strikeout_line,row.recommendation_generated_at,
        row.legacy_snapshot_time,latestPitcherGame,starts.length,starts.length>=5?1:0,opponentAvailable?1:0,row.prop_result_id?1:0,row.recommendation_id?1:0,
        klass,score,JSON.stringify(reasons),JSON.stringify({strict_pitcher_cutoff:'game_date < board_date',legacy_snapshot_date:legacyDate||null,native_snapshot_absent:true}),
        JSON.stringify(pitcherJson),opponentJson?JSON.stringify(opponentJson):null,modelJson?JSON.stringify(modelJson):null,
        row.actual_strikeouts,row.market_result,row.graded_at
      ).run();
      inserted++;
    }
    const status='SUCCEEDED';
    await env.DB.prepare(`
      UPDATE historical_feature_reconstruction_runs SET status=?,completed_at=CURRENT_TIMESTAMP,cursor_end_prop_id=?,candidates_seen=?,
        rows_inserted=?,candidate_a_count=?,candidate_b_count=?,incomplete_count=?,details_json=? WHERE reconstruction_run_id=?
    `).bind(status,endCursor,candidates.results.length,inserted,a,b,incomplete,JSON.stringify({batch_limit:requested,next_cursor:endCursor,does_not_modify_native_snapshots:true}),runId).run();
    return json({ok:true,reconstruction_run_id:runId,status,cursor_start:cursor,cursor_end:endCursor,candidates_seen:candidates.results.length,rows_inserted:inserted,candidate_a:a,candidate_b:b,incomplete,has_more:candidates.results.length===requested});
  } catch(error) {
    await env.DB.prepare(`UPDATE historical_feature_reconstruction_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE reconstruction_run_id=?`)
      .bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),runId).run();
    throw error;
  }
}

async function getHistoricalFeatureReconstructionStatus(env: Env): Promise<Response> {
  const summary=await env.DB.prepare(`
    WITH latest AS (
      SELECT h.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_reconstruction_id DESC) rn
      FROM historical_feature_reconstructions h
    )
    SELECT COUNT(*) reconstructed_rows,
      SUM(CASE WHEN reconstruction_class='RECONSTRUCTED_A_CANDIDATE' THEN 1 ELSE 0 END) candidate_a,
      SUM(CASE WHEN reconstruction_class='RECONSTRUCTED_B_CANDIDATE' THEN 1 ELSE 0 END) candidate_b,
      SUM(CASE WHEN reconstruction_class='INCOMPLETE' THEN 1 ELSE 0 END) incomplete,
      MIN(board_date) board_date_min,MAX(board_date) board_date_max
    FROM latest WHERE rn=1
  `).first<Record<string,unknown>>();
  const total=await env.DB.prepare(`
    SELECT COUNT(*) total_candidates FROM props p JOIN prop_results pr ON pr.prop_id=p.prop_id AND pr.result_status<>'PENDING'
    WHERE NOT EXISTS(SELECT 1 FROM prop_feature_snapshots pfs WHERE pfs.prop_id=p.prop_id)
  `).first<Record<string,unknown>>();
  const rows=await env.DB.prepare(`
    WITH latest AS (SELECT h.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_reconstruction_id DESC) rn FROM historical_feature_reconstructions h)
    SELECT h.*,pi.canonical_name pitcher_name,t.abbreviation opponent
    FROM latest h JOIN pitchers pi ON pi.pitcher_id=h.pitcher_id LEFT JOIN teams t ON t.team_id=h.opponent_team_id
    WHERE h.rn=1 ORDER BY h.board_date DESC,h.prop_id DESC LIMIT 100
  `).all<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM historical_feature_reconstruction_runs ORDER BY reconstruction_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  return json({summary:{...summary,total_candidates:Number(total?.total_candidates??0)},rows:rows.results,runs:runs.results});
}

type CertificationSourceRow = Record<string, unknown>;

async function hydrateHistoricalCertificationCutoffs(env: Env): Promise<{dates_checked:number; games_hydrated:number; game_pks_hydrated:number; unresolved_games:number; unresolved_dates:string[]; errors:string[]}> {
  const localGames = await env.DB.prepare(`
    WITH latest AS (
      SELECT h.*,ROW_NUMBER() OVER(PARTITION BY h.prop_id ORDER BY h.historical_reconstruction_id DESC) rn
      FROM historical_feature_reconstructions h
    )
    SELECT DISTINCT g.game_id,g.game_date,g.mlb_game_pk,g.scheduled_start,
      at.abbreviation AS away_abbreviation,ht.abbreviation AS home_abbreviation
    FROM latest h
    JOIN props p ON p.prop_id=h.prop_id
    JOIN games g ON g.game_id=p.game_id
    LEFT JOIN teams at ON at.team_id=g.away_team_id
    LEFT JOIN teams ht ON ht.team_id=g.home_team_id
    WHERE h.rn=1 AND g.scheduled_start IS NULL
      AND g.game_date IS NOT NULL
      AND at.abbreviation IS NOT NULL AND ht.abbreviation IS NOT NULL
    ORDER BY g.game_date,g.game_id
    LIMIT 300
  `).all<{game_id:number;game_date:string;mlb_game_pk:number|null;scheduled_start:string|null;away_abbreviation:string;home_abbreviation:string}>();

  const rows=(localGames.results??[]).map(row=>({
    game_id:Number(row.game_id),game_date:String(row.game_date??'').slice(0,10),
    mlb_game_pk:row.mlb_game_pk==null?null:Number(row.mlb_game_pk),
    away_abbreviation:String(row.away_abbreviation??''),home_abbreviation:String(row.home_abbreviation??'')
  })).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.game_date));

  const dateOffset=(date:string,days:number)=>{
    const d=new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate()+days);
    return d.toISOString().slice(0,10);
  };

  // Older imported game_date values were derived from the UTC MLB gameDate.
  // The MLB schedule endpoint groups games by local baseball date, so evening
  // games can appear one calendar day earlier there. Search a strict +/-1-day
  // window, then require an exact away/home MLB team-id match.
  const queryDates=Array.from(new Set(rows.flatMap(r=>[
    dateOffset(r.game_date,-1),r.game_date,dateOffset(r.game_date,1)
  ]))).sort().slice(0,60);
  const scheduleByDate=new Map<string,MlbScheduleSyncGame[]>();
  const errors:string[]=[];

  for(const date of queryDates){
    try{
      const endpoint=new URL('https://statsapi.mlb.com/api/v1/schedule');
      endpoint.searchParams.set('sportId','1');
      endpoint.searchParams.set('startDate',date);
      endpoint.searchParams.set('endDate',date);
      endpoint.searchParams.set('hydrate','team');
      const payload=await fetchMlbJson(endpoint.toString()) as {dates?:Array<{games?:MlbScheduleSyncGame[]}>};
      scheduleByDate.set(date,(payload.dates??[]).flatMap(d=>d.games??[]));
    }catch(error){
      errors.push(`${date}: ${error instanceof Error ? error.message : String(error)}`);
      scheduleByDate.set(date,[]);
    }
  }

  let hydrated=0;
  let gamePksHydrated=0;
  let unresolvedGames=0;
  const unresolvedDateSet=new Set<string>();
  const updates:D1PreparedStatement[]=[];

  for(const local of rows){
    const awayId=MLB_TEAM_IDS[normalizedMlbTeamAbbreviation(local.away_abbreviation)];
    const homeId=MLB_TEAM_IDS[normalizedMlbTeamAbbreviation(local.home_abbreviation)];
    if(!awayId||!homeId){
      unresolvedGames++;
      unresolvedDateSet.add(local.game_date);
      continue;
    }

    const candidateDates=[dateOffset(local.game_date,-1),local.game_date,dateOffset(local.game_date,1)];
    let match:MlbScheduleSyncGame|undefined;
    if(local.mlb_game_pk){
      for(const date of candidateDates){
        match=(scheduleByDate.get(date)??[]).find(g=>Number(g.gamePk??0)===local.mlb_game_pk);
        if(match) break;
      }
    }
    if(!match){
      for(const date of candidateDates){
        match=(scheduleByDate.get(date)??[]).find(g=>
          Number(g.teams?.away?.team?.id??0)===awayId &&
          Number(g.teams?.home?.team?.id??0)===homeId
        );
        if(match) break;
      }
    }

    const gamePk=Number(match?.gamePk??0);
    const scheduledStart=String(match?.gameDate??'');
    if(!gamePk||!scheduledStart){
      unresolvedGames++;
      unresolvedDateSet.add(local.game_date);
      continue;
    }

    // Legacy imported rows may duplicate a newer canonical Schedule Sync row that
    // already owns this MLB gamePk. The gamePk column is UNIQUE, so copying it
    // onto the legacy row would fail certification. The backfill only needs the
    // exact pregame cutoff, so hydrate scheduled_start on the legacy row and
    // leave ownership of the unique gamePk with the canonical row.
    updates.push(env.DB.prepare(`
      UPDATE games
      SET scheduled_start=?,updated_at=CURRENT_TIMESTAMP
      WHERE game_id=? AND scheduled_start IS NULL
    `).bind(scheduledStart,local.game_id));
  }

  for(let i=0;i<updates.length;i+=40){
    const results=await env.DB.batch(updates.slice(i,i+40));
    hydrated+=results.reduce((sum,r)=>sum+Number(r.meta.changes??0),0);
  }

  return {
    dates_checked:queryDates.length,
    games_hydrated:hydrated,
    game_pks_hydrated:gamePksHydrated,
    unresolved_games:unresolvedGames,
    unresolved_dates:Array.from(unresolvedDateSet).sort(),
    errors
  };
}



type IndependentHistoricalCandidate = {
  prop_id:number; board_id:number; board_date:string; game_id:number|null; scheduled_start:string|null;
  pitcher_id:number; opponent_team_id:number|null; pitcher_hand:string|null; strikeout_line:number;
  available_side:string|null; prop_type:string|null; actual_strikeouts:number|null; market_result:string|null; graded_at:string|null;
};

async function runIndependentHistoricalReconstruction(request: Request, env: Env): Promise<Response> {
  const body:Record<string,unknown>=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
  const requested=Math.max(1,Math.min(50,Number(body.limit??25)||25));
  const latest=await env.DB.prepare(`SELECT COALESCE(MAX(cursor_end_prop_id),0) cursor FROM independent_historical_reconstruction_runs WHERE status IN ('SUCCEEDED','PARTIAL')`).first<{cursor:number}>();
  let cursor=Number(latest?.cursor??0); if(Number(body.restart??0)===1)cursor=0;
  const ri=await env.DB.prepare(`INSERT INTO independent_historical_reconstruction_runs(run_uuid,reconstruction_version,status,trigger_source,cursor_start_prop_id,started_at) VALUES (?,'independent-reconstruction-v1','RUNNING','ADMIN',?,CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(),cursor).run();
  const runId=Number(ri.meta.last_row_id);
  try {
    const rows=await env.DB.prepare(`
      SELECT p.prop_id,p.board_id,b.board_date,p.game_id,g.scheduled_start,p.pitcher_id,p.opponent_team_id,
             pi.throws_hand pitcher_hand,p.strikeout_line,p.available_side,p.prop_type,
             pr.actual_strikeouts,pr.result market_result,pr.graded_at
      FROM props p JOIN boards b ON b.board_id=p.board_id JOIN pitchers pi ON pi.pitcher_id=p.pitcher_id
      JOIN prop_results pr ON pr.prop_id=p.prop_id AND pr.result_status<>'PENDING'
      LEFT JOIN games g ON g.game_id=p.game_id
      WHERE p.prop_id>? AND NOT EXISTS(SELECT 1 FROM prop_feature_snapshots pfs WHERE pfs.prop_id=p.prop_id)
      ORDER BY p.prop_id LIMIT ?
    `).bind(cursor,requested).all<IndependentHistoricalCandidate>();
    let inserted=0,ready=0,incomplete=0,endCursor=cursor;
    for(const row of rows.results??[]){
      endCursor=Math.max(endCursor,Number(row.prop_id));
      const startsRes=await env.DB.prepare(`SELECT game_date,COALESCE(strikeouts,0) strikeouts,COALESCE(batters_faced,0) batters_faced,COALESCE(innings_pitched,0) innings_pitched,COALESCE(pitch_count,0) pitch_count,COALESCE(starter,1) starter,opponent_team_id FROM pitcher_game_stats WHERE pitcher_id=? AND starter=1 AND game_date<? ORDER BY game_date DESC LIMIT 40`).bind(row.pitcher_id,row.board_date).all<ReconstructionStart & {opponent_team_id:number|null}>();
      const starts=startsRes.results??[]; const l3=starts.slice(0,3),l5=starts.slice(0,5),l10=starts.slice(0,10);
      const sum=(rs:any[],k:string)=>rs.reduce((n,x)=>n+Number(x[k]??0),0);
      const mean=(rs:any[],k:string)=>rs.length?rs.reduce((n,x)=>n+Number(x[k]??0),0)/rs.length:null;
      const l3avg=mean(l3,'strikeouts'),l5avg=mean(l5,'strikeouts'),l10avg=mean(l10,'strikeouts');
      const totalKs=sum(l5,'strikeouts'),totalBf=sum(l5,'batters_faced');
      const kbf=totalBf>0?totalKs/totalBf:null; const avgBf=mean(l5,'batters_faced');
      const baseline=kbf!==null&&avgBf!==null?kbf*avgBf:null;
      const same=starts.filter(x=>row.opponent_team_id!==null&&Number((x as any).opponent_team_id)===Number(row.opponent_team_id)).slice(0,5);
      let sameAdj=0; const sameK=mean(same,'strikeouts');
      if(baseline!==null&&same.length>=2&&sameK!==null){const reliability=same.length===2?.35:same.length===3?.5:same.length===4?.65:.75;sameAdj=clamp((sameK-baseline)*reliability,-.25,.25)}
      const projection=baseline===null?null:baseline+sameAdj; const edge=projection===null?null:projection-Number(row.strikeout_line);
      const sd=standardDeviation(l5.map(x=>Number(x.strikeouts)))??1.5; const overProb=edge===null?null:estimateOverRate(edge,sd);
      let preferred:string|null=edge===null?null:edge>=0?'More':'Less'; const available=String(row.available_side??'Both').toLowerCase();
      if(preferred==='More'&&available==='less')preferred=null; if(preferred==='Less'&&available==='more')preferred=null;
      const missing:string[]=[]; if(!row.scheduled_start)missing.push('game_start_cutoff_missing'); if(starts.length<3)missing.push('fewer_than_3_prior_starts'); if(!row.pitcher_hand)missing.push('pitcher_hand_missing'); if(baseline===null)missing.push('baseline_projection_unavailable'); if(row.actual_strikeouts===null)missing.push('graded_result_missing'); if(!row.opponent_team_id)missing.push('opponent_missing');
      let score=100; if(starts.length<10)score-=10;if(starts.length<5)score-=10;if(!row.pitcher_hand)score-=10;if(!row.scheduled_start)score-=20;if(!row.opponent_team_id)score-=10;if(same.length<2)score-=5;score=Math.max(0,Math.min(100,score));
      const hard=starts.length<3||baseline===null||row.actual_strikeouts===null||!row.scheduled_start;
      const status=hard?'INCOMPLETE':'RESEARCH_READY'; const eligible=status==='RESEARCH_READY'&&score>=65?1:0; if(eligible)ready++;else incomplete++;
      const features={source:'PREGAME_SAFE_PITCHER_HISTORY_ONLY',source_rule:'pitcher_game_stats.game_date < board_date',information_cutoff_at:row.scheduled_start,prior_start_count:starts.length,last_start_date:starts[0]?.game_date??null,last3_k_avg:l3avg,last5_k_avg:l5avg,last10_k_avg:l10avg,last5_k_per_bf:kbf,last5_avg_bf:avgBf,last5_avg_ip:mean(l5,'innings_pitched'),last5_avg_pitch_count:mean(l5,'pitch_count'),form_delta_l3_l10:l3avg!==null&&l10avg!==null?l3avg-l10avg:null,same_opponent_start_count:same.length,same_opponent_k_avg:sameK,same_opponent_adjustment:sameAdj,opponent_team_feature_status:'NOT_RECONSTRUCTED_IN_4_1_3'};
      await env.DB.prepare(`INSERT INTO independent_historical_reconstructions(independent_run_id,reconstruction_version,prop_id,board_id,board_date,game_id,information_cutoff_at,pitcher_id,opponent_team_id,pitcher_hand,prop_line,available_side,prop_type,prior_start_count,last_start_date,last3_k_avg,last5_k_avg,last10_k_avg,last5_k_per_bf,last5_avg_bf,last5_avg_ip,last5_avg_pitch_count,form_delta_l3_l10,same_opponent_start_count,same_opponent_k_avg,same_opponent_adjustment,baseline_projection,reconstructed_projection,reconstructed_edge,reconstructed_over_probability,reconstructed_preferred_side,reconstruction_status,reconstruction_score,expanded_research_eligible,missing_features_json,evidence_json,feature_json,actual_strikeouts,market_result,graded_at) VALUES (?,'independent-reconstruction-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(runId,row.prop_id,row.board_id,row.board_date,row.game_id,row.scheduled_start,row.pitcher_id,row.opponent_team_id,row.pitcher_hand,row.strikeout_line,row.available_side,row.prop_type,starts.length,starts[0]?.game_date??null,l3avg,l5avg,l10avg,kbf,avgBf,mean(l5,'innings_pitched'),mean(l5,'pitch_count'),l3avg!==null&&l10avg!==null?l3avg-l10avg:null,same.length,sameK,sameAdj,baseline,projection,edge,overProb,preferred,status,score,eligible,JSON.stringify(missing),JSON.stringify({legacy_snapshots_used:false,legacy_recommendations_used:false,postgame_data_used:false,cutoff_source:row.scheduled_start?'games.scheduled_start':null}),JSON.stringify(features),row.actual_strikeouts,row.market_result,row.graded_at).run();
      inserted++;
    }
    await env.DB.prepare(`UPDATE independent_historical_reconstruction_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,cursor_end_prop_id=?,candidates_seen=?,rows_inserted=?,research_ready_count=?,incomplete_count=?,details_json=? WHERE independent_run_id=?`).bind(endCursor,rows.results.length,inserted,ready,incomplete,JSON.stringify({reconstruction_version:'independent-reconstruction-v1',legacy_snapshots_used:false,legacy_recommendations_used:false,opponent_team_features:'DEFERRED',purpose:'research/backfill only'}),runId).run();
    return json({ok:true,independent_run_id:runId,candidates_seen:rows.results.length,rows_inserted:inserted,research_ready:ready,incomplete,cursor_end_prop_id:endCursor});
  }catch(error){await env.DB.prepare(`UPDATE independent_historical_reconstruction_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE independent_run_id=?`).bind(JSON.stringify({error:String(error)}),runId).run();throw error}
}

async function getIndependentHistoricalReconstructionStatus(env:Env):Promise<Response>{
  const latest=await env.DB.prepare(`SELECT * FROM independent_historical_reconstruction_runs ORDER BY independent_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM independent_historical_reconstruction_runs ORDER BY independent_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  const rows=await env.DB.prepare(`WITH x AS(SELECT i.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY independent_reconstruction_id DESC) rn FROM independent_historical_reconstructions i) SELECT x.*,pi.canonical_name pitcher_name,t.abbreviation opponent FROM x JOIN pitchers pi ON pi.pitcher_id=x.pitcher_id LEFT JOIN teams t ON t.team_id=x.opponent_team_id WHERE rn=1 ORDER BY independent_reconstruction_id DESC LIMIT 50`).all<Record<string,unknown>>();
  const summary=await env.DB.prepare(`WITH x AS(SELECT i.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY independent_reconstruction_id DESC) rn FROM independent_historical_reconstructions i) SELECT COUNT(*) total,SUM(CASE WHEN reconstruction_status='RESEARCH_READY' THEN 1 ELSE 0 END) research_ready,SUM(CASE WHEN reconstruction_status='INCOMPLETE' THEN 1 ELSE 0 END) incomplete,MIN(board_date) board_date_min,MAX(board_date) board_date_max FROM x WHERE rn=1`).first<Record<string,unknown>>();
  return json({latest_run:latest,runs:runs.results,rows:rows.results,summary});
}



type HistoricalOpponentCandidate = {
  independent_reconstruction_id:number; prop_id:number; board_id:number; board_date:string;
  information_cutoff_at:string|null; opponent_team_id:number; pitcher_hand:string|null;
  reconstructed_projection:number|null; actual_strikeouts:number|null; market_result:string|null;
  opponent_abbreviation:string|null;
};

function weightedHistoricalOpponentRate(rows:{r7:number|null;p7:number;r14:number|null;p14:number;r30:number|null;p30:number}):number|null{
  const components:Array<{value:number;weight:number}>=[];
  const r7=shrinkRate(rows.r7,rows.p7,LEAGUE_BASELINE_K_RATE,90);
  const r14=shrinkRate(rows.r14,rows.p14,LEAGUE_BASELINE_K_RATE,140);
  const r30=shrinkRate(rows.r30,rows.p30,LEAGUE_BASELINE_K_RATE,220);
  if(r7!==null)components.push({value:r7,weight:.50});
  if(r14!==null)components.push({value:r14,weight:.30});
  if(r30!==null)components.push({value:r30,weight:.20});
  if(!components.length)return null;
  const w=components.reduce((n,x)=>n+x.weight,0);
  return components.reduce((n,x)=>n+x.value*x.weight,0)/w;
}

async function runHistoricalOpponentReconstruction(env:Env):Promise<Response>{
  const latest=await env.DB.prepare(`SELECT COALESCE(MAX(cursor_end_prop_id),0) cursor FROM historical_opponent_reconstruction_runs WHERE status IN ('SUCCEEDED','PARTIAL')`).first<{cursor:number}>();
  const cursor=Number(latest?.cursor??0);
  const created=await env.DB.prepare(`INSERT INTO historical_opponent_reconstruction_runs(run_uuid,reconstruction_version,status,trigger_source,cursor_start_prop_id,started_at) VALUES (?,'historical-opponent-reconstruction-v1','RUNNING','ADMIN',?,CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(),cursor).run();
  const runId=Number(created.meta.last_row_id);
  try{
    const candidate=await env.DB.prepare(`
      WITH latest_independent AS (
        SELECT i.*,ROW_NUMBER() OVER(PARTITION BY i.prop_id ORDER BY i.independent_reconstruction_id DESC) rn
        FROM independent_historical_reconstructions i
      )
      SELECT i.independent_reconstruction_id,i.prop_id,i.board_id,i.board_date,i.information_cutoff_at,
             i.opponent_team_id,i.pitcher_hand,i.reconstructed_projection,i.actual_strikeouts,i.market_result,
             t.abbreviation opponent_abbreviation
      FROM latest_independent i
      JOIN teams t ON t.team_id=i.opponent_team_id
      WHERE i.rn=1 AND i.reconstruction_status='RESEARCH_READY' AND i.prop_id>?
      ORDER BY i.prop_id LIMIT 1
    `).bind(cursor).first<HistoricalOpponentCandidate>();
    if(!candidate){
      await env.DB.prepare(`UPDATE historical_opponent_reconstruction_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,cursor_end_prop_id=?,details_json=? WHERE opponent_reconstruction_run_id=?`).bind(cursor,JSON.stringify({message:'No remaining RESEARCH_READY independent rows.',reconstruction_version:'historical-opponent-reconstruction-v1'}),runId).run();
      return json({ok:true,opponent_reconstruction_run_id:runId,candidates_seen:0,rows_inserted:0,research_ready:0,incomplete:0,cursor_end_prop_id:cursor,done:true});
    }
    const endDate=isoDateDaysBefore(candidate.board_date,1);
    const start30=isoDateDaysBefore(candidate.board_date,30);
    const start14=isoDateDaysBefore(candidate.board_date,14);
    const start7=isoDateDaysBefore(candidate.board_date,7);
    const hand=String(candidate.pitcher_hand??'').toUpperCase();
    const abbr=normalizedMlbTeamAbbreviation(String(candidate.opponent_abbreviation??''));
    const mlbTeamId=MLB_TEAM_IDS[abbr]??0;
    const missing:string[]=[];
    let gamesChecked=0,gamesFetched=0;
    let pa7=0,k7=0,r7:number|null=null,pa14=0,k14=0,r14:number|null=null,pa30=0,k30=0,r30:number|null=null;
    let weighted:number|null=null,trend:number|null=null,multiplier:number|null=null,adjusted:number|null=null,edge:number|null=null,overProb:number|null=null,preferred:string|null=null;
    let confidence='NONE';
    let syncRunId:number|null=null;
    if(!candidate.information_cutoff_at)missing.push('game_start_cutoff_missing');
    if(!mlbTeamId)missing.push('opponent_mlb_team_mapping_missing');
    if(hand!=='L'&&hand!=='R')missing.push('pitcher_hand_missing');
    if(candidate.reconstructed_projection===null)missing.push('pitcher_projection_missing');
    if(mlbTeamId&&(hand==='L'||hand==='R')){
      const sr=await env.DB.prepare(`INSERT INTO sync_runs(run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end,details_json) VALUES (?,'MLB_STATS_API','HISTORICAL_OPPONENT_RECONSTRUCTION','BACKFILL','ADMIN','RUNNING',?,?,?)`).bind(crypto.randomUUID(),String(candidate.prop_id),String(candidate.prop_id),JSON.stringify({prop_id:candidate.prop_id,board_date:candidate.board_date,team:abbr,pitcher_hand:hand})).run();
      syncRunId=Number(sr.meta.last_row_id);
      const games=await fetchTeamRecentScheduleGames(mlbTeamId,start30,endDate);
      gamesChecked=games.length;
      for(const game of games){
        const cached=await env.DB.prepare(`SELECT mlb_game_pk FROM team_game_handedness_games WHERE mlb_game_pk=?`).bind(game.gamePk).first<{mlb_game_pk:number}>();
        if(!cached){await cacheGameHandednessBatting(env,game,syncRunId);gamesFetched++;}
      }
      const w7=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start7,endDate);
      const w14=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start14,endDate);
      const w30=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start30,endDate);
      pa7=w7.plateAppearances;k7=w7.strikeouts;r7=pa7>0?w7.strikeoutRate:null;
      pa14=w14.plateAppearances;k14=w14.strikeouts;r14=pa14>0?w14.strikeoutRate:null;
      pa30=w30.plateAppearances;k30=w30.strikeouts;r30=pa30>0?w30.strikeoutRate:null;
      weighted=weightedHistoricalOpponentRate({r7,p7:pa7,r14,p14:pa14,r30,p30:pa30});
      trend=r7!==null&&r30!==null?r7-r30:null;
      confidence=pa30>=180&&pa14>=80?'HIGH':pa30>=100&&pa14>=45?'MEDIUM':pa30>=50?'LOW':'INSUFFICIENT';
      if(pa30<50)missing.push('opponent_30d_sample_too_small');
      if(pa14<25)missing.push('opponent_14d_sample_too_small');
      if(weighted===null)missing.push('opponent_weighted_k_rate_missing');
      if(weighted!==null&&candidate.reconstructed_projection!==null){
        multiplier=clamp(1+(weighted-LEAGUE_BASELINE_K_RATE)*2.0,.88,1.12);
        adjusted=candidate.reconstructed_projection*multiplier;
        const prop=await env.DB.prepare(`SELECT strikeout_line,available_side FROM props WHERE prop_id=?`).bind(candidate.prop_id).first<{strikeout_line:number;available_side:string|null}>();
        if(prop){edge=adjusted-Number(prop.strikeout_line);overProb=estimateOverRate(edge,1.5);preferred=edge>=0?'More':'Less';const av=String(prop.available_side??'Both').toLowerCase();if(preferred==='More'&&av==='less')preferred=null;if(preferred==='Less'&&av==='more')preferred=null;}
      }
      await env.DB.prepare(`UPDATE sync_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,request_count=?,details_json=? WHERE sync_run_id=?`).bind(gamesChecked,gamesFetched,1+gamesFetched,JSON.stringify({prop_id:candidate.prop_id,team:abbr,pitcher_hand:hand,start_date:start30,end_date:endDate,games_checked:gamesChecked,games_fetched:gamesFetched}),syncRunId).run();
    }
    let score=100;
    if(confidence==='MEDIUM')score-=10; else if(confidence==='LOW')score-=20; else if(confidence==='INSUFFICIENT'||confidence==='NONE')score-=35;
    if(pa7<20)score-=10;if(!candidate.information_cutoff_at)score-=20;if(!mlbTeamId)score-=20;if(hand!=='L'&&hand!=='R')score-=20;
    score=Math.max(0,Math.min(100,score));
    const hard=!candidate.information_cutoff_at||!mlbTeamId||(hand!=='L'&&hand!=='R')||weighted===null||pa30<50||candidate.reconstructed_projection===null;
    const status=hard?'INCOMPLETE':'RESEARCH_READY';const eligible=status==='RESEARCH_READY'&&score>=65?1:0;
    const evidence={native_snapshots_used:false,legacy_snapshots_used:false,legacy_recommendations_used:false,source:'MLB_PLAY_BY_PLAY',cache_table:'team_game_handedness_batting',window_rule:'official_date < board_date',schedule_range:{start:start30,end:endDate},games_checked:gamesChecked,games_fetched:gamesFetched,season_handedness_reconstructed:false};
    const feature={opponent_team:abbr,opponent_mlb_team_id:mlbTeamId,pitcher_hand:hand,window_7:{pa:pa7,k:k7,k_rate:r7},window_14:{pa:pa14,k:k14,k_rate:r14},window_30:{pa:pa30,k:k30,k_rate:r30},weighted_recent_k_rate:weighted,recent_trend_delta:trend,sample_confidence:confidence,league_baseline_k_rate:LEAGUE_BASELINE_K_RATE,handedness_edge:weighted===null?null:weighted-LEAGUE_BASELINE_K_RATE,matchup_multiplier:multiplier,pitcher_only_projection:candidate.reconstructed_projection,opponent_adjusted_projection:adjusted};
    await env.DB.prepare(`INSERT INTO historical_opponent_reconstructions(opponent_reconstruction_run_id,reconstruction_version,independent_reconstruction_id,prop_id,board_id,board_date,information_cutoff_at,opponent_team_id,opponent_mlb_team_id,pitcher_hand,window_7_pa,window_7_k,window_7_k_rate,window_14_pa,window_14_k,window_14_k_rate,window_30_pa,window_30_k,window_30_k_rate,weighted_recent_k_rate,recent_trend_delta,league_baseline_k_rate,handedness_edge,sample_confidence,matchup_multiplier,pitcher_only_projection,opponent_adjusted_projection,opponent_adjusted_edge,opponent_adjusted_over_probability,opponent_adjusted_preferred_side,reconstruction_status,reconstruction_score,expanded_research_eligible,missing_features_json,evidence_json,feature_json,actual_strikeouts,market_result) VALUES (?,'historical-opponent-reconstruction-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(runId,candidate.independent_reconstruction_id,candidate.prop_id,candidate.board_id,candidate.board_date,candidate.information_cutoff_at,candidate.opponent_team_id,mlbTeamId,hand,pa7,k7,r7,pa14,k14,r14,pa30,k30,r30,weighted,trend,LEAGUE_BASELINE_K_RATE,weighted===null?null:weighted-LEAGUE_BASELINE_K_RATE,confidence,multiplier,candidate.reconstructed_projection,adjusted,edge,overProb,preferred,status,score,eligible,JSON.stringify(missing),JSON.stringify(evidence),JSON.stringify(feature),candidate.actual_strikeouts,candidate.market_result).run();
    await env.DB.prepare(`UPDATE historical_opponent_reconstruction_runs SET status=?,completed_at=CURRENT_TIMESTAMP,cursor_end_prop_id=?,candidates_seen=1,rows_inserted=1,research_ready_count=?,incomplete_count=?,games_checked=?,games_fetched=?,details_json=? WHERE opponent_reconstruction_run_id=?`).bind(status==='RESEARCH_READY'?'SUCCEEDED':'PARTIAL',candidate.prop_id,status==='RESEARCH_READY'?1:0,status==='INCOMPLETE'?1:0,gamesChecked,gamesFetched,JSON.stringify({reconstruction_version:'historical-opponent-reconstruction-v1',prop_id:candidate.prop_id,opponent:abbr,pitcher_hand:hand,season_handedness_reconstructed:false,recent_windows:'7/14/30 pregame only',native_snapshots_modified:false}),runId).run();
    return json({ok:true,opponent_reconstruction_run_id:runId,candidates_seen:1,rows_inserted:1,research_ready:status==='RESEARCH_READY'?1:0,incomplete:status==='INCOMPLETE'?1:0,cursor_end_prop_id:candidate.prop_id,games_checked:gamesChecked,games_fetched:gamesFetched,status});
  }catch(error){await env.DB.prepare(`UPDATE historical_opponent_reconstruction_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE opponent_reconstruction_run_id=?`).bind(JSON.stringify({error:String(error)}),runId).run();throw error}
}

async function getHistoricalOpponentReconstructionStatus(env:Env):Promise<Response>{
  const latest=await env.DB.prepare(`SELECT * FROM historical_opponent_reconstruction_runs ORDER BY opponent_reconstruction_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM historical_opponent_reconstruction_runs ORDER BY opponent_reconstruction_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const rows=await env.DB.prepare(`WITH x AS(SELECT h.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_opponent_reconstruction_id DESC) rn FROM historical_opponent_reconstructions h) SELECT x.*,pi.canonical_name pitcher_name,t.abbreviation opponent FROM x JOIN props p ON p.prop_id=x.prop_id JOIN pitchers pi ON pi.pitcher_id=p.pitcher_id JOIN teams t ON t.team_id=x.opponent_team_id WHERE rn=1 ORDER BY historical_opponent_reconstruction_id DESC LIMIT 75`).all<Record<string,unknown>>();
  const summary=await env.DB.prepare(`WITH x AS(SELECT h.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_opponent_reconstruction_id DESC) rn FROM historical_opponent_reconstructions h) SELECT COUNT(*) total,SUM(CASE WHEN reconstruction_status='RESEARCH_READY' THEN 1 ELSE 0 END) research_ready,SUM(CASE WHEN reconstruction_status='INCOMPLETE' THEN 1 ELSE 0 END) incomplete,ROUND(AVG(reconstruction_score),1) avg_score,MIN(board_date) board_date_min,MAX(board_date) board_date_max FROM x WHERE rn=1`).first<Record<string,unknown>>();
  return json({latest_run:latest,runs:runs.results,rows:rows.results,summary});
}

async function runBackfillCertification(env:Env):Promise<Response>{
  const created=await env.DB.prepare(`
    INSERT INTO historical_feature_certification_runs(run_uuid,certification_version,status,trigger_source,started_at)
    VALUES (?,'independent-certification-v1','RUNNING','ADMIN',CURRENT_TIMESTAMP)
  `).bind(crypto.randomUUID()).run();
  const runId=Number(created.meta.last_row_id);
  try{
    const productionModel=await env.DB.prepare(`
      SELECT model_version_id,version_name FROM model_versions
      WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE'
      ORDER BY model_version_id DESC LIMIT 1
    `).first<{model_version_id:number;version_name:string}>();
    if(!productionModel)throw new Error('No active PRODUCTION model version found.');

    const rows=await env.DB.prepare(`
      WITH latest_i AS (
        SELECT i.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY independent_reconstruction_id DESC) rn
        FROM independent_historical_reconstructions i
      ),
      latest_o AS (
        SELECT o.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_opponent_reconstruction_id DESC) rn
        FROM historical_opponent_reconstructions o
      ),
      latest_h AS (
        SELECT h.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_reconstruction_id DESC) rn
        FROM historical_feature_reconstructions h
      )
      SELECT
        i.*,h.historical_reconstruction_id,
        o.historical_opponent_reconstruction_id,o.reconstruction_status AS opponent_status,
        o.reconstruction_score AS opponent_score,o.sample_confidence,
        o.window_7_pa,o.window_7_k,o.window_7_k_rate,
        o.window_14_pa,o.window_14_k,o.window_14_k_rate,
        o.window_30_pa,o.window_30_k,o.window_30_k_rate,
        o.weighted_recent_k_rate,o.recent_trend_delta,o.league_baseline_k_rate,
        o.handedness_edge,o.matchup_multiplier,o.opponent_adjusted_projection,
        o.opponent_adjusted_edge,o.opponent_adjusted_over_probability,
        o.opponent_adjusted_preferred_side,o.feature_json AS opponent_feature_json
      FROM latest_i i
      LEFT JOIN latest_o o ON o.prop_id=i.prop_id AND o.rn=1
      LEFT JOIN latest_h h ON h.prop_id=i.prop_id AND h.rn=1
      WHERE i.rn=1
      ORDER BY i.board_date,i.prop_id
    `).all<Record<string,unknown>>();

    let a=0,b=0,incomplete=0;
    const stmts:D1PreparedStatement[]=[];
    for(const row of rows.results??[]){
      const reasons:string[]=[];
      const independentStatus=String(row.reconstruction_status??'');
      const opponentStatus=String(row.opponent_status??'');
      const starts=Number(row.prior_start_count??0);
      const pitcherScore=Number(row.reconstruction_score??0);
      const opponentScore=Number(row.opponent_score??0);
      const oppConfidence=String(row.sample_confidence??'NONE').toUpperCase();
      const cutoff=String(row.information_cutoff_at??'');
      const legacyAnchor=row.historical_reconstruction_id==null?null:Number(row.historical_reconstruction_id);
      const marketResult=String(row.market_result??'').toUpperCase();

      if(independentStatus!=='RESEARCH_READY')reasons.push('pitcher_reconstruction_incomplete');
      if(opponentStatus!=='RESEARCH_READY')reasons.push('opponent_reconstruction_incomplete');
      if(starts<3)reasons.push('fewer_than_3_prior_starts');
      if(!cutoff)reasons.push('game_start_cutoff_missing');
      if(!legacyAnchor)reasons.push('legacy_fk_anchor_missing');
      if(!['OVER','UNDER','PUSH','VOID','DNP'].includes(marketResult))reasons.push('graded_result_missing');

      let klass:'RECONSTRUCTED_A'|'RECONSTRUCTED_B'|'INCOMPLETE'='INCOMPLETE';
      const coreReady=independentStatus==='RESEARCH_READY'&&opponentStatus==='RESEARCH_READY'&&starts>=3&&Boolean(cutoff)&&Boolean(legacyAnchor);
      if(coreReady&&starts>=5&&pitcherScore>=85&&opponentScore>=90&&oppConfidence==='HIGH'){
        klass='RECONSTRUCTED_A';
      }else if(coreReady&&pitcherScore>=75&&opponentScore>=65&&['HIGH','MEDIUM','LOW'].includes(oppConfidence)){
        klass='RECONSTRUCTED_B';
      }

      const combinedScore=Math.max(0,Math.min(100,Math.round(pitcherScore*.45+opponentScore*.55)));
      const certificationScore=klass==='RECONSTRUCTED_A'?Math.max(90,combinedScore):klass==='RECONSTRUCTED_B'?Math.min(89,Math.max(70,combinedScore)):Math.min(69,combinedScore);
      const status=klass==='INCOMPLETE'?'EXCLUDED':'CERTIFIED';
      const certifiedEligible=klass==='RECONSTRUCTED_A'?1:0;
      const expandedEligible=klass==='RECONSTRUCTED_A'||klass==='RECONSTRUCTED_B'?1:0;
      if(klass==='RECONSTRUCTED_A')a++;else if(klass==='RECONSTRUCTED_B')b++;else incomplete++;

      if(klass==='RECONSTRUCTED_B'){
        if(oppConfidence!=='HIGH')reasons.push(`opponent_confidence_${oppConfidence.toLowerCase()}`);
        if(starts<5)reasons.push('fewer_than_5_prior_starts');
        if(pitcherScore<85)reasons.push('pitcher_reconstruction_score_below_a');
        if(opponentScore<90)reasons.push('opponent_reconstruction_score_below_a');
      }

      const overRaw=Number(row.opponent_adjusted_over_probability);
      const overProb=Number.isFinite(overRaw)?Math.max(0,Math.min(1,overRaw>1?overRaw/100:overRaw)):null;
      const sideRaw=String(row.opponent_adjusted_preferred_side??'').toUpperCase();
      const preferredSide=sideRaw==='MORE'||sideRaw==='LESS'?sideRaw:null;
      const opponentJson=JSON.stringify({
        source:'INDEPENDENT_PREGAME_OPPONENT_RECONSTRUCTION',
        historical_opponent_reconstruction_id:row.historical_opponent_reconstruction_id,
        information_cutoff_at:cutoff,
        pitcher_hand:row.pitcher_hand,
        window_7:{pa:row.window_7_pa,k:row.window_7_k,k_rate:row.window_7_k_rate},
        window_14:{pa:row.window_14_pa,k:row.window_14_k,k_rate:row.window_14_k_rate},
        window_30:{pa:row.window_30_pa,k:row.window_30_k,k_rate:row.window_30_k_rate},
        weighted_recent_k_rate:row.weighted_recent_k_rate,recent_trend_delta:row.recent_trend_delta,
        league_baseline_k_rate:row.league_baseline_k_rate,handedness_edge:row.handedness_edge,
        sample_confidence:row.sample_confidence,matchup_multiplier:row.matchup_multiplier
      });
      const modelJson=JSON.stringify({
        source:'INDEPENDENT_RECONSTRUCTED_V13_STYLE_OUTPUT',
        production_model_version_id:productionModel.model_version_id,
        production_model_version_name:productionModel.version_name,
        recommendation_generated_at:cutoff,information_cutoff_at:cutoff,
        projected_strikeouts:row.opponent_adjusted_projection,
        model_edge:row.opponent_adjusted_edge,
        estimated_over_rate:overProb,
        preferred_side:preferredSide,
        model_decision:'RESEARCH_RECONSTRUCTION',
        final_decision:'RESEARCH_RECONSTRUCTION',
        confidence_score:certificationScore,
        confidence_band:klass==='RECONSTRUCTED_A'?'A':klass==='RECONSTRUCTED_B'?'B':'INCOMPLETE'
      });
      const evidenceJson=JSON.stringify({
        policy:'Independent pitcher + opponent reconstruction using pregame-only evidence.',
        independent_reconstruction_id:row.independent_reconstruction_id,
        historical_opponent_reconstruction_id:row.historical_opponent_reconstruction_id,
        pitcher_reconstruction_score:pitcherScore,
        opponent_reconstruction_score:opponentScore,
        opponent_sample_confidence:oppConfidence,
        production_model_reference:productionModel.version_name,
        legacy_snapshots_used:false,legacy_recommendations_used:false,native_snapshots_modified:false
      });

      if(!legacyAnchor)continue;
      stmts.push(env.DB.prepare(`
        INSERT INTO historical_feature_certifications(
          certification_run_id,certification_version,historical_reconstruction_id,prop_id,board_date,certification_class,
          certification_status,strict_eligible,certified_eligible,expanded_eligible,certification_score,reasons_json,evidence_json,certified_at,
          information_cutoff_at,cutoff_source,certified_feature_snapshot_id,certified_recommendation_id,certified_model_version_id,
          certified_opponent_features_json,certified_model_output_json,source_timing_status
        ) VALUES (?,'independent-certification-v1',?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,'SCHEDULED_GAME_START',NULL,NULL,?,?,?,'PREGAME_RECONSTRUCTED')
      `).bind(runId,legacyAnchor,row.prop_id,row.board_date,klass,status,0,certifiedEligible,expandedEligible,certificationScore,
        JSON.stringify(reasons),evidenceJson,cutoff||null,productionModel.model_version_id,opponentJson,modelJson));
    }

    for(let i=0;i<stmts.length;i+=40)await env.DB.batch(stmts.slice(i,i+40));
    await env.DB.prepare(`
      UPDATE historical_feature_certification_runs
      SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,candidates_seen=?,reconstructed_a_count=?,
          reconstructed_b_count=?,incomplete_count=?,details_json=?
      WHERE certification_run_id=?
    `).bind(rows.results?.length??0,a,b,incomplete,JSON.stringify({
      certification_version:'independent-certification-v1',
      policy:'pregame independent pitcher + opponent reconstruction',
      dataset_modes:{STRICT:'NATIVE only',CERTIFIED:'NATIVE + RECONSTRUCTED_A',EXPANDED:'NATIVE + RECONSTRUCTED_A + RECONSTRUCTED_B'},
      production_model_reference:productionModel.version_name,
      legacy_snapshots_used:false,legacy_recommendations_used:false,native_snapshots_modified:false
    }),runId).run();
    return json({ok:true,certification_run_id:runId,candidates_seen:rows.results?.length??0,reconstructed_a:a,reconstructed_b:b,incomplete,certification_version:'independent-certification-v1'});
  }catch(error){
    await env.DB.prepare(`UPDATE historical_feature_certification_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE certification_run_id=?`)
      .bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),runId).run();
    throw error;
  }
}


async function runArchiveBackfillCertification(env:Env):Promise<Response>{
  const created=await env.DB.prepare(`
    INSERT INTO archive_historical_certification_runs(run_uuid,certification_version,status,trigger_source,started_at)
    VALUES (?,'archive-certification-v1','RUNNING','ADMIN',CURRENT_TIMESTAMP)
  `).bind(crypto.randomUUID()).run();
  const runId=Number(created.meta.last_row_id);
  try{
    const productionModel=await env.DB.prepare(`
      SELECT model_version_id,version_name FROM model_versions
      WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE'
      ORDER BY model_version_id DESC LIMIT 1
    `).first<{model_version_id:number;version_name:string}>();
    if(!productionModel)throw new Error('No active PRODUCTION model version found.');

    const rows=await env.DB.prepare(`
      WITH latest AS (
        SELECT r.*,ROW_NUMBER() OVER(PARTITION BY historical_archive_prop_id ORDER BY archive_historical_reconstruction_id DESC) rn
        FROM archive_historical_reconstructions r
      )
      SELECT r.*,a.pitcher_name,a.team_abbreviation,a.opponent_abbreviation,a.source_workbook,a.source_quality
      FROM latest r JOIN historical_archive_props a ON a.historical_archive_prop_id=r.historical_archive_prop_id
      WHERE r.rn=1 ORDER BY r.board_date,r.historical_archive_prop_id
    `).all<Record<string,unknown>>();

    let aCount=0,bCount=0,incomplete=0;
    const stmts:D1PreparedStatement[]=[];
    for(const row of rows.results??[]){
      const reasons:string[]=[];
      const reconstructionStatus=String(row.reconstruction_status??'');
      const starts=Number(row.prior_start_count??0);
      const score=Number(row.reconstruction_score??0);
      const confidence=String(row.sample_confidence??'NONE').toUpperCase();
      const cutoff=String(row.information_cutoff_at??'');
      const marketResult=String(row.market_result??'').toUpperCase();
      const pitcherId=row.pitcher_id==null?null:Number(row.pitcher_id);
      const opponentTeamId=row.opponent_team_id==null?null:Number(row.opponent_team_id);

      if(reconstructionStatus!=='RESEARCH_READY')reasons.push('archive_reconstruction_incomplete');
      if(starts<3)reasons.push('fewer_than_3_prior_starts');
      if(!cutoff)reasons.push('information_cutoff_missing');
      if(!pitcherId)reasons.push('pitcher_mapping_missing');
      if(!opponentTeamId)reasons.push('opponent_team_mapping_missing');
      if(!['OVER','UNDER','PUSH'].includes(marketResult))reasons.push('graded_result_missing');

      const coreReady=reconstructionStatus==='RESEARCH_READY'&&starts>=3&&Boolean(cutoff)&&Boolean(pitcherId)&&Boolean(opponentTeamId)&&['OVER','UNDER','PUSH'].includes(marketResult);
      let klass:'ARCHIVE_RECONSTRUCTED_A'|'ARCHIVE_RECONSTRUCTED_B'|'INCOMPLETE'='INCOMPLETE';
      if(coreReady&&starts>=5&&score>=90&&confidence==='HIGH')klass='ARCHIVE_RECONSTRUCTED_A';
      else if(coreReady&&score>=70&&['HIGH','MEDIUM','LOW'].includes(confidence))klass='ARCHIVE_RECONSTRUCTED_B';

      const certificationScore=klass==='ARCHIVE_RECONSTRUCTED_A'?Math.max(90,score):klass==='ARCHIVE_RECONSTRUCTED_B'?Math.min(89,Math.max(70,score)):Math.min(69,score);
      const status=klass==='INCOMPLETE'?'EXCLUDED':'CERTIFIED';
      const certifiedEligible=klass==='ARCHIVE_RECONSTRUCTED_A'?1:0;
      const expandedEligible=klass!=='INCOMPLETE'?1:0;
      if(klass==='ARCHIVE_RECONSTRUCTED_A')aCount++;else if(klass==='ARCHIVE_RECONSTRUCTED_B')bCount++;else incomplete++;

      if(klass==='ARCHIVE_RECONSTRUCTED_B'){
        if(confidence!=='HIGH')reasons.push(`opponent_confidence_${confidence.toLowerCase()}`);
        if(starts<5)reasons.push('fewer_than_5_prior_starts');
        if(score<90)reasons.push('archive_reconstruction_score_below_a');
      }

      const evidenceJson=JSON.stringify({
        policy:'Archive reconstruction certification from pregame-only pitcher history and opponent handedness evidence.',
        archive_historical_reconstruction_id:row.archive_historical_reconstruction_id,
        historical_archive_prop_id:row.historical_archive_prop_id,
        reconstruction_score:score,sample_confidence:confidence,prior_start_count:starts,
        source_workbook:row.source_workbook,source_quality:row.source_quality,
        production_model_reference:productionModel.version_name,
        native_snapshots_used:false,legacy_snapshots_used:false,legacy_recommendations_used:false,native_snapshots_modified:false
      });
      const modelJson=JSON.stringify({
        source:'ARCHIVE_RECONSTRUCTED_V13_STYLE_OUTPUT',production_model_version_id:productionModel.model_version_id,
        production_model_version_name:productionModel.version_name,recommendation_generated_at:cutoff,information_cutoff_at:cutoff,
        projected_strikeouts:row.reconstructed_projection,model_edge:row.reconstructed_edge,
        estimated_over_rate:row.reconstructed_over_probability,preferred_side:row.reconstructed_preferred_side,
        model_decision:'RESEARCH_RECONSTRUCTION',final_decision:'RESEARCH_RECONSTRUCTION',
        confidence_score:certificationScore,confidence_band:klass==='ARCHIVE_RECONSTRUCTED_A'?'A':klass==='ARCHIVE_RECONSTRUCTED_B'?'B':'INCOMPLETE'
      });

      stmts.push(env.DB.prepare(`INSERT INTO archive_historical_certifications(
        archive_certification_run_id,certification_version,archive_historical_reconstruction_id,historical_archive_prop_id,board_date,
        certification_class,certification_status,certified_eligible,expanded_eligible,certification_score,reasons_json,evidence_json,
        information_cutoff_at,certified_model_version_id,certified_model_output_json,source_timing_status,certified_at
      ) VALUES (?,'archive-certification-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,'PREGAME_RECONSTRUCTED',CURRENT_TIMESTAMP)`)
        .bind(runId,row.archive_historical_reconstruction_id,row.historical_archive_prop_id,row.board_date,klass,status,certifiedEligible,expandedEligible,certificationScore,
          JSON.stringify(reasons),evidenceJson,cutoff||null,productionModel.model_version_id,modelJson));
    }
    for(let i=0;i<stmts.length;i+=40)await env.DB.batch(stmts.slice(i,i+40));
    await env.DB.prepare(`UPDATE archive_historical_certification_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,candidates_seen=?,archive_a_count=?,archive_b_count=?,incomplete_count=?,details_json=? WHERE archive_certification_run_id=?`)
      .bind(rows.results?.length??0,aCount,bCount,incomplete,JSON.stringify({certification_version:'archive-certification-v1',dataset_modes:{STRICT:'NATIVE only',CERTIFIED:'NATIVE + RECONSTRUCTED_A + ARCHIVE_RECONSTRUCTED_A',EXPANDED:'NATIVE + A/B from both reconstructed sources'},production_model_reference:productionModel.version_name,native_snapshots_modified:false}),runId).run();
    return json({ok:true,archive_certification_run_id:runId,candidates_seen:rows.results?.length??0,archive_a:aCount,archive_b:bCount,incomplete,certification_version:'archive-certification-v1'});
  }catch(error){
    await env.DB.prepare(`UPDATE archive_historical_certification_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE archive_certification_run_id=?`).bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),runId).run();
    throw error;
  }
}

async function getArchiveBackfillCertificationStatus(env:Env):Promise<Record<string,unknown>>{
  const latestRun=await env.DB.prepare(`SELECT * FROM archive_historical_certification_runs ORDER BY archive_certification_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM archive_historical_certification_runs ORDER BY archive_certification_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  const rows=latestRun?await env.DB.prepare(`
    SELECT c.*,a.pitcher_name,a.opponent_abbreviation AS opponent,r.prior_start_count AS pitcher_starts_before_board,
           r.reconstruction_score AS pitcher_reconstruction_score,r.sample_confidence AS opponent_confidence
    FROM archive_historical_certifications c
    JOIN archive_historical_reconstructions r ON r.archive_historical_reconstruction_id=c.archive_historical_reconstruction_id
    JOIN historical_archive_props a ON a.historical_archive_prop_id=c.historical_archive_prop_id
    WHERE c.archive_certification_run_id=? ORDER BY c.board_date DESC,c.historical_archive_prop_id DESC LIMIT 150
  `).bind(Number(latestRun.archive_certification_run_id)).all<Record<string,unknown>>():{results:[] as Record<string,unknown>[]};
  const summary=latestRun?await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN certification_class='ARCHIVE_RECONSTRUCTED_A' THEN 1 ELSE 0 END) a,SUM(CASE WHEN certification_class='ARCHIVE_RECONSTRUCTED_B' THEN 1 ELSE 0 END) b,SUM(CASE WHEN certification_class='INCOMPLETE' THEN 1 ELSE 0 END) incomplete FROM archive_historical_certifications WHERE archive_certification_run_id=?`).bind(Number(latestRun.archive_certification_run_id)).first<Record<string,unknown>>():{};
  return {latest_run:latestRun,runs:runs.results,rows:rows.results,summary};
}

async function getBackfillCertificationStatus(env:Env):Promise<Response>{
  const latestRun=await env.DB.prepare(`SELECT * FROM historical_feature_certification_runs ORDER BY certification_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM historical_feature_certification_runs ORDER BY certification_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  const rows=latestRun?await env.DB.prepare(`
    WITH latest_i AS (
      SELECT i.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY independent_reconstruction_id DESC) rn
      FROM independent_historical_reconstructions i
    )
    SELECT c.*,pi.canonical_name pitcher_name,t.abbreviation opponent,i.prior_start_count AS pitcher_starts_before_board,
           i.reconstruction_score AS pitcher_reconstruction_score,
           json_extract(c.certified_opponent_features_json,'$.sample_confidence') AS opponent_confidence
    FROM historical_feature_certifications c
    LEFT JOIN latest_i i ON i.prop_id=c.prop_id AND i.rn=1
    LEFT JOIN props p ON p.prop_id=c.prop_id
    LEFT JOIN pitchers pi ON pi.pitcher_id=COALESCE(i.pitcher_id,p.pitcher_id)
    LEFT JOIN teams t ON t.team_id=COALESCE(i.opponent_team_id,p.opponent_team_id)
    WHERE c.certification_run_id=? ORDER BY c.board_date DESC,c.prop_id DESC LIMIT 150
  `).bind(Number(latestRun.certification_run_id)).all<Record<string,unknown>>():{results:[] as Record<string,unknown>[]};
  const summary=latestRun?await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN certification_class='RECONSTRUCTED_A' THEN 1 ELSE 0 END) a,SUM(CASE WHEN certification_class='RECONSTRUCTED_B' THEN 1 ELSE 0 END) b,SUM(CASE WHEN certification_class='INCOMPLETE' THEN 1 ELSE 0 END) incomplete FROM historical_feature_certifications WHERE certification_run_id=?`).bind(Number(latestRun.certification_run_id)).first<Record<string,unknown>>():{};
  const archive=await getArchiveBackfillCertificationStatus(env);
  return json({latest_run:latestRun,runs:runs.results,rows:rows.results,summary,archive_latest_run:archive.latest_run,archive_runs:archive.runs,archive_rows:archive.rows,archive_summary:archive.summary});
}

type ReconstructedDatasetCandidate={
  historical_reconstruction_id:number; historical_certification_id:number; independent_reconstruction_id?:number; certification_class:string; certification_score:number;
  prop_id:number;board_id:number;board_date:string;model_version_id:number;pitcher_id:number;opponent_team_id:number|null;pitcher_hand:string|null;prop_line:number;
  recommendation_generated_at:string|null;legacy_snapshot_time:string|null;latest_pitcher_game_date:string|null;pitcher_features_json:string|null;opponent_features_json:string|null;model_output_json:string|null;
  actual_strikeouts:number|null;market_result:string|null;graded_at:string|null;certified_information_cutoff_at:string|null;certification_version:string|null;
};

async function buildHistoricalDataset(request:Request,env: Env, triggerSource = 'ADMIN'): Promise<Response> {
  let input:{mode?:string}={}; try{input=await request.json() as typeof input;}catch{input={};}
  const requested=String(input.mode??'STRICT').toUpperCase();
  const mode:( 'STRICT'|'CERTIFIED'|'EXPANDED')=requested==='EXPANDED'?'EXPANDED':requested==='CERTIFIED'?'CERTIFIED':'STRICT';
  const buildUuid = crypto.randomUUID();
  const inserted = await env.DB.prepare(`
    INSERT INTO backtest_dataset_builds (build_uuid,dataset_version,dataset_mode,status,trigger_source,started_at)
    VALUES (?,'historical-dataset-v3',?,'RUNNING',?,CURRENT_TIMESTAMP)
  `).bind(buildUuid,mode, triggerSource).run();
  const buildId = Number(inserted.meta.last_row_id);

  try {
    const candidates = await env.DB.prepare(`
      WITH ranked AS (
        SELECT pfs.*,ROW_NUMBER() OVER (PARTITION BY pfs.prop_id,pfs.model_version_id ORDER BY pfs.captured_at DESC,pfs.prop_feature_snapshot_id DESC) rn
        FROM prop_feature_snapshots pfs JOIN prop_results pr0 ON pr0.prop_id=pfs.prop_id WHERE pr0.result_status<>'PENDING'
      )
      SELECT pfs.*,mp.model_prediction_id,mp.projected_strikeouts,mp.raw_more_probability,mp.raw_less_probability,
        mp.calibrated_more_probability,mp.calibrated_less_probability,mp.preferred_side,mp.model_edge,mp.decision model_decision,
        mp.confidence_score,mp.confidence_label,pr.actual_strikeouts,pr.result market_result,pr.graded_at,pr.innings_pitched,
        pr.pitch_count,pr.batters_faced,pr.starter
      FROM ranked pfs JOIN prop_results pr ON pr.prop_id=pfs.prop_id
      LEFT JOIN model_predictions mp ON mp.model_prediction_id=(SELECT mp2.model_prediction_id FROM model_predictions mp2 WHERE mp2.prop_feature_snapshot_id=pfs.prop_feature_snapshot_id AND mp2.prediction_mode='PRODUCTION' AND mp2.prediction_status='COMPLETE' ORDER BY mp2.predicted_at DESC,mp2.model_prediction_id DESC LIMIT 1)
      WHERE pfs.rn=1 ORDER BY pfs.board_date,pfs.prop_id
    `).all<HistoricalDatasetCandidate>();

    const statements:D1PreparedStatement[]=[];
    for(const row of candidates.results??[]){
      const cutoff=featureCutoffStatus(row), marketResult=String(row.market_result??'').toUpperCase(), preferredSide=String(row.preferred_side??'').toUpperCase();
      const moreOutcome=historicalOutcome('MORE',marketResult), lessOutcome=historicalOutcome('LESS',marketResult), preferredOutcome=preferredSide==='MORE'?moreOutcome:preferredSide==='LESS'?lessOutcome:'NONE';
      const reasons:string[]=[];
      if(row.snapshot_status!=='COMPLETE')reasons.push(`snapshot_${String(row.snapshot_status).toLowerCase()}`);
      if(row.quality_gate==='BLOCK')reasons.push('quality_block'); if(Number(row.challenger_eligible)!==1)reasons.push('not_challenger_eligible');
      if(cutoff==='UNKNOWN')reasons.push('feature_cutoff_unknown'); if(cutoff==='FAIL')reasons.push('feature_cutoff_not_pregame'); if(!row.graded_at)reasons.push('graded_timestamp_missing');
      const certified=reasons.length===0, eligible=certified&&(marketResult==='OVER'||marketResult==='UNDER');
      statements.push(env.DB.prepare(`INSERT INTO backtest_dataset_rows_v3(
        backtest_dataset_build_id,dataset_version,source_provenance,prop_feature_snapshot_id,prop_id,board_id,board_date,model_version_id,model_prediction_id,pitcher_id,opponent_team_id,pitcher_hand,prop_line,captured_at,information_cutoff_at,pitcher_source_cutoff_date,team_source_cutoff_date,snapshot_status,overall_data_quality_score,data_quality_grade,quality_gate,challenger_eligible,projected_strikeouts,raw_more_probability,raw_less_probability,calibrated_more_probability,calibrated_less_probability,preferred_side,model_edge,model_decision,confidence_score,confidence_label,actual_strikeouts,market_result,graded_at,innings_pitched,pitch_count,batters_faced,starter,more_outcome,less_outcome,preferred_outcome,feature_cutoff_status,certification_status,exclusion_reason,backtest_eligible,pitcher_features_json,team_features_json,quality_flags_json,critical_quality_flags_json,context_json
      ) VALUES (?,?, 'NATIVE',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        buildId,'historical-dataset-v3',row.prop_feature_snapshot_id,row.prop_id,row.board_id,row.board_date,row.model_version_id,row.model_prediction_id,row.pitcher_id,row.opponent_team_id,row.pitcher_hand,row.prop_line,row.captured_at,row.information_cutoff_at,row.pitcher_source_cutoff_date,row.team_source_cutoff_date,row.snapshot_status,row.overall_data_quality_score,row.data_quality_grade,row.quality_gate,Number(row.challenger_eligible)||0,row.projected_strikeouts,row.raw_more_probability,row.raw_less_probability,row.calibrated_more_probability,row.calibrated_less_probability,row.preferred_side,row.model_edge,row.model_decision,row.confidence_score,row.confidence_label,row.actual_strikeouts,marketResult||null,row.graded_at,row.innings_pitched,row.pitch_count,row.batters_faced,row.starter,moreOutcome,lessOutcome,preferredOutcome,cutoff,certified?'CERTIFIED':'EXCLUDED',reasons.length?reasons.join(','):null,eligible?1:0,row.pitcher_features_json,row.team_features_json,row.quality_flags_json||'[]',row.critical_quality_flags_json||'[]',row.context_json||'{}'));
    }

    if(mode!=='STRICT'){
      const allowed=mode==='CERTIFIED'?"('RECONSTRUCTED_A')":"('RECONSTRUCTED_A','RECONSTRUCTED_B')";
      const recs=await env.DB.prepare(`
        WITH latest_cert AS (
          SELECT c.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY historical_certification_id DESC) rn
          FROM historical_feature_certifications c
        ),
        latest_i AS (
          SELECT i.*,ROW_NUMBER() OVER(PARTITION BY prop_id ORDER BY independent_reconstruction_id DESC) rn
          FROM independent_historical_reconstructions i
        )
        SELECT
          c.historical_reconstruction_id,c.historical_certification_id,i.independent_reconstruction_id,c.certification_class,c.certification_score,
          i.prop_id,i.board_id,i.board_date,c.certified_model_version_id AS model_version_id,
          i.pitcher_id,i.opponent_team_id,i.pitcher_hand,i.prop_line,
          c.information_cutoff_at AS recommendation_generated_at,NULL AS legacy_snapshot_time,
          i.last_start_date AS latest_pitcher_game_date,i.feature_json AS pitcher_features_json,
          c.certified_opponent_features_json AS opponent_features_json,c.certified_model_output_json AS model_output_json,
          i.actual_strikeouts,i.market_result,i.graded_at,c.information_cutoff_at AS certified_information_cutoff_at,c.certification_version
        FROM latest_cert c
        JOIN latest_i i ON i.prop_id=c.prop_id AND i.rn=1
        WHERE c.rn=1 AND c.certification_version='independent-certification-v1'
          AND c.certification_status='CERTIFIED' AND c.certification_class IN ${allowed}
          AND c.certified_model_version_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM prop_feature_snapshots pfs WHERE pfs.prop_id=i.prop_id)
        ORDER BY i.board_date,i.prop_id
      `).all<ReconstructedDatasetCandidate>();
      for(const row of recs.results??[]){
        let model:any={}; try{model=JSON.parse(row.model_output_json||'{}')}catch{}
        const marketResult=String(row.market_result??'').toUpperCase(), preferredSide=String(model.preferred_side??'').toUpperCase();
        const moreOutcome=historicalOutcome('MORE',marketResult),lessOutcome=historicalOutcome('LESS',marketResult),preferredOutcome=preferredSide==='MORE'?moreOutcome:preferredSide==='LESS'?lessOutcome:'NONE';
        const over=Number(model.estimated_over_rate); const moreProb=Number.isFinite(over)?Math.max(0,Math.min(1,over>1?over/100:over)):null; const lessProb=moreProb==null?null:1-moreProb;
        const prov=row.certification_class as 'RECONSTRUCTED_A'|'RECONSTRUCTED_B';
        const cutoff=prov==='RECONSTRUCTED_A'?'PASS':'UNKNOWN'; const gate=prov==='RECONSTRUCTED_A'?'PASS':'CAUTION';
        const eligible=(marketResult==='OVER'||marketResult==='UNDER');
        statements.push(env.DB.prepare(`INSERT INTO backtest_dataset_rows_v3(
          backtest_dataset_build_id,dataset_version,source_provenance,historical_reconstruction_id,historical_certification_id,prop_id,board_id,board_date,model_version_id,pitcher_id,opponent_team_id,pitcher_hand,prop_line,captured_at,information_cutoff_at,pitcher_source_cutoff_date,team_source_cutoff_date,snapshot_status,overall_data_quality_score,data_quality_grade,quality_gate,challenger_eligible,projected_strikeouts,raw_more_probability,raw_less_probability,preferred_side,model_edge,model_decision,confidence_score,confidence_label,actual_strikeouts,market_result,graded_at,more_outcome,less_outcome,preferred_outcome,feature_cutoff_status,certification_status,backtest_eligible,pitcher_features_json,team_features_json,quality_flags_json,critical_quality_flags_json,context_json
        ) VALUES (?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          buildId,'historical-dataset-v3',prov,row.historical_reconstruction_id,row.historical_certification_id,row.prop_id,row.board_id,row.board_date,row.model_version_id,row.pitcher_id,row.opponent_team_id,row.pitcher_hand,row.prop_line,row.recommendation_generated_at||row.certified_information_cutoff_at,row.certified_information_cutoff_at,row.latest_pitcher_game_date,prov==='RECONSTRUCTED_A'?String(row.board_date):null,'COMPLETE',row.certification_score,row.certification_score>=90?'A':row.certification_score>=80?'B':row.certification_score>=70?'C':'D',gate,1,model.projected_strikeouts??null,moreProb,lessProb,preferredSide||null,model.model_edge??null,model.final_decision??model.model_decision??null,model.confidence_score??null,model.confidence_band??null,row.actual_strikeouts,marketResult||null,row.graded_at,moreOutcome,lessOutcome,preferredOutcome,cutoff,'CERTIFIED',eligible?1:0,row.pitcher_features_json,row.opponent_features_json,JSON.stringify([`provenance_${prov.toLowerCase()}`]),'[]',JSON.stringify({legacy_fk_anchor_historical_reconstruction_id:row.historical_reconstruction_id,independent_reconstruction_id:row.independent_reconstruction_id??null,historical_certification_id:row.historical_certification_id,certification_version:row.certification_version,dataset_mode:mode,provenance:prov,cutoff_policy:'scheduled_game_start',legacy_snapshots_used:false,legacy_recommendations_used:false})));
      }
    }


    if(mode!=='STRICT'){
      const archiveAllowed=mode==='CERTIFIED'?"('ARCHIVE_RECONSTRUCTED_A')":"('ARCHIVE_RECONSTRUCTED_A','ARCHIVE_RECONSTRUCTED_B')";
      const archiveRows=await env.DB.prepare(`
        WITH latest_c AS (
          SELECT c.*,ROW_NUMBER() OVER(PARTITION BY historical_archive_prop_id ORDER BY archive_historical_certification_id DESC) rn
          FROM archive_historical_certifications c
        )
        SELECT c.*,r.pitcher_id,r.opponent_team_id,r.pitcher_hand,r.prop_line,r.last_start_date,r.feature_json,
               r.reconstructed_projection,r.reconstructed_edge,r.reconstructed_over_probability,r.reconstructed_preferred_side,
               r.actual_strikeouts,r.market_result,a.pitcher_name,a.opponent_abbreviation
        FROM latest_c c
        JOIN archive_historical_reconstructions r ON r.archive_historical_reconstruction_id=c.archive_historical_reconstruction_id
        JOIN historical_archive_props a ON a.historical_archive_prop_id=c.historical_archive_prop_id
        WHERE c.rn=1 AND c.certification_version='archive-certification-v1' AND c.certification_status='CERTIFIED'
          AND c.certification_class IN ${archiveAllowed} AND c.certified_model_version_id IS NOT NULL
        ORDER BY c.board_date,c.historical_archive_prop_id
      `).all<Record<string,unknown>>();
      for(const row of archiveRows.results??[]){
        const marketResult=String(row.market_result??'').toUpperCase();
        const preferredSide=String(row.reconstructed_preferred_side??'').toUpperCase();
        const moreOutcome=historicalOutcome('MORE',marketResult),lessOutcome=historicalOutcome('LESS',marketResult),preferredOutcome=preferredSide==='MORE'?moreOutcome:preferredSide==='LESS'?lessOutcome:'NONE';
        const overRaw=Number(row.reconstructed_over_probability);const moreProb=Number.isFinite(overRaw)?Math.max(0,Math.min(1,overRaw>1?overRaw/100:overRaw)):null;const lessProb=moreProb==null?null:1-moreProb;
        const prov=String(row.certification_class) as 'ARCHIVE_RECONSTRUCTED_A'|'ARCHIVE_RECONSTRUCTED_B';
        const cutoff=prov==='ARCHIVE_RECONSTRUCTED_A'?'PASS':'UNKNOWN',gate=prov==='ARCHIVE_RECONSTRUCTED_A'?'PASS':'CAUTION';
        const eligible=(marketResult==='OVER'||marketResult==='UNDER');
        statements.push(env.DB.prepare(`INSERT INTO backtest_dataset_rows_v3(
          backtest_dataset_build_id,dataset_version,source_provenance,archive_historical_reconstruction_id,archive_certification_id,historical_archive_prop_id,
          board_date,model_version_id,pitcher_id,opponent_team_id,pitcher_hand,prop_line,captured_at,information_cutoff_at,pitcher_source_cutoff_date,
          snapshot_status,overall_data_quality_score,data_quality_grade,quality_gate,challenger_eligible,projected_strikeouts,raw_more_probability,raw_less_probability,
          preferred_side,model_edge,model_decision,confidence_score,confidence_label,actual_strikeouts,market_result,more_outcome,less_outcome,preferred_outcome,
          feature_cutoff_status,certification_status,backtest_eligible,pitcher_features_json,team_features_json,quality_flags_json,critical_quality_flags_json,context_json
        ) VALUES (?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          buildId,'historical-dataset-v3',prov,row.archive_historical_reconstruction_id,row.archive_historical_certification_id,row.historical_archive_prop_id,
          row.board_date,row.certified_model_version_id,row.pitcher_id,row.opponent_team_id,row.pitcher_hand,row.prop_line,row.information_cutoff_at,row.information_cutoff_at,row.last_start_date,
          'COMPLETE',row.certification_score,Number(row.certification_score)>=90?'A':'B',gate,1,row.reconstructed_projection,moreProb,lessProb,preferredSide||null,row.reconstructed_edge,
          'RESEARCH_RECONSTRUCTION',row.certification_score,prov==='ARCHIVE_RECONSTRUCTED_A'?'A':'B',row.actual_strikeouts,marketResult||null,moreOutcome,lessOutcome,preferredOutcome,
          cutoff,'CERTIFIED',eligible?1:0,row.feature_json,row.feature_json,JSON.stringify([`provenance_${prov.toLowerCase()}`]),'[]',
          JSON.stringify({archive_historical_reconstruction_id:row.archive_historical_reconstruction_id,archive_certification_id:row.archive_historical_certification_id,historical_archive_prop_id:row.historical_archive_prop_id,certification_version:row.certification_version,dataset_mode:mode,provenance:prov,cutoff_policy:'board_date_pregame_only',native_snapshots_modified:false})));
      }
    }

    for(let i=0;i<statements.length;i+=40)await env.DB.batch(statements.slice(i,i+40));
    const summary=await env.DB.prepare(`SELECT COUNT(*) dataset_row_count,SUM(CASE WHEN backtest_eligible=1 THEN 1 ELSE 0 END) eligible_row_count,SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded_row_count,SUM(CASE WHEN market_result='PUSH' THEN 1 ELSE 0 END) push_count,SUM(CASE WHEN market_result='VOID' THEN 1 ELSE 0 END) void_count,MIN(board_date) board_date_min,MAX(board_date) board_date_max,SUM(CASE WHEN source_provenance='NATIVE' THEN 1 ELSE 0 END) native_rows,SUM(CASE WHEN source_provenance='RECONSTRUCTED_A' THEN 1 ELSE 0 END) reconstructed_a_rows,SUM(CASE WHEN source_provenance='RECONSTRUCTED_B' THEN 1 ELSE 0 END) reconstructed_b_rows,SUM(CASE WHEN source_provenance='ARCHIVE_RECONSTRUCTED_A' THEN 1 ELSE 0 END) archive_reconstructed_a_rows,SUM(CASE WHEN source_provenance='ARCHIVE_RECONSTRUCTED_B' THEN 1 ELSE 0 END) archive_reconstructed_b_rows FROM backtest_dataset_rows_v3 WHERE backtest_dataset_build_id=?`).bind(buildId).first<Record<string,unknown>>();
    await env.DB.prepare(`UPDATE backtest_dataset_builds SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,source_snapshot_count=?,dataset_row_count=?,eligible_row_count=?,excluded_row_count=?,push_count=?,void_count=?,board_date_min=?,board_date_max=?,details_json=? WHERE backtest_dataset_build_id=?`).bind(Number(summary?.native_rows??0),Number(summary?.dataset_row_count??0),Number(summary?.eligible_row_count??0),Number(summary?.excluded_row_count??0),Number(summary?.push_count??0),Number(summary?.void_count??0),summary?.board_date_min??null,summary?.board_date_max??null,JSON.stringify({dataset_mode:mode,native_rows:Number(summary?.native_rows??0),reconstructed_a_rows:Number(summary?.reconstructed_a_rows??0),reconstructed_b_rows:Number(summary?.reconstructed_b_rows??0),archive_reconstructed_a_rows:Number(summary?.archive_reconstructed_a_rows??0),archive_reconstructed_b_rows:Number(summary?.archive_reconstructed_b_rows??0),native_snapshots_modified:false}),buildId).run();
    return json({ok:true,build_id:buildId,dataset_mode:mode,...summary});
  }catch(error){await env.DB.prepare(`UPDATE backtest_dataset_builds SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE backtest_dataset_build_id=?`).bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),buildId).run();throw error;}
}

async function getHistoricalDatasetStatus(env: Env, url: URL): Promise<Response> {
  const buildIdParam = Number(url.searchParams.get('build_id') ?? 0);
  const latest = buildIdParam > 0
    ? await env.DB.prepare(`SELECT * FROM backtest_dataset_builds WHERE backtest_dataset_build_id=?`).bind(buildIdParam).first<Record<string, unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_dataset_builds ORDER BY backtest_dataset_build_id DESC LIMIT 1`).first<Record<string, unknown>>();
  const builds = await env.DB.prepare(`SELECT * FROM backtest_dataset_builds ORDER BY backtest_dataset_build_id DESC LIMIT 12`).all<Record<string, unknown>>();
  if (!latest) return json({latest_build:null,builds:builds.results,rows:[],summary:{}});
  const latestId = Number(latest.backtest_dataset_build_id);
  const rows = await env.DB.prepare(`
    SELECT r.*,COALESCE(pi.canonical_name,a.pitcher_name) AS pitcher_name,COALESCE(t.abbreviation,a.opponent_abbreviation) AS opponent,mv.version_name
    FROM backtest_dataset_rows_v3 r
    LEFT JOIN pitchers pi ON pi.pitcher_id=r.pitcher_id
    LEFT JOIN teams t ON t.team_id=r.opponent_team_id
    LEFT JOIN historical_archive_props a ON a.historical_archive_prop_id=r.historical_archive_prop_id
    JOIN model_versions mv ON mv.model_version_id=r.model_version_id
    WHERE r.backtest_dataset_build_id=?
    ORDER BY r.board_date DESC,r.prop_id DESC LIMIT 250
  `).bind(latestId).all<Record<string, unknown>>();
  const summary = await env.DB.prepare(`
    SELECT COUNT(*) dataset_rows,
      SUM(CASE WHEN certification_status='CERTIFIED' THEN 1 ELSE 0 END) certified_rows,
      SUM(CASE WHEN backtest_eligible=1 THEN 1 ELSE 0 END) eligible_rows,
      SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded_rows,
      SUM(CASE WHEN more_outcome='WIN' THEN 1 ELSE 0 END) more_wins,
      SUM(CASE WHEN more_outcome='LOSS' THEN 1 ELSE 0 END) more_losses,
      SUM(CASE WHEN less_outcome='WIN' THEN 1 ELSE 0 END) less_wins,
      SUM(CASE WHEN less_outcome='LOSS' THEN 1 ELSE 0 END) less_losses,
      SUM(CASE WHEN source_provenance='NATIVE' THEN 1 ELSE 0 END) native_rows,
      SUM(CASE WHEN source_provenance='RECONSTRUCTED_A' THEN 1 ELSE 0 END) reconstructed_a_rows,
      SUM(CASE WHEN source_provenance='RECONSTRUCTED_B' THEN 1 ELSE 0 END) reconstructed_b_rows,
      SUM(CASE WHEN source_provenance='ARCHIVE_RECONSTRUCTED_A' THEN 1 ELSE 0 END) archive_reconstructed_a_rows,
      SUM(CASE WHEN source_provenance='ARCHIVE_RECONSTRUCTED_B' THEN 1 ELSE 0 END) archive_reconstructed_b_rows,
      MIN(board_date) board_date_min, MAX(board_date) board_date_max
    FROM backtest_dataset_rows_v3 WHERE backtest_dataset_build_id=?
  `).bind(latestId).first<Record<string, unknown>>();
  return json({latest_build:latest,builds:builds.results,rows:rows.results,summary});
}


type WalkForwardDatasetRow = {
  backtest_dataset_row_id: number;
  board_date: string;
  preferred_side: string | null;
  preferred_outcome: string | null;
  raw_more_probability: number | null;
  raw_less_probability: number | null;
  calibrated_more_probability: number | null;
  calibrated_less_probability: number | null;
};

function preferredProbability(row: WalkForwardDatasetRow): number | null {
  const side = String(row.preferred_side ?? '').toUpperCase();
  let value: number | null = null;
  if (side === 'MORE') value = row.calibrated_more_probability ?? row.raw_more_probability;
  if (side === 'LESS') value = row.calibrated_less_probability ?? row.raw_less_probability;
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return Math.max(0, Math.min(1, n));
}

async function runWalkForwardBacktest(request: Request, env: Env): Promise<Response> {
  let input: { dataset_build_id?: number; min_train_dates?: number; min_train_rows?: number } = {};
  try { input = await request.json() as typeof input; } catch { input = {}; }
  const latestDataset = input.dataset_build_id
    ? await env.DB.prepare(`SELECT * FROM backtest_dataset_builds WHERE backtest_dataset_build_id=? AND status='SUCCEEDED' AND dataset_version='historical-dataset-v3'`).bind(Number(input.dataset_build_id)).first<Record<string, unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_dataset_builds WHERE status='SUCCEEDED' AND dataset_version='historical-dataset-v3' ORDER BY backtest_dataset_build_id DESC LIMIT 1`).first<Record<string, unknown>>();
  if (!latestDataset) return json({error:'No successful historical dataset build exists. Build the dataset first.'},{status:400});

  const datasetBuildId = Number(latestDataset.backtest_dataset_build_id);
  const minTrainDates = Math.max(1, Math.min(60, Number(input.min_train_dates ?? 5)));
  const minTrainRows = Math.max(1, Math.min(5000, Number(input.min_train_rows ?? 50)));
  const runUuid = crypto.randomUUID();
  const created = await env.DB.prepare(`
    INSERT INTO backtest_runs (run_uuid,engine_version,backtest_dataset_build_id,status,trigger_source,min_train_dates,min_train_rows,test_window_days,started_at)
    VALUES (?,'walk-forward-v2',?,'RUNNING','ADMIN',?,?,1,CURRENT_TIMESTAMP)
  `).bind(runUuid,datasetBuildId,minTrainDates,minTrainRows).run();
  const runId = Number(created.meta.last_row_id);

  try {
    const all = await env.DB.prepare(`
      SELECT backtest_dataset_row_id,board_date,preferred_side,preferred_outcome,
             raw_more_probability,raw_less_probability,calibrated_more_probability,calibrated_less_probability
      FROM backtest_dataset_rows_v3
      WHERE backtest_dataset_build_id=? AND backtest_eligible=1
      ORDER BY board_date,backtest_dataset_row_id
    `).bind(datasetBuildId).all<WalkForwardDatasetRow>();
    const rows = all.results ?? [];
    const dates = [...new Set(rows.map(r=>String(r.board_date).slice(0,10)).filter(Boolean))].sort();
    let executed = 0, skipped = 0;
    let foldIndex = 0;
    for (const testDate of dates) {
      foldIndex += 1;
      const trainRows = rows.filter(r=>String(r.board_date).slice(0,10) < testDate);
      const testRows = rows.filter(r=>String(r.board_date).slice(0,10) === testDate);
      const trainDates = [...new Set(trainRows.map(r=>String(r.board_date).slice(0,10)))].sort();
      const trainDateMin = trainDates[0] ?? null;
      const trainDateMax = trainDates.at(-1) ?? null;
      const noFutureOverlap = !trainDateMax || trainDateMax < testDate;
      const reasons: string[] = [];
      if (trainDates.length < minTrainDates) reasons.push(`need_${minTrainDates}_prior_dates_have_${trainDates.length}`);
      if (trainRows.length < minTrainRows) reasons.push(`need_${minTrainRows}_prior_rows_have_${trainRows.length}`);
      if (!noFutureOverlap) reasons.push('future_overlap_detected');
      const status = reasons.length ? 'SKIPPED' : 'EXECUTED';

      let wins=0, losses=0, pushes=0, brierSum=0, brierN=0, probSum=0, probN=0;
      if (status === 'EXECUTED') {
        for (const row of testRows) {
          const outcome=String(row.preferred_outcome??'').toUpperCase();
          if (outcome==='WIN') wins++;
          else if (outcome==='LOSS') losses++;
          else if (outcome==='PUSH') pushes++;
          const p=preferredProbability(row);
          if (p!=null && (outcome==='WIN'||outcome==='LOSS')) { const y=outcome==='WIN'?1:0; brierSum+=(p-y)*(p-y); brierN++; }
          if (p!=null) { probSum+=p; probN++; }
        }
      }
      const graded=wins+losses;
      const hitRate=graded?wins/graded:null;
      const brier=brierN?brierSum/brierN:null;
      const avgProb=probN?probSum/probN:null;
      const fold = await env.DB.prepare(`
        INSERT INTO backtest_folds (
          backtest_run_id,fold_index,status,skip_reason,train_date_min,train_date_max,test_date_min,test_date_max,
          train_distinct_dates,train_row_count,test_row_count,no_future_overlap,preferred_wins,preferred_losses,preferred_pushes,
          preferred_hit_rate,brier_score,average_preferred_probability,details_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(runId,foldIndex,status,reasons.join(';')||null,trainDateMin,trainDateMax,testDate,testDate,
        trainDates.length,trainRows.length,testRows.length,noFutureOverlap?1:0,wins,losses,pushes,hitRate,brier,avgProb,
        JSON.stringify({test_date:testDate,policy:'train_dates_strictly_before_test_date',probability_source:'calibrated_then_raw'})).run();
      const foldId=Number(fold.meta.last_row_id);
      const memberStatements:D1PreparedStatement[]=[];
      for (const row of trainRows) memberStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO backtest_fold_rows_v3 (backtest_fold_id,backtest_dataset_row_id,partition) VALUES (?,?,'TRAIN')`).bind(foldId,row.backtest_dataset_row_id));
      for (const row of testRows) memberStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO backtest_fold_rows_v3 (backtest_fold_id,backtest_dataset_row_id,partition) VALUES (?,?,'TEST')`).bind(foldId,row.backtest_dataset_row_id));
      for (let i=0;i<memberStatements.length;i+=50) await env.DB.batch(memberStatements.slice(i,i+50));
      if (status==='EXECUTED') executed++; else skipped++;
    }
    const runStatus = executed>0 ? (skipped>0?'PARTIAL':'SUCCEEDED') : 'SUCCEEDED';
    await env.DB.prepare(`UPDATE backtest_runs SET status=?,completed_at=CURRENT_TIMESTAMP,eligible_row_count=?,distinct_test_dates=?,fold_count=?,executed_fold_count=?,skipped_fold_count=?,train_date_min=?,train_date_max=?,test_date_min=?,test_date_max=?,details_json=? WHERE backtest_run_id=?`)
      .bind(runStatus,rows.length,dates.length,dates.length,executed,skipped,dates.length>1?dates[0]:null,dates.length>1?dates.at(-2):null,dates[0]??null,dates.at(-1)??null,
        JSON.stringify({minimums:{train_dates:minTrainDates,train_rows:minTrainRows},message:executed===0?'No folds met minimum prior-history requirements yet. This is expected until more graded snapshot dates accumulate.':'Walk-forward folds evaluated.'}),runId).run();
    return json({ok:true,backtest_run_id:runId,eligible_rows:rows.length,distinct_test_dates:dates.length,folds:dates.length,executed,skipped});
  } catch (error) {
    await env.DB.prepare(`UPDATE backtest_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE backtest_run_id=?`).bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),runId).run();
    throw error;
  }
}

async function getWalkForwardBacktestStatus(env: Env, url: URL): Promise<Response> {
  const runParam=Number(url.searchParams.get('run_id')??0);
  const latest=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=?`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM backtest_runs ORDER BY backtest_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  if(!latest) return json({latest_run:null,runs:runs.results,folds:[],summary:{}});
  const runId=Number(latest.backtest_run_id);
  const folds=await env.DB.prepare(`SELECT * FROM backtest_folds WHERE backtest_run_id=? ORDER BY fold_index`).bind(runId).all<Record<string,unknown>>();
  const summary=await env.DB.prepare(`SELECT COUNT(*) fold_count,SUM(CASE WHEN status='EXECUTED' THEN 1 ELSE 0 END) executed_folds,SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) skipped_folds,SUM(preferred_wins) wins,SUM(preferred_losses) losses,SUM(preferred_pushes) pushes,AVG(CASE WHEN status='EXECUTED' THEN preferred_hit_rate END) avg_fold_hit_rate,AVG(CASE WHEN status='EXECUTED' THEN brier_score END) avg_fold_brier FROM backtest_folds WHERE backtest_run_id=?`).bind(runId).first<Record<string,unknown>>();
  return json({latest_run:latest,runs:runs.results,folds:folds.results,summary});
}


type PerformanceDatasetRow = {
  backtest_dataset_row_id: number;
  board_date: string;
  preferred_side: string | null;
  preferred_outcome: string | null;
  model_decision: string | null;
  confidence_score: number | null;
  raw_more_probability: number | null;
  raw_less_probability: number | null;
  calibrated_more_probability: number | null;
  calibrated_less_probability: number | null;
};

type PerformanceSimulation = {
  power_legs: number;
  power_multiplier: number;
  flex_legs: number;
  flex_full_multiplier: number;
  flex_partial_hits: number;
  flex_partial_multiplier: number;
};

type PerformanceStats = {
  row_count: number;
  graded_count: number;
  wins: number;
  losses: number;
  pushes: number;
  hit_rate: number | null;
  brier_score: number | null;
  calibration_error: number | null;
  more_wins: number;
  more_losses: number;
  more_pushes: number;
  more_hit_rate: number | null;
  less_wins: number;
  less_losses: number;
  less_pushes: number;
  less_hit_rate: number | null;
  avg_predicted_probability: number | null;
  qualified_play_count: number;
  distinct_dates: number;
  picks_per_day: number | null;
  qualified_plays_per_day: number | null;
  max_drawdown_units: number | null;
  longest_losing_streak: number;
  power_roi: number | null;
  flex_roi: number | null;
  power_entries: number;
  flex_entries: number;
  bins: Array<{
    bucket_index: number;
    probability_min: number;
    probability_max: number;
    observation_count: number;
    average_predicted_probability: number | null;
    observed_win_rate: number | null;
    absolute_calibration_error: number | null;
  }>;
};

function simulationNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n=Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.max(min,Math.min(max,n));
}

function performanceProbability(row: PerformanceDatasetRow): number | null {
  const side=String(row.preferred_side??'').toUpperCase();
  let value:number|null=null;
  if(side==='MORE') value=row.calibrated_more_probability ?? row.raw_more_probability;
  if(side==='LESS') value=row.calibrated_less_probability ?? row.raw_less_probability;
  if(value==null || !Number.isFinite(Number(value))) return null;
  return Math.max(0,Math.min(1,Number(value)));
}

function simulateEntries(rows: PerformanceDatasetRow[], type:'POWER'|'FLEX', simulation:PerformanceSimulation): {roi:number|null; entries:number} {
  const legs=type==='POWER'?simulation.power_legs:simulation.flex_legs;
  const byDate=new Map<string,PerformanceDatasetRow[]>();
  for(const row of rows){
    if(String(row.model_decision??'').toUpperCase()!=='PLAY') continue;
    const d=String(row.board_date).slice(0,10);
    const arr=byDate.get(d)??[];
    arr.push(row);
    byDate.set(d,arr);
  }
  let stake=0, returned=0, entries=0;
  for(const dateRows of byDate.values()){
    dateRows.sort((a,b)=>Number(b.confidence_score??0)-Number(a.confidence_score??0) || a.backtest_dataset_row_id-b.backtest_dataset_row_id);
    for(let i=0;i+legs<=dateRows.length;i+=legs){
      const chunk=dateRows.slice(i,i+legs);
      const outcomes=chunk.map(r=>String(r.preferred_outcome??'').toUpperCase());
      if(outcomes.some(x=>x==='PUSH'||x==='VOID'||(x!=='WIN'&&x!=='LOSS'))) continue;
      const wins=outcomes.filter(x=>x==='WIN').length;
      let mult=0;
      if(type==='POWER') mult=wins===legs?simulation.power_multiplier:0;
      else if(wins===legs) mult=simulation.flex_full_multiplier;
      else if(wins===simulation.flex_partial_hits) mult=simulation.flex_partial_multiplier;
      stake+=1;
      returned+=mult;
      entries+=1;
    }
  }
  return {roi:entries?(returned-stake)/stake:null,entries};
}

function calculatePerformanceStats(rows: PerformanceDatasetRow[], simulation:PerformanceSimulation): PerformanceStats {
  let wins=0,losses=0,pushes=0,moreWins=0,moreLosses=0,morePushes=0,lessWins=0,lessLosses=0,lessPushes=0;
  let brierSum=0,brierN=0,probSum=0,probN=0;
  const bins=Array.from({length:10},(_,i)=>({bucket_index:i,probability_min:i/10,probability_max:(i+1)/10,n:0,pSum:0,ySum:0}));
  let equity=0,peak=0,maxDrawdown=0,currentLosing=0,longestLosing=0;
  const ordered=[...rows].sort((a,b)=>String(a.board_date).localeCompare(String(b.board_date)) || a.backtest_dataset_row_id-b.backtest_dataset_row_id);
  for(const row of ordered){
    const outcome=String(row.preferred_outcome??'').toUpperCase();
    const side=String(row.preferred_side??'').toUpperCase();
    if(outcome==='WIN') wins++;
    else if(outcome==='LOSS') losses++;
    else if(outcome==='PUSH') pushes++;
    if(side==='MORE'){
      if(outcome==='WIN') moreWins++; else if(outcome==='LOSS') moreLosses++; else if(outcome==='PUSH') morePushes++;
    } else if(side==='LESS'){
      if(outcome==='WIN') lessWins++; else if(outcome==='LOSS') lessLosses++; else if(outcome==='PUSH') lessPushes++;
    }
    const p=performanceProbability(row);
    if(p!=null){probSum+=p;probN++;}
    if(p!=null && (outcome==='WIN'||outcome==='LOSS')){
      const y=outcome==='WIN'?1:0;
      brierSum+=(p-y)*(p-y); brierN++;
      const bi=Math.min(9,Math.floor(p*10));
      bins[bi].n++; bins[bi].pSum+=p; bins[bi].ySum+=y;
    }
    if(outcome==='WIN'){equity+=1;currentLosing=0;}
    else if(outcome==='LOSS'){equity-=1;currentLosing++;longestLosing=Math.max(longestLosing,currentLosing);}
    peak=Math.max(peak,equity);
    maxDrawdown=Math.max(maxDrawdown,peak-equity);
  }
  const graded=wins+losses;
  const distinctDates=new Set(rows.map(r=>String(r.board_date).slice(0,10))).size;
  const qualified=rows.filter(r=>String(r.model_decision??'').toUpperCase()==='PLAY').length;
  const binRows=bins.map(b=>{
    const avg=b.n?b.pSum/b.n:null;
    const obs=b.n?b.ySum/b.n:null;
    return {
      bucket_index:b.bucket_index,
      probability_min:b.probability_min,
      probability_max:b.probability_max,
      observation_count:b.n,
      average_predicted_probability:avg,
      observed_win_rate:obs,
      absolute_calibration_error:avg!=null&&obs!=null?Math.abs(avg-obs):null,
    };
  });
  const ece=brierN?binRows.reduce((sum,b)=>sum+(b.observation_count/brierN)*Number(b.absolute_calibration_error??0),0):null;
  const power=simulateEntries(rows,'POWER',simulation);
  const flex=simulateEntries(rows,'FLEX',simulation);
  return {
    row_count:rows.length,graded_count:graded,wins,losses,pushes,
    hit_rate:graded?wins/graded:null,
    brier_score:brierN?brierSum/brierN:null,
    calibration_error:ece,
    more_wins:moreWins,more_losses:moreLosses,more_pushes:morePushes,
    more_hit_rate:(moreWins+moreLosses)?moreWins/(moreWins+moreLosses):null,
    less_wins:lessWins,less_losses:lessLosses,less_pushes:lessPushes,
    less_hit_rate:(lessWins+lessLosses)?lessWins/(lessWins+lessLosses):null,
    avg_predicted_probability:probN?probSum/probN:null,
    qualified_play_count:qualified,
    distinct_dates:distinctDates,
    picks_per_day:distinctDates?rows.length/distinctDates:null,
    qualified_plays_per_day:distinctDates?qualified/distinctDates:null,
    max_drawdown_units:rows.length?maxDrawdown:null,
    longest_losing_streak:longestLosing,
    power_roi:power.roi,flex_roi:flex.roi,power_entries:power.entries,flex_entries:flex.entries,
    bins:binRows,
  };
}

async function getExecutedPerformanceRows(env:Env, backtestRunId:number):Promise<PerformanceDatasetRow[]> {
  const run=await env.DB.prepare(`SELECT engine_version FROM backtest_runs WHERE backtest_run_id=?`).bind(backtestRunId).first<{engine_version:string}>();
  const useV3=String(run?.engine_version??'')==='walk-forward-v2';
  const foldTable=useV3?'backtest_fold_rows_v3':'backtest_fold_rows_v2';
  const datasetTable=useV3?'backtest_dataset_rows_v3':'backtest_dataset_rows_v2';
  const result=await env.DB.prepare(`
    SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,r.preferred_side,r.preferred_outcome,
           r.model_decision,r.confidence_score,r.raw_more_probability,r.raw_less_probability,
           r.calibrated_more_probability,r.calibrated_less_probability
    FROM backtest_folds f
    JOIN ${foldTable} fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST'
    JOIN ${datasetTable} r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id
    WHERE f.backtest_run_id=? AND f.status='EXECUTED'
    ORDER BY r.board_date,r.backtest_dataset_row_id
  `).bind(backtestRunId).all<PerformanceDatasetRow>();
  return result.results??[];
}

async function runBacktestPerformanceMetrics(request:Request,env:Env):Promise<Response>{
  let input:{backtest_run_id?:number;power_legs?:number;power_multiplier?:number;flex_legs?:number;flex_full_multiplier?:number;flex_partial_hits?:number;flex_partial_multiplier?:number}={};
  try{input=await request.json() as typeof input;}catch{input={};}
  const backtest=input.backtest_run_id
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=? AND status IN ('SUCCEEDED','PARTIAL')`).bind(Number(input.backtest_run_id)).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs WHERE status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  if(!backtest)return json({error:'No completed walk-forward run exists. Run walk-forward first.'},{status:400});
  const backtestRunId=Number(backtest.backtest_run_id);
  const simulation:PerformanceSimulation={
    power_legs:Math.round(simulationNumber(input.power_legs,2,2,6)),
    power_multiplier:simulationNumber(input.power_multiplier,3,0,100),
    flex_legs:Math.round(simulationNumber(input.flex_legs,3,2,6)),
    flex_full_multiplier:simulationNumber(input.flex_full_multiplier,2.25,0,100),
    flex_partial_hits:Math.round(simulationNumber(input.flex_partial_hits,2,0,6)),
    flex_partial_multiplier:simulationNumber(input.flex_partial_multiplier,1.25,0,100),
  };
  simulation.flex_partial_hits=Math.min(simulation.flex_legs-1,simulation.flex_partial_hits);
  const created=await env.DB.prepare(`
    INSERT INTO backtest_performance_runs(run_uuid,metrics_version,backtest_run_id,status,trigger_source,simulation_json,started_at)
    VALUES (?,'performance-metrics-v1',?,'RUNNING','ADMIN',?,CURRENT_TIMESTAMP)
  `).bind(crypto.randomUUID(),backtestRunId,JSON.stringify(simulation)).run();
  const perfRunId=Number(created.meta.last_row_id);
  try{
    const rows=await getExecutedPerformanceRows(env,backtestRunId);
    const latestDate=rows.length?[...rows].map(r=>String(r.board_date).slice(0,10)).sort().at(-1)??null:null;
    const windowDefs:[string,number|null][]=[['ALL',null],['7D',7],['14D',14],['30D',30]];
    let allStats:PerformanceStats|null=null;
    for(const [name,days] of windowDefs){
      let subset=rows;
      let dateMin:string|null=null;
      if(latestDate && days){
        const end=new Date(`${latestDate}T00:00:00Z`);
        const start=new Date(end);
        start.setUTCDate(start.getUTCDate()-(days-1));
        dateMin=start.toISOString().slice(0,10);
        subset=rows.filter(r=>String(r.board_date).slice(0,10)>=dateMin! && String(r.board_date).slice(0,10)<=latestDate);
      } else if(rows.length) dateMin=String(rows[0].board_date).slice(0,10);
      const stats=calculatePerformanceStats(subset,simulation);
      if(name==='ALL')allStats=stats;
      await env.DB.prepare(`
        INSERT INTO backtest_performance_windows(
          backtest_performance_run_id,window_name,date_min,date_max,row_count,graded_count,wins,losses,pushes,
          hit_rate,brier_score,calibration_error,more_wins,more_losses,more_pushes,more_hit_rate,
          less_wins,less_losses,less_pushes,less_hit_rate,avg_predicted_probability,qualified_play_count,
          picks_per_day,qualified_plays_per_day,max_drawdown_units,longest_losing_streak,power_roi,flex_roi,power_entries,flex_entries
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(perfRunId,name,dateMin,latestDate,stats.row_count,stats.graded_count,stats.wins,stats.losses,stats.pushes,
        stats.hit_rate,stats.brier_score,stats.calibration_error,stats.more_wins,stats.more_losses,stats.more_pushes,stats.more_hit_rate,
        stats.less_wins,stats.less_losses,stats.less_pushes,stats.less_hit_rate,stats.avg_predicted_probability,stats.qualified_play_count,
        stats.picks_per_day,stats.qualified_plays_per_day,stats.max_drawdown_units,stats.longest_losing_streak,stats.power_roi,stats.flex_roi,stats.power_entries,stats.flex_entries).run();
      const binStatements=stats.bins.map(b=>env.DB.prepare(`
        INSERT INTO backtest_calibration_bins(
          backtest_performance_run_id,window_name,bucket_index,probability_min,probability_max,observation_count,
          average_predicted_probability,observed_win_rate,absolute_calibration_error
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(perfRunId,name,b.bucket_index,b.probability_min,b.probability_max,b.observation_count,b.average_predicted_probability,b.observed_win_rate,b.absolute_calibration_error));
      if(binStatements.length)await env.DB.batch(binStatements);
    }
    const a=allStats??calculatePerformanceStats([],simulation);
    const details={message:rows.length?'Performance metrics calculated from TEST rows of executed walk-forward folds only.':'No executed walk-forward folds yet. Metrics are intentionally empty until sufficient prior history exists.',test_rows_only:true,executed_fold_count:Number(backtest.executed_fold_count??0)};
    await env.DB.prepare(`
      UPDATE backtest_performance_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,evaluated_row_count=?,graded_row_count=?,
        qualified_play_count=?,distinct_test_dates=?,hit_rate=?,brier_score=?,calibration_error=?,more_hit_rate=?,less_hit_rate=?,
        average_predicted_probability=?,picks_per_day=?,qualified_plays_per_day=?,max_drawdown_units=?,longest_losing_streak=?,
        power_roi=?,flex_roi=?,power_entries=?,flex_entries=?,details_json=?
      WHERE backtest_performance_run_id=?
    `).bind(a.row_count,a.graded_count,a.qualified_play_count,a.distinct_dates,a.hit_rate,a.brier_score,a.calibration_error,a.more_hit_rate,a.less_hit_rate,
      a.avg_predicted_probability,a.picks_per_day,a.qualified_plays_per_day,a.max_drawdown_units,a.longest_losing_streak,
      a.power_roi,a.flex_roi,a.power_entries,a.flex_entries,JSON.stringify(details),perfRunId).run();
    return json({ok:true,backtest_performance_run_id:perfRunId,backtest_run_id:backtestRunId,evaluated_rows:a.row_count,simulation});
  }catch(error){
    await env.DB.prepare(`UPDATE backtest_performance_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE backtest_performance_run_id=?`)
      .bind(JSON.stringify({error:error instanceof Error?error.message:String(error)}),perfRunId).run();
    throw error;
  }
}

async function getBacktestPerformanceStatus(env:Env,url:URL):Promise<Response>{
  const runParam=Number(url.searchParams.get('performance_run_id')??0);
  const latest=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_performance_runs WHERE backtest_performance_run_id=?`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_performance_runs ORDER BY backtest_performance_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM backtest_performance_runs ORDER BY backtest_performance_run_id DESC LIMIT 12`).all<Record<string,unknown>>();
  if(!latest)return json({latest_run:null,runs:runs.results,windows:[],bins:[],summary:{}});
  const id=Number(latest.backtest_performance_run_id);
  const windows=await env.DB.prepare(`SELECT * FROM backtest_performance_windows WHERE backtest_performance_run_id=? ORDER BY CASE window_name WHEN 'ALL' THEN 0 WHEN '7D' THEN 1 WHEN '14D' THEN 2 ELSE 3 END`).bind(id).all<Record<string,unknown>>();
  const bins=await env.DB.prepare(`SELECT * FROM backtest_calibration_bins WHERE backtest_performance_run_id=? AND window_name='ALL' ORDER BY bucket_index`).bind(id).all<Record<string,unknown>>();
  return json({latest_run:latest,runs:runs.results,windows:windows.results,bins:bins.results});
}



type ArchiveHistoricalCandidate = {
  historical_archive_prop_id:number; board_date:string; pitcher_name:string; team_abbreviation:string;
  opponent_abbreviation:string; pitcher_hand:string|null; prop_line:number; actual_strikeouts:number|null; market_result:string;
};

async function runArchiveHistoricalReconstruction(request:Request,env:Env):Promise<Response>{
  const body:Record<string,unknown>=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
  const restart=Number(body.restart??0)===1;
  const latest=await env.DB.prepare(`SELECT COALESCE(MAX(cursor_end_archive_prop_id),0) cursor FROM archive_historical_reconstruction_runs WHERE status IN ('SUCCEEDED','PARTIAL')`).first<{cursor:number}>();
  const cursor=restart?0:Number(latest?.cursor??0);
  const made=await env.DB.prepare(`INSERT INTO archive_historical_reconstruction_runs(run_uuid,reconstruction_version,status,trigger_source,cursor_start_archive_prop_id,started_at) VALUES (?,'archive-reconstruction-v1.1','RUNNING','ADMIN',?,CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(),cursor).run();
  const runId=Number(made.meta.last_row_id);
  try{
    const candidate=await env.DB.prepare(`
      SELECT historical_archive_prop_id,board_date,pitcher_name,team_abbreviation,opponent_abbreviation,pitcher_hand,prop_line,actual_strikeouts,market_result
      FROM historical_archive_props a
      WHERE historical_archive_prop_id>? AND eligible_for_reconstruction=1
        AND market_result IN ('Over','Under','Push') AND actual_strikeouts IS NOT NULL
      ORDER BY historical_archive_prop_id LIMIT 1
    `).bind(cursor).first<ArchiveHistoricalCandidate>();
    if(!candidate){
      await env.DB.prepare(`UPDATE archive_historical_reconstruction_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,cursor_end_archive_prop_id=?,details_json=? WHERE archive_reconstruction_run_id=?`)
        .bind(cursor,JSON.stringify({message:'No remaining archived graded props.',reconstruction_version:'archive-reconstruction-v1.1'}),runId).run();
      return json({ok:true,archive_reconstruction_run_id:runId,candidates_seen:0,rows_inserted:0,cursor_end_archive_prop_id:cursor,done:true});
    }

    const pitcher=await env.DB.prepare(`
      SELECT DISTINCT p.pitcher_id,p.throws_hand
      FROM pitchers p LEFT JOIN pitcher_aliases pa ON pa.pitcher_id=p.pitcher_id
      WHERE lower(p.canonical_name)=lower(?) OR lower(pa.alias_name)=lower(?)
      LIMIT 1
    `).bind(candidate.pitcher_name,candidate.pitcher_name).first<{pitcher_id:number;throws_hand:string|null}>();
    const opponentAbbr=normalizedMlbTeamAbbreviation(candidate.opponent_abbreviation);
    const opponent=await env.DB.prepare(`SELECT team_id FROM teams WHERE upper(abbreviation)=upper(?) LIMIT 1`).bind(opponentAbbr).first<{team_id:number}>();
    const pitcherId=pitcher?.pitcher_id??null;
    const opponentTeamId=opponent?.team_id??null;
    const hand=String(candidate.pitcher_hand??pitcher?.throws_hand??'').toUpperCase();
    const mlbTeamId=MLB_TEAM_IDS[opponentAbbr]??0;
    const cutoff=`${candidate.board_date}T00:00:00Z`;
    const missing:string[]=[];
    if(!pitcherId)missing.push('pitcher_mapping_missing');
    if(!opponentTeamId)missing.push('opponent_team_mapping_missing');
    if(!mlbTeamId)missing.push('opponent_mlb_team_mapping_missing');
    if(hand!=='L'&&hand!=='R')missing.push('pitcher_hand_missing');

    let starts:ReconstructionStart[]=[];
    let l3avg:number|null=null,l5avg:number|null=null,l10avg:number|null=null,kbf:number|null=null,avgBf:number|null=null,avgIp:number|null=null,avgPc:number|null=null,formDelta:number|null=null,baseline:number|null=null;
    if(pitcherId){
      const sr=await env.DB.prepare(`SELECT game_date,COALESCE(strikeouts,0) strikeouts,COALESCE(batters_faced,0) batters_faced,COALESCE(innings_pitched,0) innings_pitched,COALESCE(pitch_count,0) pitch_count,COALESCE(starter,1) starter FROM pitcher_game_stats WHERE pitcher_id=? AND starter=1 AND game_date<? ORDER BY game_date DESC LIMIT 40`).bind(pitcherId,candidate.board_date).all<ReconstructionStart>();
      starts=sr.results??[];
      const mean=(rows:ReconstructionStart[],key:keyof ReconstructionStart)=>rows.length?rows.reduce((n,x)=>n+Number(x[key]??0),0)/rows.length:null;
      const l3=starts.slice(0,3),l5=starts.slice(0,5),l10=starts.slice(0,10);
      l3avg=mean(l3,'strikeouts');l5avg=mean(l5,'strikeouts');l10avg=mean(l10,'strikeouts');
      const totalKs=l5.reduce((n,x)=>n+Number(x.strikeouts??0),0),totalBf=l5.reduce((n,x)=>n+Number(x.batters_faced??0),0);
      kbf=totalBf>0?totalKs/totalBf:null;avgBf=mean(l5,'batters_faced');avgIp=mean(l5,'innings_pitched');avgPc=mean(l5,'pitch_count');
      formDelta=l3avg!==null&&l10avg!==null?l3avg-l10avg:null;
      baseline=kbf!==null&&avgBf!==null?kbf*avgBf:null;
    }
    if(starts.length<3)missing.push('fewer_than_3_prior_starts');
    if(baseline===null)missing.push('baseline_projection_unavailable');

    let pa7=0,k7=0,r7:number|null=null,pa14=0,k14=0,r14:number|null=null,pa30=0,k30=0,r30:number|null=null;
    let weighted:number|null=null,confidence='NONE',gamesChecked=0,gamesFetched=0;
    if(mlbTeamId&&(hand==='L'||hand==='R')){
      const endDate=isoDateDaysBefore(candidate.board_date,1);
      const start7=isoDateDaysBefore(candidate.board_date,7),start14=isoDateDaysBefore(candidate.board_date,14),start30=isoDateDaysBefore(candidate.board_date,30);
      const sync=await env.DB.prepare(`INSERT INTO sync_runs(run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end,details_json) VALUES (?,'MLB_STATS_API','ARCHIVE_HISTORICAL_RECONSTRUCTION','BACKFILL','ADMIN','RUNNING',?,?,?)`)
        .bind(crypto.randomUUID(),String(candidate.historical_archive_prop_id),String(candidate.historical_archive_prop_id),JSON.stringify({archive_prop_id:candidate.historical_archive_prop_id,board_date:candidate.board_date,team:opponentAbbr,pitcher_hand:hand})).run();
      const syncRunId=Number(sync.meta.last_row_id);
      const games=await fetchTeamRecentScheduleGames(mlbTeamId,start30,endDate);gamesChecked=games.length;
      const skippedGames:Array<{gamePk:number;reason:string}>=[];
      for(const game of games){
        const cached=await env.DB.prepare(`SELECT mlb_game_pk FROM team_game_handedness_games WHERE mlb_game_pk=?`).bind(game.gamePk).first<{mlb_game_pk:number}>();
        if(!cached){
          try{
            await cacheGameHandednessBatting(env,game,syncRunId);
            gamesFetched++;
          }catch(gameError){
            const reason=gameError instanceof Error?gameError.message:String(gameError);
            if(reason.includes('no usable plate appearances')){
              skippedGames.push({gamePk:game.gamePk,reason});
              continue;
            }
            throw gameError;
          }
        }
      }
      const w7=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start7,endDate),w14=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start14,endDate),w30=await getRecentTeamHandSplit(env,mlbTeamId,hand as 'L'|'R',start30,endDate);
      pa7=w7.plateAppearances;k7=w7.strikeouts;r7=pa7>0?w7.strikeoutRate:null;pa14=w14.plateAppearances;k14=w14.strikeouts;r14=pa14>0?w14.strikeoutRate:null;pa30=w30.plateAppearances;k30=w30.strikeouts;r30=pa30>0?w30.strikeoutRate:null;
      weighted=weightedHistoricalOpponentRate({r7,p7:pa7,r14,p14:pa14,r30,p30:pa30});
      confidence=pa30>=180&&pa14>=80?'HIGH':pa30>=100&&pa14>=45?'MEDIUM':pa30>=50?'LOW':'INSUFFICIENT';
      await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,rows_rejected=?,request_count=?,details_json=? WHERE sync_run_id=?`).bind(skippedGames.length?'PARTIAL':'SUCCEEDED',gamesChecked,gamesFetched,skippedGames.length,1+gamesFetched+skippedGames.length,JSON.stringify({archive_prop_id:candidate.historical_archive_prop_id,start_date:start30,end_date:endDate,skipped_games:skippedGames}),syncRunId).run();
    }
    if(pa30<50)missing.push('opponent_30d_sample_too_small');
    if(pa14<25)missing.push('opponent_14d_sample_too_small');
    if(weighted===null)missing.push('opponent_weighted_k_rate_missing');

    const multiplier=weighted===null?null:clamp(1+(weighted-LEAGUE_BASELINE_K_RATE)*2.0,.88,1.12);
    const projection=baseline===null?null:baseline*(multiplier??1);
    const edge=projection===null?null:projection-Number(candidate.prop_line);
    const sd=standardDeviation(starts.slice(0,5).map(x=>Number(x.strikeouts)))??1.5;
    const overProb=edge===null?null:estimateOverRate(edge,sd);
    const preferred=edge===null?null:edge>=0?'More':'Less';
    let score=100;
    if(starts.length<10)score-=10;if(starts.length<5)score-=10;if(confidence==='MEDIUM')score-=8;else if(confidence==='LOW')score-=18;else if(confidence==='INSUFFICIENT'||confidence==='NONE')score-=30;
    if(!pitcherId)score-=30;if(!opponentTeamId||!mlbTeamId)score-=20;if(hand!=='L'&&hand!=='R')score-=20;score=Math.max(0,Math.min(100,score));
    const hard=!pitcherId||starts.length<3||baseline===null||!opponentTeamId||!mlbTeamId||(hand!=='L'&&hand!=='R')||weighted===null||pa30<50;
    const status=hard?'INCOMPLETE':'RESEARCH_READY';
    const evidence={archive_only:true,legacy_snapshots_used:false,legacy_recommendations_used:false,native_snapshots_modified:false,pitcher_rule:'pitcher_game_stats.game_date < board_date',opponent_rule:'official MLB game date < board_date',information_cutoff_at:cutoff,games_checked:gamesChecked,games_fetched:gamesFetched};
    const features={pitcher:{prior_start_count:starts.length,last_start_date:starts[0]?.game_date??null,last3_k_avg:l3avg,last5_k_avg:l5avg,last10_k_avg:l10avg,last5_k_per_bf:kbf,last5_avg_bf:avgBf,last5_avg_ip:avgIp,last5_avg_pitch_count:avgPc,form_delta_l3_l10:formDelta,baseline_projection:baseline},opponent:{team:opponentAbbr,pitcher_hand:hand,window_7:{pa:pa7,k:k7,k_rate:r7},window_14:{pa:pa14,k:k14,k_rate:r14},window_30:{pa:pa30,k:k30,k_rate:r30},weighted_recent_k_rate:weighted,sample_confidence:confidence,matchup_multiplier:multiplier},projection:{value:projection,edge,over_probability:overProb,preferred_side:preferred}};
    await env.DB.prepare(`INSERT INTO archive_historical_reconstructions(archive_reconstruction_run_id,reconstruction_version,historical_archive_prop_id,board_date,information_cutoff_at,pitcher_id,opponent_team_id,opponent_mlb_team_id,pitcher_hand,prop_line,prior_start_count,last_start_date,last3_k_avg,last5_k_avg,last10_k_avg,last5_k_per_bf,last5_avg_bf,last5_avg_ip,last5_avg_pitch_count,form_delta_l3_l10,baseline_projection,window_7_pa,window_7_k,window_7_k_rate,window_14_pa,window_14_k,window_14_k_rate,window_30_pa,window_30_k,window_30_k_rate,weighted_recent_k_rate,sample_confidence,matchup_multiplier,reconstructed_projection,reconstructed_edge,reconstructed_over_probability,reconstructed_preferred_side,reconstruction_status,reconstruction_score,missing_features_json,evidence_json,feature_json,actual_strikeouts,market_result) VALUES (?,'archive-reconstruction-v1.1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(runId,candidate.historical_archive_prop_id,candidate.board_date,cutoff,pitcherId,opponentTeamId,mlbTeamId||null,hand||null,candidate.prop_line,starts.length,starts[0]?.game_date??null,l3avg,l5avg,l10avg,kbf,avgBf,avgIp,avgPc,formDelta,baseline,pa7,k7,r7,pa14,k14,r14,pa30,k30,r30,weighted,confidence,multiplier,projection,edge,overProb,preferred,status,score,JSON.stringify(missing),JSON.stringify(evidence),JSON.stringify(features),candidate.actual_strikeouts,candidate.market_result).run();
    await env.DB.prepare(`UPDATE archive_historical_reconstruction_runs SET status=?,completed_at=CURRENT_TIMESTAMP,cursor_end_archive_prop_id=?,candidates_seen=1,rows_inserted=1,research_ready_count=?,incomplete_count=?,games_checked=?,games_fetched=?,details_json=? WHERE archive_reconstruction_run_id=?`)
      .bind(status==='RESEARCH_READY'?'SUCCEEDED':'PARTIAL',candidate.historical_archive_prop_id,status==='RESEARCH_READY'?1:0,status==='INCOMPLETE'?1:0,gamesChecked,gamesFetched,JSON.stringify({archive_prop_id:candidate.historical_archive_prop_id,reconstruction_version:'archive-reconstruction-v1.1',score,status}),runId).run();
    return json({ok:true,archive_reconstruction_run_id:runId,candidates_seen:1,rows_inserted:1,research_ready:status==='RESEARCH_READY'?1:0,incomplete:status==='INCOMPLETE'?1:0,cursor_end_archive_prop_id:candidate.historical_archive_prop_id,games_checked:gamesChecked,games_fetched:gamesFetched,status,score});
  }catch(error){
    await env.DB.prepare(`UPDATE archive_historical_reconstruction_runs SET status='FAILED',completed_at=CURRENT_TIMESTAMP,details_json=? WHERE archive_reconstruction_run_id=?`).bind(JSON.stringify({error:String(error)}),runId).run();
    throw error;
  }
}

async function getArchiveHistoricalReconstructionStatus(env:Env):Promise<Response>{
  const latest=await env.DB.prepare(`SELECT * FROM archive_historical_reconstruction_runs ORDER BY archive_reconstruction_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const runs=await env.DB.prepare(`SELECT * FROM archive_historical_reconstruction_runs ORDER BY archive_reconstruction_run_id DESC LIMIT 20`).all<Record<string,unknown>>();
  const rows=await env.DB.prepare(`WITH x AS(SELECT r.*,ROW_NUMBER() OVER(PARTITION BY historical_archive_prop_id ORDER BY archive_historical_reconstruction_id DESC) rn FROM archive_historical_reconstructions r) SELECT x.*,a.pitcher_name,a.opponent_abbreviation FROM x JOIN historical_archive_props a ON a.historical_archive_prop_id=x.historical_archive_prop_id WHERE rn=1 ORDER BY archive_historical_reconstruction_id DESC LIMIT 100`).all<Record<string,unknown>>();
  const summary=await env.DB.prepare(`WITH x AS(SELECT r.*,ROW_NUMBER() OVER(PARTITION BY historical_archive_prop_id ORDER BY archive_historical_reconstruction_id DESC) rn FROM archive_historical_reconstructions r) SELECT COUNT(*) total,SUM(CASE WHEN reconstruction_status='RESEARCH_READY' THEN 1 ELSE 0 END) research_ready,SUM(CASE WHEN reconstruction_status='INCOMPLETE' THEN 1 ELSE 0 END) incomplete,ROUND(AVG(reconstruction_score),1) avg_score,COUNT(DISTINCT board_date) distinct_dates,MIN(board_date) board_date_min,MAX(board_date) board_date_max FROM x WHERE rn=1`).first<Record<string,unknown>>();
  const remaining=await env.DB.prepare(`SELECT COUNT(*) remaining FROM historical_archive_props a WHERE eligible_for_reconstruction=1 AND market_result IN ('Over','Under','Push') AND actual_strikeouts IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archive_historical_reconstructions r WHERE r.historical_archive_prop_id=a.historical_archive_prop_id)`).first<Record<string,unknown>>();
  return json({latest_run:latest,runs:runs.results,rows:rows.results,summary,remaining,native_snapshots_modified:false});
}

async function getHistoricalArchiveIntakeStatus(env:Env):Promise<Response>{
  const summary=await env.DB.prepare(`
    SELECT COUNT(*) total_rows,
           COUNT(DISTINCT board_date) distinct_dates,
           SUM(CASE WHEN market_result='Void' THEN 1 ELSE 0 END) void_rows,
           SUM(CASE WHEN market_result IN ('Over','Under','Push') AND actual_strikeouts IS NOT NULL THEN 1 ELSE 0 END) graded_rows,
           MIN(board_date) board_date_min,
           MAX(board_date) board_date_max
    FROM historical_archive_props
  `).first<Record<string,unknown>>();
  const dates=await env.DB.prepare(`
    SELECT board_date,
           COUNT(*) rows,
           SUM(CASE WHEN market_result='Over' THEN 1 ELSE 0 END) overs,
           SUM(CASE WHEN market_result='Under' THEN 1 ELSE 0 END) unders,
           SUM(CASE WHEN market_result='Push' THEN 1 ELSE 0 END) pushes,
           SUM(CASE WHEN market_result='Void' THEN 1 ELSE 0 END) voids,
           COUNT(DISTINCT source_workbook) source_files
    FROM historical_archive_props
    GROUP BY board_date
    ORDER BY board_date
  `).all<Record<string,unknown>>();
  const sources=await env.DB.prepare(`
    SELECT source_workbook,COUNT(*) rows,MIN(board_date) board_date_min,MAX(board_date) board_date_max
    FROM historical_archive_props
    GROUP BY source_workbook
    ORDER BY board_date_min,source_workbook
  `).all<Record<string,unknown>>();
  return json({archive_version:'historical-archive-v1',summary,dates:dates.results,sources:sources.results,native_snapshots_modified:false,native_props_modified:false});
}


type SegmentDatasetRow={
  backtest_dataset_row_id:number; board_date:string; source_provenance:string; pitcher_hand:string|null; prop_line:number;
  preferred_side:string|null; preferred_outcome:string|null; model_edge:number|null; confidence_score:number|null;
  raw_more_probability:number|null; raw_less_probability:number|null; calibrated_more_probability:number|null; calibrated_less_probability:number|null;
};

function segmentProbability(row:SegmentDatasetRow):number|null{
  const side=String(row.preferred_side??'').toUpperCase();
  const v=side==='MORE'?(row.calibrated_more_probability??row.raw_more_probability):side==='LESS'?(row.calibrated_less_probability??row.raw_less_probability):null;
  return v==null||!Number.isFinite(Number(v))?null:Math.max(0,Math.min(1,Number(v)));
}
function segmentStats(rows:SegmentDatasetRow[]){
  let w=0,l=0,push=0,brier=0,bn=0,psum=0,pn=0;
  for(const r of rows){
    const o=String(r.preferred_outcome??'').toUpperCase();
    if(o==='WIN')w++; else if(o==='LOSS')l++; else if(o==='PUSH')push++;
    const p=segmentProbability(r); if(p!=null){psum+=p;pn++; if(o==='WIN'||o==='LOSS'){const y=o==='WIN'?1:0;brier+=(p-y)*(p-y);bn++;}}
  }
  const n=w+l;
  const hit=n?w/n:null, avg=pn?psum/pn:null;
  return {rows:rows.length,graded:n,wins:w,losses:l,pushes:push,hit_rate:hit,avg_probability:avg,calibration_gap:hit!=null&&avg!=null?avg-hit:null,brier:bn?brier/bn:null};
}
function edgeBucket(v:number|null){const x=Math.abs(Number(v??0));return x<0.25?'<0.25':x<0.5?'0.25–0.49':x<0.75?'0.50–0.74':x<1?'0.75–0.99':x<1.5?'1.00–1.49':'1.50+';}
function lineBucket(v:number){return v<4?'<4':v<5?'4–4.5':v<6?'5–5.5':v<7?'6–6.5':v<8?'7–7.5':'8+';}
function confidenceBucket(v:number|null){const x=Number(v??0);return x<60?'<60':x<70?'60–69':x<80?'70–79':x<90?'80–89':'90+';}
function monthBucket(d:string){return String(d).slice(0,7);}
function addSegment(groups:Map<string,SegmentDatasetRow[]>,key:string,row:SegmentDatasetRow){const a=groups.get(key)??[];a.push(row);groups.set(key,a);}

async function getBacktestSegmentStatus(env:Env,url:URL):Promise<Response>{
  const runParam=Number(url.searchParams.get('backtest_run_id')??0);
  const run=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=? AND status IN ('SUCCEEDED','PARTIAL')`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs WHERE status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  if(!run)return json({run:null,summary:{},segments:[]});
  const runId=Number(run.backtest_run_id); const useV3=String(run.engine_version??'')==='walk-forward-v2';
  const rowsResult=useV3
    ? await env.DB.prepare(`SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,r.source_provenance,r.pitcher_hand,r.prop_line,r.preferred_side,r.preferred_outcome,r.model_edge,r.confidence_score,r.raw_more_probability,r.raw_less_probability,r.calibrated_more_probability,r.calibrated_less_probability FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' ORDER BY r.board_date,r.backtest_dataset_row_id`).bind(runId).all<SegmentDatasetRow>()
    : await env.DB.prepare(`SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,'NATIVE' source_provenance,r.pitcher_hand,r.prop_line,r.preferred_side,r.preferred_outcome,r.model_edge,r.confidence_score,r.raw_more_probability,r.raw_less_probability,r.calibrated_more_probability,r.calibrated_less_probability FROM backtest_folds f JOIN backtest_fold_rows fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' ORDER BY r.board_date,r.backtest_dataset_row_id`).bind(runId).all<SegmentDatasetRow>();
  const rows=rowsResult.results??[]; const groups=new Map<string,SegmentDatasetRow[]>();
  for(const r of rows){
    addSegment(groups,`Side|${String(r.preferred_side??'NONE').toUpperCase()}`,r);
    addSegment(groups,`Absolute edge|${edgeBucket(r.model_edge)}`,r);
    addSegment(groups,`Prop line|${lineBucket(Number(r.prop_line))}`,r);
    addSegment(groups,`Provenance|${r.source_provenance||'UNKNOWN'}`,r);
    addSegment(groups,`Confidence score|${confidenceBucket(r.confidence_score)}`,r);
    addSegment(groups,`Pitcher hand|${String(r.pitcher_hand??'UNKNOWN').toUpperCase()}`,r);
    addSegment(groups,`Calendar month|${monthBucket(r.board_date)}`,r);
    addSegment(groups,`Side × edge|${String(r.preferred_side??'NONE').toUpperCase()} · ${edgeBucket(r.model_edge)}`,r);
    addSegment(groups,`Provenance × side|${r.source_provenance||'UNKNOWN'} · ${String(r.preferred_side??'NONE').toUpperCase()}`,r);
  }
  const segments=[...groups.entries()].map(([k,rs])=>{const [dimension,...rest]=k.split('|');const st=segmentStats(rs);const reliable=st.graded>=50?'STRONG_SAMPLE':st.graded>=25?'MODERATE_SAMPLE':'SMALL_SAMPLE';return {dimension,bucket:rest.join('|'),...st,sample_flag:reliable};}).sort((a,b)=>a.dimension.localeCompare(b.dimension)||b.graded-a.graded||a.bucket.localeCompare(b.bucket));
  const overall=segmentStats(rows);
  return json({run,summary:{...overall,distinct_dates:new Set(rows.map(r=>String(r.board_date).slice(0,10))).size,segment_count:segments.length,analysis_version:'segment-analysis-v1',test_rows_only:true},segments});
}



type ComparisonDatasetRow = {
  backtest_dataset_row_id:number; board_date:string; preferred_side:string|null; preferred_outcome:string|null;
  model_decision:string|null; raw_more_probability:number|null; raw_less_probability:number|null;
  calibrated_more_probability:number|null; calibrated_less_probability:number|null; model_edge:number|null;
  prop_line:number; pitcher_hand:string|null;
};

type ReplayPoint = {
  row_id:number; board_date:string; side:"MORE"|"LESS"; outcome:string; edge:number|null;
  v13_probability:number; v14_probability:number; v13_decision:string; v14_decision:string;
  v14_adaptive_probability:number; v14_adaptive_decision:string; adaptive_evidence_count:number; adaptive_selection_score:number;
  training_rows:number; fallback_level:string;
};

function preferredRawProbability(row:ComparisonDatasetRow, side:"MORE"|"LESS"):number{
  const v=side==='MORE'?(row.raw_more_probability??row.calibrated_more_probability):(row.raw_less_probability??row.calibrated_less_probability);
  return clamp(Number(v??0.5),0.5,0.999999);
}
function preferredDisplayProbability(row:ComparisonDatasetRow, side:"MORE"|"LESS"):number{
  const v=side==='MORE'?(row.calibrated_more_probability??row.raw_more_probability):(row.calibrated_less_probability??row.raw_less_probability);
  return clamp(Number(v??0.5),0.5,0.999999);
}
function replayV14Calibration(allRows:ComparisonDatasetRow[], target:ComparisonDatasetRow, side:"MORE"|"LESS"){
  const raw=preferredRawProbability(target,side);
  const prior=allRows.filter(r=>String(r.board_date)<String(target.board_date)&&String(r.preferred_side??'').toUpperCase()===side&&['WIN','LOSS'].includes(String(r.preferred_outcome??'').toUpperCase()));
  for(const attempt of [{width:0.05,fallback:'NARROW_BUCKET'},{width:0.10,fallback:'WIDE_BUCKET'}]){
    const low=Math.max(0.5,Math.floor(raw/attempt.width)*attempt.width), high=Math.min(1.000001,low+attempt.width);
    const bucket=prior.filter(r=>{const p=preferredRawProbability(r,side);return p>=low&&p<high;});
    if(bucket.length>=40){
      const wins=bucket.filter(r=>String(r.preferred_outcome).toUpperCase()==='WIN').length;
      return {probability:clamp((wins+10)/(bucket.length+20),0.50,0.70),training_rows:bucket.length,fallback_level:attempt.fallback};
    }
  }
  if(prior.length>=40){
    const wins=prior.filter(r=>String(r.preferred_outcome).toUpperCase()==='WIN').length;
    return {probability:clamp((wins+20)/(prior.length+40),0.50,0.62),training_rows:prior.length,fallback_level:'SIDE_POOL'};
  }
  return {probability:0.52,training_rows:0,fallback_level:'CONSERVATIVE_PRIOR'};
}
function comparisonStats(points:ReplayPoint[], which:'v13'|'v14'|'adaptive', playOnly=false){
  const rows=playOnly?points.filter(p=>(which==='v13'?p.v13_decision:which==='v14'?p.v14_decision:p.v14_adaptive_decision)==='PLAY'):points;
  let wins=0,losses=0,brier=0,n=0,psum=0;
  for(const p of rows){
    const o=String(p.outcome).toUpperCase(); if(o!=='WIN'&&o!=='LOSS')continue;
    const prob=which==='v13'?p.v13_probability:which==='v14'?p.v14_probability:p.v14_adaptive_probability;
    const y=o==='WIN'?1:0; wins+=y; losses+=1-y; brier+=(prob-y)*(prob-y); psum+=prob; n++;
  }
  const hit=n?wins/n:null, avg=n?psum/n:null;
  let bankroll=0,peak=0,maxDrawdown=0,losing=0,longestLosingStreak=0;
  const ordered=[...rows].sort((a,b)=>a.board_date.localeCompare(b.board_date)||a.row_id-b.row_id);
  for(const p of ordered){
    const o=String(p.outcome).toUpperCase(); if(o!=='WIN'&&o!=='LOSS')continue;
    bankroll += o==='WIN'?1:-1; peak=Math.max(peak,bankroll); maxDrawdown=Math.max(maxDrawdown,peak-bankroll);
    if(o==='LOSS'){losing++;longestLosingStreak=Math.max(longestLosingStreak,losing);}else losing=0;
  }
  const dates=new Set(rows.map(p=>String(p.board_date).slice(0,10))).size;
  return {rows:n,wins,losses,hit_rate:hit,brier:n?brier/n:null,avg_probability:avg,calibration_gap:hit!=null&&avg!=null?avg-hit:null,distinct_dates:dates,plays_per_day:dates?n/dates:null,max_drawdown:maxDrawdown,longest_losing_streak:longestLosingStreak};
}

async function getModelComparison(env:Env,url:URL):Promise<Response>{
  const runParam=Number(url.searchParams.get('backtest_run_id')??0);
  const run=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=? AND status IN ('SUCCEEDED','PARTIAL')`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  let historical:any={run:null,summary:{},by_side:[],by_edge:[],recent:[]};
  if(run){
    const runId=Number(run.backtest_run_id), buildId=Number(run.backtest_dataset_build_id);
    const all=(await env.DB.prepare(`SELECT backtest_dataset_row_id,board_date,preferred_side,preferred_outcome,model_decision,raw_more_probability,raw_less_probability,calibrated_more_probability,calibrated_less_probability,model_edge,prop_line,pitcher_hand FROM backtest_dataset_rows_v3 WHERE backtest_dataset_build_id=? AND backtest_eligible=1 ORDER BY board_date,backtest_dataset_row_id`).bind(buildId).all<ComparisonDatasetRow>()).results??[];
    const tests=(await env.DB.prepare(`SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,r.preferred_side,r.preferred_outcome,r.model_decision,r.raw_more_probability,r.raw_less_probability,r.calibrated_more_probability,r.calibrated_less_probability,r.model_edge,r.prop_line,r.pitcher_hand FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' ORDER BY r.board_date,r.backtest_dataset_row_id`).bind(runId).all<ComparisonDatasetRow>()).results??[];
    const points:ReplayPoint[]=[];
    for(const r of tests){
      const side=String(r.preferred_side??'').toUpperCase(); if(side!=='MORE'&&side!=='LESS')continue;
      const outcome=String(r.preferred_outcome??'').toUpperCase(); if(outcome!=='WIN'&&outcome!=='LOSS')continue;
      const cal=replayV14Calibration(all,r,side as 'MORE'|'LESS');
      const prior=all.filter(x=>String(x.board_date)<String(r.board_date)) as V14AdaptiveHistoryRow[];
      const adaptive=calculateV14AdaptiveSelection(prior,{preferred_side:side,model_edge:r.model_edge,prop_line:Number(r.prop_line),pitcher_hand:r.pitcher_hand},cal.probability);
      points.push({row_id:Number(r.backtest_dataset_row_id),board_date:String(r.board_date),side:side as 'MORE'|'LESS',outcome,edge:r.model_edge==null?null:Number(r.model_edge),v13_probability:preferredDisplayProbability(r,side as 'MORE'|'LESS'),v14_probability:cal.probability,v13_decision:String(r.model_decision??'PLAY').toUpperCase(),v14_decision:cal.probability>=0.54?'PLAY':'WATCH',v14_adaptive_probability:adaptive.adaptive_probability,v14_adaptive_decision:adaptive.decision,adaptive_evidence_count:adaptive.evidence_count,adaptive_selection_score:adaptive.selection_score,training_rows:cal.training_rows,fallback_level:cal.fallback_level});
    }
    const v13=comparisonStats(points,'v13'), v14=comparisonStats(points,'v14'), v13play=comparisonStats(points,'v13',true), v14play=comparisonStats(points,'v14',true), adaptive=comparisonStats(points,'adaptive'), adaptivePlay=comparisonStats(points,'adaptive',true);
    const sideRows=['MORE','LESS'].map(side=>({side,v13:comparisonStats(points.filter(p=>p.side===side),'v13'),v14:comparisonStats(points.filter(p=>p.side===side),'v14'),v14_play:comparisonStats(points.filter(p=>p.side===side),'v14',true),adaptive:comparisonStats(points.filter(p=>p.side===side),'adaptive'),adaptive_play:comparisonStats(points.filter(p=>p.side===side),'adaptive',true)}));
    const bucket=(v:number|null)=>edgeBucket(v);
    const edgeNames=['<0.25','0.25–0.49','0.50–0.74','0.75–0.99','1.00–1.49','1.50+'];
    const edgeRows=edgeNames.map(edge=>{const ps=points.filter(p=>bucket(p.edge)===edge);return {edge,v13:comparisonStats(ps,'v13'),v14:comparisonStats(ps,'v14'),v14_play:comparisonStats(ps,'v14',true),adaptive:comparisonStats(ps,'adaptive'),adaptive_play:comparisonStats(ps,'adaptive',true)};}).filter(x=>x.v13.rows>0);
    const monthNames=[...new Set(points.map(p=>String(p.board_date).slice(0,7)))].sort();
    const monthRows=monthNames.map(month=>{const ps=points.filter(p=>String(p.board_date).startsWith(month));return {month,adaptive_play:comparisonStats(ps,'adaptive',true),v14_play:comparisonStats(ps,'v14',true),all:comparisonStats(ps,'adaptive')};});
    const fallbackCounts:Record<string,number>={}; for(const p of points)fallbackCounts[p.fallback_level]=(fallbackCounts[p.fallback_level]??0)+1;
    historical={run,summary:{paired_rows:points.length,v13,v14,v13_play:v13play,v14_play:v14play,adaptive,adaptive_play:adaptivePlay,brier_improvement:v13.brier!=null&&v14.brier!=null?v13.brier-v14.brier:null,adaptive_brier_improvement:v13.brier!=null&&adaptive.brier!=null?v13.brier-adaptive.brier:null,calibration_gap_improvement:v13.calibration_gap!=null&&v14.calibration_gap!=null?Math.abs(v13.calibration_gap)-Math.abs(v14.calibration_gap):null,decision_agreement_rate:points.length?points.filter(p=>p.v13_decision===p.v14_decision).length/points.length:null,v14_play_rate:points.length?v14play.rows/points.length:null,adaptive_play_rate:points.length?adaptivePlay.rows/points.length:null,fallback_counts:fallbackCounts,replay_version:'v14-adaptive-replay-v1',anti_lookahead:'all calibration and segment evidence use board_date strictly before target'},by_side:sideRows,by_edge:edgeRows,by_month:monthRows,recent:points.slice(-100).reverse()};
  }

  const prod=await env.DB.prepare(`SELECT model_version_id,version_name FROM model_versions WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE' ORDER BY model_version_id DESC LIMIT 1`).first<{model_version_id:number;version_name:string}>();
  const chal=await env.DB.prepare(`SELECT model_version_id,version_name FROM model_versions WHERE version_name='v14-baseline-challenger' LIMIT 1`).first<{model_version_id:number;version_name:string}>();
  let liveRows:Record<string,unknown>[]=[];
  if(prod&&chal){
    liveRows=(await env.DB.prepare(`
      SELECT p.prop_id,b.board_date,pi.canonical_name pitcher,p.strikeout_line,pr.result,
        p13.preferred_side v13_side,p13.decision v13_decision,
        CASE WHEN UPPER(p13.preferred_side)='MORE' THEN COALESCE(p13.calibrated_more_probability,p13.raw_more_probability) ELSE COALESCE(p13.calibrated_less_probability,p13.raw_less_probability) END v13_probability,
        p14.preferred_side v14_side,p14.decision v14_decision,
        CASE WHEN UPPER(p14.preferred_side)='MORE' THEN COALESCE(p14.calibrated_more_probability,p14.raw_more_probability) ELSE COALESCE(p14.calibrated_less_probability,p14.raw_less_probability) END v14_probability,
        p13.predicted_at v13_predicted_at,p14.predicted_at v14_predicted_at
      FROM props p JOIN boards b ON b.board_id=p.board_id JOIN pitchers pi ON pi.pitcher_id=p.pitcher_id
      JOIN model_predictions p13 ON p13.model_prediction_id=(SELECT x.model_prediction_id FROM model_predictions x WHERE x.prop_id=p.prop_id AND x.model_version_id=? AND x.prediction_mode='PRODUCTION' AND x.prediction_status='COMPLETE' ORDER BY x.model_prediction_id DESC LIMIT 1)
      JOIN model_predictions p14 ON p14.model_prediction_id=(SELECT x.model_prediction_id FROM model_predictions x WHERE x.prop_id=p.prop_id AND x.model_version_id=? AND x.prediction_mode='SHADOW' AND x.prediction_status='COMPLETE' ORDER BY x.model_prediction_id DESC LIMIT 1)
      LEFT JOIN prop_results pr ON pr.prop_id=p.prop_id AND pr.result_status<>'PENDING'
      ORDER BY b.board_date DESC,p.prop_id DESC LIMIT 250
    `).bind(Number(prod.model_version_id),Number(chal.model_version_id)).all<Record<string,unknown>>()).results??[];
  }
  const liveGraded=liveRows.filter(r=>['OVER','UNDER'].includes(String(r.result??'').toUpperCase()));
  function liveStats(which:'v13'|'v14'){
    let w=0,l=0,b=0,ps=0,n=0;for(const r of liveGraded){const side=String(r[`${which}_side`]??'').toUpperCase(),res=String(r.result).toUpperCase();if(side!=='MORE'&&side!=='LESS')continue;const y=(side==='MORE'&&res==='OVER')||(side==='LESS'&&res==='UNDER')?1:0;const prob=Number(r[`${which}_probability`]??0.5);w+=y;l+=1-y;b+=(prob-y)*(prob-y);ps+=prob;n++;}const hit=n?w/n:null,avg=n?ps/n:null;return {rows:n,wins:w,losses:l,hit_rate:hit,brier:n?b/n:null,avg_probability:avg,calibration_gap:hit!=null&&avg!=null?avg-hit:null};
  }
  const live={paired_predictions:liveRows.length,graded_pairs:liveGraded.length,v13:liveStats('v13'),v14:liveStats('v14'),rows:liveRows.slice(0,100),production_model:prod?.version_name??null,challenger_model:chal?.version_name??null};
  return json({historical,live,build:'5.4',comparison_version:'model-comparison-v2',live_challenger_policy:'v14-baseline-calibrated-v1',adaptive_policy_status:'REJECTED_RESEARCH_ONLY'});
}


type DiagnosticRow = {
  backtest_dataset_row_id:number; board_date:string; preferred_side:string|null; preferred_outcome:string|null;
  model_edge:number|null; prop_line:number; pitcher_hand:string|null; projected_strikeouts:number|null;
  actual_strikeouts:number|null; pitcher_features_json:string|null; team_features_json:string|null;
};

function safeJsonObject(raw:string|null):Record<string,unknown>{
  if(!raw)return {}; try{const v=JSON.parse(raw);return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};}catch{return {};}
}
function nestedNumber(obj:Record<string,unknown>, paths:string[][]):number|null{
  for(const path of paths){let cur:unknown=obj;for(const key of path){if(!cur||typeof cur!=='object'||Array.isArray(cur)){cur=null;break;}cur=(cur as Record<string,unknown>)[key];}
    const n=Number(cur); if(cur!==null&&cur!==undefined&&Number.isFinite(n))return n;
  } return null;
}
function diagnosticFeatureValue(r:DiagnosticRow,key:string):number|null{
  const p=safeJsonObject(r.pitcher_features_json), t=safeJsonObject(r.team_features_json);
  switch(key){
    case 'abs_edge': return Math.abs(Number(r.model_edge??0));
    case 'prop_line': return Number(r.prop_line);
    case 'projection_margin': return r.projected_strikeouts==null?null:Math.abs(Number(r.projected_strikeouts)-Number(r.prop_line));
    case 'prior_start_count': return nestedNumber(p,[['pitcher','prior_start_count'],['prior_start_count']]);
    case 'last3_k_avg': return nestedNumber(p,[['pitcher','last3_k_avg'],['last3_k_avg'],['l3_k_avg']]);
    case 'last5_k_avg': return nestedNumber(p,[['pitcher','last5_k_avg'],['last5_k_avg'],['l5_k_avg']]);
    case 'last10_k_avg': return nestedNumber(p,[['pitcher','last10_k_avg'],['last10_k_avg'],['l10_k_avg']]);
    case 'last5_k_per_bf': return nestedNumber(p,[['pitcher','last5_k_per_bf'],['last5_k_per_bf'],['k_per_bf']]);
    case 'last5_avg_bf': return nestedNumber(p,[['pitcher','last5_avg_bf'],['last5_avg_bf'],['avg_batters_faced']]);
    case 'last5_avg_ip': return nestedNumber(p,[['pitcher','last5_avg_ip'],['last5_avg_ip'],['avg_innings_pitched']]);
    case 'last5_avg_pitch_count': return nestedNumber(p,[['pitcher','last5_avg_pitch_count'],['last5_avg_pitch_count'],['avg_pitch_count']]);
    case 'form_delta_l3_l10': return nestedNumber(p,[['pitcher','form_delta_l3_l10'],['form_delta_l3_l10']]);
    case 'baseline_projection': return nestedNumber(p,[['pitcher','baseline_projection'],['baseline_projection']]);
    case 'opponent_k_rate_30': return nestedNumber(t,[['opponent','window_30','k_rate'],['window_30','k_rate'],['k_rate_30'],['weighted_recent_k_rate']]);
    case 'opponent_weighted_k_rate': return nestedNumber(t,[['opponent','weighted_recent_k_rate'],['weighted_recent_k_rate'],['opponent_k_rate']]);
    case 'matchup_multiplier': return nestedNumber(t,[['opponent','matchup_multiplier'],['matchup_multiplier']]);
    default:return null;
  }
}
function diagnosticMean(a:number[]):number|null{return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
function diagnosticFeatureSummary(rows:DiagnosticRow[],key:string,label:string){
  const vals=rows.map(r=>({r,v:diagnosticFeatureValue(r,key)})).filter(x=>x.v!=null) as Array<{r:DiagnosticRow,v:number}>;
  const wins=vals.filter(x=>String(x.r.preferred_outcome).toUpperCase()==='WIN').map(x=>x.v);
  const losses=vals.filter(x=>String(x.r.preferred_outcome).toUpperCase()==='LOSS').map(x=>x.v);
  const sorted=vals.map(x=>x.v).sort((a,b)=>a-b);
  const cut=(q:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))]:null;
  const q1=cut(.25),q2=cut(.5),q3=cut(.75);
  const bins=[
    {label:'Q1 low',test:(v:number)=>q1!=null&&v<=q1},
    {label:'Q2',test:(v:number)=>q1!=null&&q2!=null&&v>q1&&v<=q2},
    {label:'Q3',test:(v:number)=>q2!=null&&q3!=null&&v>q2&&v<=q3},
    {label:'Q4 high',test:(v:number)=>q3!=null&&v>q3},
  ].map(b=>{const xs=vals.filter(x=>b.test(x.v));const w=xs.filter(x=>String(x.r.preferred_outcome).toUpperCase()==='WIN').length,l=xs.filter(x=>String(x.r.preferred_outcome).toUpperCase()==='LOSS').length;return {bucket:b.label,n:w+l,wins:w,losses:l,hit_rate:w+l?w/(w+l):null,avg_value:diagnosticMean(xs.map(x=>x.v))};});
  const wa=diagnosticMean(wins),la=diagnosticMean(losses);
  return {key,label,n:vals.length,winner_avg:wa,loser_avg:la,winner_minus_loser:wa!=null&&la!=null?wa-la:null,q1,q2,q3,bins};
}

async function getFeatureDiagnostics(env:Env,url:URL):Promise<Response>{
  const runParam=Number(url.searchParams.get('backtest_run_id')??0);
  const run=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=? AND engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL')`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  if(!run)return json({build:'5.4',run:null,rows:0,features:[],message:'No completed walk-forward-v2 run found.'});
  const runId=Number(run.backtest_run_id);
  const rows=(await env.DB.prepare(`
    SELECT DISTINCT r.backtest_dataset_row_id,r.board_date,r.preferred_side,r.preferred_outcome,r.model_edge,r.prop_line,r.pitcher_hand,
      r.projected_strikeouts,r.actual_strikeouts,r.pitcher_features_json,r.team_features_json
    FROM backtest_folds f
    JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST'
    JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id
    WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND r.preferred_outcome IN ('WIN','LOSS')
    ORDER BY r.board_date,r.backtest_dataset_row_id
  `).bind(runId).all<DiagnosticRow>()).results??[];
  const specs:[string,string][]=[
    ['abs_edge','Absolute model edge'],['projection_margin','Projection margin vs line'],['prop_line','Prop line'],
    ['prior_start_count','Prior starter sample'],['last3_k_avg','Last 3 K average'],['last5_k_avg','Last 5 K average'],['last10_k_avg','Last 10 K average'],
    ['last5_k_per_bf','Last 5 K per batter faced'],['last5_avg_bf','Last 5 batters faced'],['last5_avg_ip','Last 5 innings'],
    ['last5_avg_pitch_count','Last 5 pitch count'],['form_delta_l3_l10','L3 minus L10 form'],['baseline_projection','Pitcher baseline projection'],
    ['opponent_k_rate_30','Opponent 30-day K rate'],['opponent_weighted_k_rate','Opponent weighted K rate'],['matchup_multiplier','Opponent matchup multiplier']
  ];
  const features=specs.map(([k,l])=>diagnosticFeatureSummary(rows,k,l)).filter(x=>x.n>=20);
  const side=['MORE','LESS'].map(s=>{const x=rows.filter(r=>String(r.preferred_side).toUpperCase()===s);const w=x.filter(r=>String(r.preferred_outcome).toUpperCase()==='WIN').length,l=x.length-w;return {side:s,n:x.length,wins:w,losses:l,hit_rate:x.length?w/x.length:null};});
  const edgeNames=['<0.25','0.25–0.49','0.50–0.74','0.75–0.99','1.00–1.49','1.50+'];
  const edge=edgeNames.map(name=>{const x=rows.filter(r=>edgeBucket(r.model_edge)===name);const w=x.filter(r=>String(r.preferred_outcome).toUpperCase()==='WIN').length,l=x.length-w;return {edge:name,n:x.length,wins:w,losses:l,hit_rate:x.length?w/x.length:null};});
  const worst=[...features].filter(x=>x.winner_minus_loser!=null).sort((a,b)=>Math.abs(Number(b.winner_minus_loser))-Math.abs(Number(a.winner_minus_loser))).slice(0,8);
  return json({build:'5.4',diagnostic_version:'feature-diagnostics-v1',research_only:true,production_unchanged:true,challenger_runtime:'v14-baseline-calibrated-v1',rejected_policy:'v14-adaptive-selection-v1',run,rows:rows.length,side,edge,features,worst,notes:['Retrospective diagnostics only; no thresholds are promoted automatically.','Feature bins are descriptive quartiles across executed TEST rows and are not used to train the live challenger.']});
}


type LearnedChallengerRow = {
  backtest_dataset_row_id:number; board_date:string; preferred_side:string|null; preferred_outcome:string|null;
  more_outcome:string|null; less_outcome:string|null; raw_more_probability:number|null; calibrated_more_probability:number|null;
  projected_strikeouts:number|null; prop_line:number; pitcher_hand:string|null; model_edge:number|null;
  pitcher_features_json:string|null; team_features_json:string|null;
};

type LearnedModel = {
  feature_names:string[]; means:number[]; scales:number[]; weights:number[]; train_rows:number; iterations:number; lambda:number;
};

const learnedFeatureNames = [
  'raw_more_probability','signed_projection_margin','abs_projection_margin','signed_margin_curve','prop_line','pitcher_is_left',
  'last3_k_avg','last5_k_avg','last10_k_avg','form_delta_l3_l10','last5_k_per_bf','last5_avg_bf','last5_avg_ip',
  'last5_avg_pitch_count','prior_start_count','opponent_weighted_k_rate','opponent_k_rate_30','matchup_multiplier'
];

function learnedFeatureVector(r:LearnedChallengerRow):(number|null)[]{
  const p=safeJsonObject(r.pitcher_features_json), t=safeJsonObject(r.team_features_json);
  const margin=r.projected_strikeouts==null?null:Number(r.projected_strikeouts)-Number(r.prop_line);
  const raw=r.raw_more_probability==null?(r.calibrated_more_probability==null?null:Number(r.calibrated_more_probability)):Number(r.raw_more_probability);
  return [
    raw, margin, margin==null?null:Math.abs(margin), margin==null?null:margin*Math.abs(margin), Number(r.prop_line), String(r.pitcher_hand??'').toUpperCase()==='L'?1:0,
    nestedNumber(p,[['pitcher','last3_k_avg'],['last3_k_avg'],['l3_k_avg']]), nestedNumber(p,[['pitcher','last5_k_avg'],['last5_k_avg'],['l5_k_avg']]),
    nestedNumber(p,[['pitcher','last10_k_avg'],['last10_k_avg'],['l10_k_avg']]), nestedNumber(p,[['pitcher','form_delta_l3_l10'],['form_delta_l3_l10']]),
    nestedNumber(p,[['pitcher','last5_k_per_bf'],['last5_k_per_bf'],['k_per_bf']]), nestedNumber(p,[['pitcher','last5_avg_bf'],['last5_avg_bf'],['avg_batters_faced']]),
    nestedNumber(p,[['pitcher','last5_avg_ip'],['last5_avg_ip'],['avg_innings_pitched']]), nestedNumber(p,[['pitcher','last5_avg_pitch_count'],['last5_avg_pitch_count'],['avg_pitch_count']]),
    nestedNumber(p,[['pitcher','prior_start_count'],['prior_start_count']]), nestedNumber(t,[['opponent','weighted_recent_k_rate'],['weighted_recent_k_rate'],['opponent_k_rate']]),
    nestedNumber(t,[['opponent','window_30','k_rate'],['window_30','k_rate'],['k_rate_30'],['weighted_recent_k_rate']]), nestedNumber(t,[['opponent','matchup_multiplier'],['matchup_multiplier']])
  ];
}

function learnedSigmoid(z:number):number{const x=Math.max(-12,Math.min(12,z));return 1/(1+Math.exp(-x));}

function trainLearnedDirectional(rows:LearnedChallengerRow[]):LearnedModel|null{
  const usable=rows.filter(r=>['WIN','LOSS'].includes(String(r.more_outcome??'').toUpperCase()));
  if(usable.length<100)return null;
  const rawX=usable.map(learnedFeatureVector), d=learnedFeatureNames.length;
  const means=Array(d).fill(0), counts=Array(d).fill(0);
  for(const x of rawX)for(let j=0;j<d;j++)if(x[j]!=null&&Number.isFinite(Number(x[j]))){means[j]+=Number(x[j]);counts[j]++;}
  for(let j=0;j<d;j++)means[j]=counts[j]?means[j]/counts[j]:0;
  const scales=Array(d).fill(0);
  for(const x of rawX)for(let j=0;j<d;j++){const v=x[j]==null?means[j]:Number(x[j]);scales[j]+=(v-means[j])*(v-means[j]);}
  for(let j=0;j<d;j++){scales[j]=Math.sqrt(scales[j]/Math.max(1,usable.length-1));if(!Number.isFinite(scales[j])||scales[j]<1e-6)scales[j]=1;}
  const X=rawX.map(x=>[1,...x.map((v,j)=>((v==null?means[j]:Number(v))-means[j])/scales[j])]);
  const y=usable.map(r=>String(r.more_outcome).toUpperCase()==='WIN'?1:0);
  const w=Array(d+1).fill(0), lambda=0.35, lr=0.08, iterations=100;
  for(let it=0;it<iterations;it++){
    const g=Array(d+1).fill(0);
    for(let i=0;i<X.length;i++){let z=0;for(let j=0;j<w.length;j++)z+=w[j]*X[i][j];const e=learnedSigmoid(z)-y[i];for(let j=0;j<w.length;j++)g[j]+=e*X[i][j];}
    for(let j=0;j<w.length;j++){g[j]/=X.length;if(j>0)g[j]+=lambda*w[j]/X.length;w[j]-=lr*g[j];}
  }
  return {feature_names:learnedFeatureNames,means,scales,weights:w,train_rows:usable.length,iterations,lambda};
}

function predictLearnedDirectional(model:LearnedModel,r:LearnedChallengerRow):number{
  const raw=learnedFeatureVector(r);let z=model.weights[0];
  for(let j=0;j<raw.length;j++){const v=raw[j]==null?model.means[j]:Number(raw[j]);z+=model.weights[j+1]*((v-model.means[j])/model.scales[j]);}
  const learned=learnedSigmoid(z);
  // Keep the first learned challenger deliberately conservative until replay proves otherwise.
  return clamp(0.5+0.70*(learned-0.5),0.38,0.62);
}

async function getLearnedChallengerReplay(env:Env,url:URL):Promise<Response>{
  const runParam=Number(url.searchParams.get('backtest_run_id')??0);
  const run=runParam>0
    ? await env.DB.prepare(`SELECT * FROM backtest_runs WHERE backtest_run_id=? AND engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL')`).bind(runParam).first<Record<string,unknown>>()
    : await env.DB.prepare(`SELECT * FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  if(!run)return json({build:'5.5.1',message:'No completed walk-forward-v2 run found.',dates:[]});
  const runId=Number(run.backtest_run_id),buildId=Number(run.backtest_dataset_build_id);
  const requestedDate=String(url.searchParams.get('date')??'');
  if(!requestedDate){
    const dates=(await env.DB.prepare(`SELECT DISTINCT f.test_date_min AS test_date FROM backtest_folds f WHERE f.backtest_run_id=? AND f.status='EXECUTED' ORDER BY f.test_date_min`).bind(runId).all<{test_date:string}>()).results??[];
    return json({build:'5.5.1',replay_version:'v14-learned-directional-replay-v1',run,dates:dates.map(x=>x.test_date),feature_names:learnedFeatureNames,anti_lookahead:'train board_date strictly before target test date',live_runtime:'v14-baseline-calibrated-v1',candidate_runtime_status:'RESEARCH_ONLY_PENDING_REPLAY'});
  }
  const fold=await env.DB.prepare(`SELECT backtest_fold_id,test_date_min AS test_date FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' AND test_date_min=? LIMIT 1`).bind(runId,requestedDate).first<{backtest_fold_id:number;test_date:string}>();
  if(!fold)return json({build:'5.5.1',error:'Executed fold not found for requested date.'},{status:404});
  const train=(await env.DB.prepare(`SELECT backtest_dataset_row_id,board_date,preferred_side,preferred_outcome,more_outcome,less_outcome,raw_more_probability,calibrated_more_probability,projected_strikeouts,prop_line,pitcher_hand,model_edge,pitcher_features_json,team_features_json FROM backtest_dataset_rows_v3 WHERE backtest_dataset_build_id=? AND backtest_eligible=1 AND board_date<? AND more_outcome IN ('WIN','LOSS') ORDER BY board_date,backtest_dataset_row_id`).bind(buildId,requestedDate).all<LearnedChallengerRow>()).results??[];
  const tests=(await env.DB.prepare(`SELECT r.backtest_dataset_row_id,r.board_date,r.preferred_side,r.preferred_outcome,r.more_outcome,r.less_outcome,r.raw_more_probability,r.calibrated_more_probability,r.projected_strikeouts,r.prop_line,r.pitcher_hand,r.model_edge,r.pitcher_features_json,r.team_features_json FROM backtest_fold_rows_v3 fr JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE fr.backtest_fold_id=? AND fr.partition='TEST' AND r.more_outcome IN ('WIN','LOSS') ORDER BY r.backtest_dataset_row_id`).bind(fold.backtest_fold_id).all<LearnedChallengerRow>()).results??[];
  const model=trainLearnedDirectional(train);
  if(!model)return json({build:'5.5.1',date:requestedDate,status:'SKIPPED',reason:`need_100_train_rows_have_${train.length}`,train_rows:train.length,rows:[]});
  const rows=tests.map(r=>{
    const pMore=predictLearnedDirectional(model,r),side=pMore>=0.5?'MORE':'LESS',prob=side==='MORE'?pMore:1-pMore;
    const outcome=side==='MORE'?String(r.more_outcome):String(r.less_outcome); const v13Side=String(r.preferred_side??'').toUpperCase();
    return {row_id:r.backtest_dataset_row_id,date:r.board_date,v13_side:v13Side,v13_outcome:r.preferred_outcome,learned_side:side,learned_probability:prob,learned_outcome:outcome,play:prob>=0.55,disagrees:side!==v13Side,prop_line:r.prop_line,model_edge:r.model_edge};
  });
  const wins=rows.filter(r=>r.learned_outcome==='WIN').length,losses=rows.filter(r=>r.learned_outcome==='LOSS').length,dis=rows.filter(r=>r.disagrees),dw=dis.filter(r=>r.learned_outcome==='WIN').length;
  return json({build:'5.5.1',replay_version:'v14-learned-directional-replay-v1',date:requestedDate,status:'EXECUTED',train_rows:model.train_rows,test_rows:rows.length,wins,losses,hit_rate:wins+losses?wins/(wins+losses):null,disagreements:dis.length,disagreement_wins:dw,disagreement_hit_rate:dis.length?dw/dis.length:null,model:{features:model.feature_names,lambda:model.lambda,iterations:model.iterations},rows});
}



type StatcastCsvRow = Record<string, string>;

const STATCAST_SOURCE_KEY = "STATCAST_PITCH_LEVEL";
const STATCAST_CSV_ENDPOINT = "https://baseballsavant.mlb.com/statcast_search/csv";
const STATCAST_SWING_DESCRIPTIONS = new Set([
  "swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
  "hit_into_play", "hit_into_play_no_out", "hit_into_play_score",
  "foul_bunt", "missed_bunt", "bunt_foul_tip",
]);
const STATCAST_WHIFF_DESCRIPTIONS = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
const STATCAST_FASTBALL_TYPES = new Set(["FF", "SI", "FC"]);

function parseStatcastCsv(text: string): StatcastCsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ""; }
    else if (c === '\n') { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(v => v !== "")).map(r => {
    const out: StatcastCsvRow = {};
    headers.forEach((h, i) => out[h] = r[i] ?? "");
    return out;
  });
}

function statcastNum(v: unknown): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function statcastInt(v: unknown): number | null {
  const n = statcastNum(v); return n == null ? null : Math.trunc(n);
}
function statcastHand(v: unknown): "L" | "R" | null {
  const x = String(v ?? "").toUpperCase(); return x === "L" || x === "R" ? x : null;
}
function statcastDateOk(v: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(v); }

async function markStatcastSource(env: Env, values: {status: string; attempt?: boolean; success?: boolean; date?: string; error?: string | null; cursor?: Record<string, unknown>}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE statcast_source_state SET status=?, last_attempt_at=CASE WHEN ? THEN ? ELSE last_attempt_at END, last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END, complete_through_date=CASE WHEN ? IS NOT NULL THEN ? ELSE complete_through_date END, cursor_json=CASE WHEN ? IS NOT NULL THEN ? ELSE cursor_json END, last_error=?, updated_at=? WHERE source_key=?`)
    .bind(values.status, values.attempt ? 1 : 0, now, values.success ? 1 : 0, now, values.date ?? null, values.date ?? null, values.cursor ? 1 : null, values.cursor ? JSON.stringify(values.cursor) : null, values.error ?? null, now, STATCAST_SOURCE_KEY).run();
}

async function fetchStatcastDateCsv(date: string): Promise<{rows: StatcastCsvRow[]; bytes: number; url: string}> {
  const u = new URL(STATCAST_CSV_ENDPOINT);
  u.searchParams.set("all", "true");
  u.searchParams.set("type", "details");
  u.searchParams.set("player_type", "pitcher");
  u.searchParams.set("game_date_gt", date);
  u.searchParams.set("game_date_lt", date);
  u.searchParams.set("hfGT", "R|");
  const r = await fetch(u.toString(), {headers: {"Accept": "text/csv,*/*;q=0.8"}});
  const text = await r.text();
  if (!r.ok) throw new Error(`Baseball Savant CSV HTTP ${r.status}: ${text.slice(0, 180)}`);
  const rows = parseStatcastCsv(text);
  if (!rows.length && !/^\s*"?(pitch_type|game_date)"?\s*,/i.test(text)) throw new Error(`Baseball Savant returned an unexpected non-CSV response (${text.slice(0, 120)})`);
  return {rows, bytes: text.length, url: u.toString()};
}

async function rebuildStatcastPitcherGameMetrics(env: Env, date: string): Promise<number> {
  const aggs = (await env.DB.prepare(`SELECT game_pk,game_date,pitcher_mlb_id,COUNT(*) pitches,SUM(is_swing) swings,SUM(is_whiff) whiffs,SUM(is_called_strike) called_strikes,SUM(CASE WHEN is_whiff=1 OR is_called_strike=1 THEN 1 ELSE 0 END) csw_events,SUM(CASE WHEN is_in_zone=1 THEN 1 ELSE 0 END) zone_pitches,SUM(CASE WHEN is_in_zone=0 THEN 1 ELSE 0 END) out_of_zone_pitches,SUM(CASE WHEN is_chase=1 THEN 1 ELSE 0 END) chase_swings,AVG(CASE WHEN pitch_type IN ('FF','SI','FC') THEN release_speed END) avg_fastball_velocity,MAX(CASE WHEN pitch_type IN ('FF','SI','FC') THEN release_speed END) max_fastball_velocity,AVG(CASE WHEN pitch_type IN ('FF','SI','FC') THEN release_spin_rate END) avg_fastball_spin,SUM(CASE WHEN release_speed IS NOT NULL THEN 1 ELSE 0 END) velo_n,SUM(CASE WHEN zone IS NOT NULL THEN 1 ELSE 0 END) zone_n,SUM(CASE WHEN pitch_type IS NOT NULL AND pitch_type<>'' THEN 1 ELSE 0 END) type_n FROM statcast_pitch_events WHERE game_date=? GROUP BY game_pk,game_date,pitcher_mlb_id ORDER BY game_pk,pitcher_mlb_id`).bind(date).all<Record<string, unknown>>()).results ?? [];
  const mixRows = (await env.DB.prepare(`SELECT game_pk,pitcher_mlb_id,pitch_type,COUNT(*) n FROM statcast_pitch_events WHERE game_date=? AND pitch_type IS NOT NULL AND pitch_type<>'' GROUP BY game_pk,pitcher_mlb_id,pitch_type`).bind(date).all<Record<string, unknown>>()).results ?? [];
  const mixes = new Map<string, Record<string, number>>();
  for (const r of mixRows) { const k=`${r.game_pk}:${r.pitcher_mlb_id}`; const m=mixes.get(k)??{}; m[String(r.pitch_type)]=Number(r.n??0); mixes.set(k,m); }
  const stmts=[];
  for (const r of aggs) {
    const pitches=Number(r.pitches??0), swings=Number(r.swings??0), whiffs=Number(r.whiffs??0), called=Number(r.called_strikes??0), csw=Number(r.csw_events??0), out=Number(r.out_of_zone_pitches??0), chase=Number(r.chase_swings??0);
    const completeness=pitches?((Number(r.velo_n??0)+Number(r.zone_n??0)+Number(r.type_n??0))/(3*pitches)):0;
    const quality=Math.max(0,Math.min(100,Math.round(completeness*100)));
    const key=`${r.game_pk}:${r.pitcher_mlb_id}`;
    stmts.push(env.DB.prepare(`INSERT INTO statcast_pitcher_game_metrics(game_pk,game_date,pitcher_mlb_id,pitches,swings,whiffs,called_strikes,csw_events,zone_pitches,out_of_zone_pitches,chase_swings,whiff_rate,swinging_strike_rate,csw_rate,chase_rate,avg_fastball_velocity,max_fastball_velocity,avg_fastball_spin,pitch_mix_json,quality_score,details_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(game_pk,pitcher_mlb_id) DO UPDATE SET pitches=excluded.pitches,swings=excluded.swings,whiffs=excluded.whiffs,called_strikes=excluded.called_strikes,csw_events=excluded.csw_events,zone_pitches=excluded.zone_pitches,out_of_zone_pitches=excluded.out_of_zone_pitches,chase_swings=excluded.chase_swings,whiff_rate=excluded.whiff_rate,swinging_strike_rate=excluded.swinging_strike_rate,csw_rate=excluded.csw_rate,chase_rate=excluded.chase_rate,avg_fastball_velocity=excluded.avg_fastball_velocity,max_fastball_velocity=excluded.max_fastball_velocity,avg_fastball_spin=excluded.avg_fastball_spin,pitch_mix_json=excluded.pitch_mix_json,quality_score=excluded.quality_score,details_json=excluded.details_json,updated_at=CURRENT_TIMESTAMP`)
      .bind(Number(r.game_pk),String(r.game_date),Number(r.pitcher_mlb_id),pitches,swings,whiffs,called,csw,Number(r.zone_pitches??0),out,chase,swings?whiffs/swings:null,pitches?whiffs/pitches:null,pitches?csw/pitches:null,out?chase/out:null,r.avg_fastball_velocity??null,r.max_fastball_velocity??null,r.avg_fastball_spin??null,JSON.stringify(mixes.get(key)??{}),quality,JSON.stringify({fastball_family:["FF","SI","FC"],quality_inputs:{velo:Number(r.velo_n??0),zone:Number(r.zone_n??0),pitch_type:Number(r.type_n??0),pitches}})));
  }
  for(let i=0;i<stmts.length;i+=50) await env.DB.batch(stmts.slice(i,i+50));
  return aggs.length;
}

async function syncStatcastDate(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(()=>({})) as {date?: string};
  const date=String(body.date??"");
  if(!statcastDateOk(date)) return json({error:"date must be YYYY-MM-DD"},{status:400});
  await markStatcastSource(env,{status:"STALE",attempt:true,error:null,cursor:{date,stage:"FETCHING"}});
  try {
    const fetched=await fetchStatcastDateCsv(date);
    const valid=fetched.rows.filter(r=>statcastInt(r.game_pk)!=null && statcastInt(r.pitcher)!=null && statcastInt(r.at_bat_number)!=null && statcastInt(r.pitch_number)!=null && String(r.game_date||date)===date);
    const statements=[];
    let rejected=fetched.rows.length-valid.length;
    const gameIds=new Set<number>();
    const pitcherIds=new Set<number>();
    for(const r of valid){
      const gamePk=statcastInt(r.game_pk)!; const pitcher=statcastInt(r.pitcher)!; const ab=statcastInt(r.at_bat_number)!; const pn=statcastInt(r.pitch_number)!;
      gameIds.add(gamePk); pitcherIds.add(pitcher);
      const desc=String(r.description??""); const zone=statcastInt(r.zone); const swing=STATCAST_SWING_DESCRIPTIONS.has(desc)?1:0; const whiff=STATCAST_WHIFF_DESCRIPTIONS.has(desc)?1:0; const called=desc==="called_strike"?1:0; const inZone=zone==null?null:(zone>=1&&zone<=9?1:0); const chase=inZone==null?null:(swing&&inZone===0?1:0);
      const pt=String(r.pitch_type??"")||null;
      const payload={sv_id:r.sv_id||null,balls:statcastInt(r.balls),strikes:statcastInt(r.strikes),outs_when_up:statcastInt(r.outs_when_up),home_team:r.home_team||null,away_team:r.away_team||null};
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO statcast_pitch_events(game_pk,game_date,pitcher_mlb_id,batter_mlb_id,at_bat_number,pitch_number,inning,half_inning,pitcher_hand,batter_side,pitch_type,pitch_name,release_speed,effective_speed,release_spin_rate,plate_x,plate_z,zone,description,event,is_swing,is_whiff,is_called_strike,is_in_zone,is_chase,source_payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(gamePk,date,pitcher,statcastInt(r.batter),ab,pn,statcastInt(r.inning),String(r.inning_topbot??"")||null,statcastHand(r.p_throws),statcastHand(r.stand),pt,String(r.pitch_name??"")||null,statcastNum(r.release_speed),statcastNum(r.effective_speed),statcastNum(r.release_spin_rate),statcastNum(r.plate_x),statcastNum(r.plate_z),zone,desc||null,String(r.events??"")||null,swing,whiff,called,inZone,chase,JSON.stringify(payload)));
    }
    let inserted=0;
    for(let i=0;i<statements.length;i+=75){ const rs=await env.DB.batch(statements.slice(i,i+75)); inserted+=rs.reduce((a:any,x:any)=>a+Number(x.meta?.changes??0),0); }
    const metricRows=await rebuildStatcastPitcherGameMetrics(env,date);
    const totals=await env.DB.prepare(`SELECT COUNT(*) n,COUNT(DISTINCT game_pk) games,COUNT(DISTINCT pitcher_mlb_id) pitchers FROM statcast_pitch_events WHERE game_date=?`).bind(date).first<Record<string,unknown>>();
    await markStatcastSource(env,{status:"HEALTHY",success:true,date,error:null,cursor:{date,stage:"COMPLETE",source_rows:fetched.rows.length,valid_rows:valid.length,inserted_rows:inserted,rejected_rows:rejected,games:gameIds.size,pitchers:pitcherIds.size,bytes:fetched.bytes}});
    await env.DB.prepare(`INSERT INTO statcast_backfill_dates(calendar_date,status,source_rows,valid_rows,stored_pitch_events,pitcher_games,last_error,attempted_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(calendar_date) DO UPDATE SET status=excluded.status,source_rows=excluded.source_rows,valid_rows=excluded.valid_rows,stored_pitch_events=excluded.stored_pitch_events,pitcher_games=excluded.pitcher_games,last_error=NULL,attempted_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(date,fetched.rows.length>0?'COMPLETE':'EMPTY',fetched.rows.length,valid.length,Number(totals?.n??0),metricRows).run();
    return json({release:"3.6",build:"7.4.2",status:"SUCCEEDED",date,source:"Baseball Savant Statcast Search CSV",source_rows:fetched.rows.length,valid_rows:valid.length,inserted_rows:inserted,rejected_rows:rejected,stored_pitch_events:Number(totals?.n??0),games:Number(totals?.games??0),pitchers:Number(totals?.pitchers??0),pitcher_game_metrics:metricRows,definitions:{swing_descriptions:[...STATCAST_SWING_DESCRIPTIONS],whiff_descriptions:[...STATCAST_WHIFF_DESCRIPTIONS],zone:"Statcast zones 1-9",fastball_family:[...STATCAST_FASTBALL_TYPES]},production_models_changed:false});
  } catch(e:any) {
    const message=String(e?.message??e).slice(0,500);
    await markStatcastSource(env,{status:"FAILED",error:message,cursor:{date,stage:"FAILED"}}).catch(()=>{});
    await env.DB.prepare(`INSERT INTO statcast_backfill_dates(calendar_date,status,last_error,attempted_at,updated_at) VALUES(?,'FAILED',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(calendar_date) DO UPDATE SET status='FAILED',last_error=excluded.last_error,attempted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(date,message).run().catch(()=>null);
    return json({release:"3.6",build:"7.4.2",status:"FAILED",date,error:message,production_models_changed:false},{status:502});
  }
}



type StatcastGameFeatureRow = {
  game_date: string; game_pk: number; pitcher_mlb_id: number; pitches: number; swings: number; whiffs: number;
  csw_events: number; out_of_zone_pitches: number; chase_swings: number; avg_fastball_velocity: number | null;
  avg_fastball_spin: number | null; pitch_mix_json: string; quality_score: number;
};

function statcastSafeJson(v: unknown): Record<string, number> {
  try {
    const x = JSON.parse(String(v ?? '{}'));
    if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(x)) {
      const n = Number(val); if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  } catch { return {}; }
}

function weightedAverage(rows: StatcastGameFeatureRow[], field: 'avg_fastball_velocity'|'avg_fastball_spin'): number | null {
  let num=0, den=0;
  for(const r of rows){ const v=r[field]; if(v==null || !Number.isFinite(Number(v))) continue; const w=Math.max(1,Number(r.pitches||0)); num+=Number(v)*w; den+=w; }
  return den?num/den:null;
}

async function buildStatcastDailyFeatures(request: Request, env: Env): Promise<Response> {
  const body=(await request.json<{feature_date?:string;backfill_run_id?:number}>().catch(()=>({}))) as {feature_date?:string;backfill_run_id?:number};
  const featureDate=String(body.feature_date??'');
  if(!statcastDateOk(featureDate)) return json({error:'feature_date must be YYYY-MM-DD'},{status:400});
  const source=await env.DB.prepare(`SELECT status,complete_through_date FROM statcast_source_state WHERE source_key=? LIMIT 1`).bind(STATCAST_SOURCE_KEY).first<{status:string;complete_through_date:string|null}>();
  const backfillRunId=Number(body.backfill_run_id??0);
  const pitchers=backfillRunId>0
    ? ((await env.DB.prepare(`SELECT DISTINCT p.mlb_id AS pitcher_mlb_id FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id JOIN pitchers p ON p.pitcher_id=r.pitcher_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND f.test_date_min=? AND p.mlb_id IS NOT NULL ORDER BY p.mlb_id`).bind(backfillRunId,featureDate).all<{pitcher_mlb_id:number}>()).results??[])
    : ((await env.DB.prepare(`SELECT DISTINCT pitcher_mlb_id FROM statcast_pitcher_game_metrics WHERE game_date<? AND game_date>=date(?,'-30 days') ORDER BY pitcher_mlb_id`).bind(featureDate,featureDate).all<{pitcher_mlb_id:number}>()).results??[]);
  let inserted=0, updated=0;
  for(const p of pitchers){
    const all30=(await env.DB.prepare(`SELECT game_date,game_pk,pitcher_mlb_id,pitches,swings,whiffs,csw_events,out_of_zone_pitches,chase_swings,avg_fastball_velocity,avg_fastball_spin,pitch_mix_json,quality_score FROM statcast_pitcher_game_metrics WHERE pitcher_mlb_id=? AND game_date<? AND game_date>=date(?,'-30 days') ORDER BY game_date DESC,game_pk DESC`).bind(p.pitcher_mlb_id,featureDate,featureDate).all<StatcastGameFeatureRow>()).results??[];
    const recent=all30.slice(0,5); if(!recent.length) continue;
    const pitches=recent.reduce((a,r)=>a+Number(r.pitches||0),0), swings=recent.reduce((a,r)=>a+Number(r.swings||0),0), whiffs=recent.reduce((a,r)=>a+Number(r.whiffs||0),0), csw=recent.reduce((a,r)=>a+Number(r.csw_events||0),0), ooz=recent.reduce((a,r)=>a+Number(r.out_of_zone_pitches||0),0), chase=recent.reduce((a,r)=>a+Number(r.chase_swings||0),0);
    const whiffRate=swings?whiffs/swings:null, swstr=pitches?whiffs/pitches:null, cswRate=pitches?csw/pitches:null, chaseRate=ooz?chase/ooz:null;
    const avgVelo=weightedAverage(recent,'avg_fastball_velocity'), avgSpin=weightedAverage(recent,'avg_fastball_spin');
    const recent2Velo=weightedAverage(recent.slice(0,2),'avg_fastball_velocity'), baseline30Velo=weightedAverage(all30,'avg_fastball_velocity');
    const veloDelta=(recent2Velo!=null&&baseline30Velo!=null)?recent2Velo-baseline30Velo:null;
    const mixCounts:Record<string,number>={}; let mixTotal=0;
    for(const r of recent){ const mix=statcastSafeJson(r.pitch_mix_json); for(const [k,v] of Object.entries(mix)){ const c=v<=1?Math.round(v*Math.max(1,r.pitches)):v; mixCounts[k]=(mixCounts[k]||0)+c; mixTotal+=c; } }
    const mixShares:Record<string,number>={}; if(mixTotal) for(const [k,v] of Object.entries(mixCounts)) mixShares[k]=v/mixTotal;
    const games30=all30.length, pitches30=all30.reduce((a,r)=>a+Number(r.pitches||0),0);
    const q=Math.max(0,Math.min(100,Math.round(20+Math.min(50,recent.length*10)+Math.min(30,pitches/10))));
    const details={anti_lookahead:`game_date < ${featureDate}`,window_games:recent.length,window_days:30,recent_game_dates:recent.map(r=>r.game_date),rate_weighting:'event-count weighted',velocity_recent_games:Math.min(2,recent.length),source_status:source?.status??'UNKNOWN'};
    await env.DB.prepare(`INSERT INTO statcast_pitcher_daily_features(feature_date,pitcher_mlb_id,games_lookback,pitches_lookback,whiff_rate,swinging_strike_rate,csw_rate,chase_rate,avg_fastball_velocity,velocity_delta_30d,avg_fastball_spin,hand_split_quality,feature_quality_score,source_complete_through,details_json,games_30d,pitches_30d,last_game_date,recent_fastball_velocity,baseline_fastball_velocity_30d,pitch_mix_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(feature_date,pitcher_mlb_id) DO UPDATE SET games_lookback=excluded.games_lookback,pitches_lookback=excluded.pitches_lookback,whiff_rate=excluded.whiff_rate,swinging_strike_rate=excluded.swinging_strike_rate,csw_rate=excluded.csw_rate,chase_rate=excluded.chase_rate,avg_fastball_velocity=excluded.avg_fastball_velocity,velocity_delta_30d=excluded.velocity_delta_30d,avg_fastball_spin=excluded.avg_fastball_spin,feature_quality_score=excluded.feature_quality_score,source_complete_through=excluded.source_complete_through,details_json=excluded.details_json,games_30d=excluded.games_30d,pitches_30d=excluded.pitches_30d,last_game_date=excluded.last_game_date,recent_fastball_velocity=excluded.recent_fastball_velocity,baseline_fastball_velocity_30d=excluded.baseline_fastball_velocity_30d,pitch_mix_json=excluded.pitch_mix_json`)
      .bind(featureDate,p.pitcher_mlb_id,recent.length,pitches,whiffRate,swstr,cswRate,chaseRate,avgVelo,veloDelta,avgSpin,null,q,source?.complete_through_date??null,JSON.stringify(details),games30,pitches30,recent[0].game_date,recent2Velo,baseline30Velo,JSON.stringify(mixShares)).run();
    inserted++;
  }
  const total=await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_pitcher_daily_features WHERE feature_date=?`).bind(featureDate).first<{n:number}>();
  return json({release:'3.6',build:backfillRunId>0?'7.4.3':'7.3',status:'SUCCEEDED',feature_date:featureDate,pitchers_considered:pitchers.length,inserted,updated,stored_features:Number(total?.n??0),scope:backfillRunId>0?'BACKTEST_TEST_PITCHERS':'ALL_STATCAST_PITCHERS',anti_lookahead:'Only Statcast pitcher-game rows with game_date strictly before feature_date are used.',production_models_changed:false});
}

async function getStatcastDailyFeatureStatus(env: Env, url: URL): Promise<Response> {
  const featureDate=String(url.searchParams.get('date')??'');
  const recent=(await env.DB.prepare(`SELECT feature_date,pitcher_mlb_id,games_lookback,pitches_lookback,whiff_rate,swinging_strike_rate,csw_rate,chase_rate,avg_fastball_velocity,recent_fastball_velocity,velocity_delta_30d,avg_fastball_spin,feature_quality_score,last_game_date,pitch_mix_json FROM statcast_pitcher_daily_features ${featureDate?'WHERE feature_date=?':''} ORDER BY feature_date DESC,feature_quality_score DESC,pitches_lookback DESC LIMIT 60`).bind(...(featureDate?[featureDate]:[])).all<Record<string,unknown>>()).results??[];
  const count=await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_pitcher_daily_features`).first<{n:number}>();
  return json({release:'3.6',build:'7.3',daily_feature_rows:Number(count?.n??0),feature_date:featureDate||null,recent,anti_lookahead:'game_date < feature_date',production_models_changed:false});
}

async function getStatcastFoundationStatus(env: Env): Promise<Response> {
  const source = await env.DB.prepare(`SELECT source_key,status,last_attempt_at,last_success_at,complete_through_date,cursor_json,last_error,updated_at FROM statcast_source_state WHERE source_key=? LIMIT 1`).bind(STATCAST_SOURCE_KEY).first<Record<string, unknown>>();
  const pitchEvents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM statcast_pitch_events`).first<Record<string, unknown>>();
  const pitcherGames = await env.DB.prepare(`SELECT COUNT(*) AS n FROM statcast_pitcher_game_metrics`).first<Record<string, unknown>>();
  const dailyFeatures = await env.DB.prepare(`SELECT COUNT(*) AS n FROM statcast_pitcher_daily_features`).first<Record<string, unknown>>();
  const sourceState = await env.DB.prepare(`SELECT COUNT(*) AS n FROM statcast_source_state`).first<Record<string, unknown>>();
  const recent = (await env.DB.prepare(`SELECT game_date,game_pk,pitcher_mlb_id,pitches,swings,whiffs,called_strikes,whiff_rate,swinging_strike_rate,csw_rate,chase_rate,avg_fastball_velocity,max_fastball_velocity,avg_fastball_spin,quality_score FROM statcast_pitcher_game_metrics ORDER BY game_date DESC,game_pk DESC,pitches DESC LIMIT 40`).all<Record<string,unknown>>()).results??[];
  return json({
    release: "3.6", build: "7.4", mode: "HISTORICAL_BACKFILL", source: source ?? { source_key: STATCAST_SOURCE_KEY, status: "NEVER_SYNCED" },
    counts: { pitch_events: Number(pitchEvents?.n ?? 0), pitcher_games: Number(pitcherGames?.n ?? 0), daily_features: Number(dailyFeatures?.n ?? 0), source_state: Number(sourceState?.n ?? 0) },
    recent_pitcher_games: recent, production_models_changed: false,
  });
}

function statcastIsoDateAdd(date:string,days:number):string{const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function statcastDateRange(start:string,end:string):string[]{const out:string[]=[];if(!statcastDateOk(start)||!statcastDateOk(end)||start>end)return out;for(let d=start;d<=end;d=statcastIsoDateAdd(d,1))out.push(d);return out;}

async function getStatcastBackfillContext(env:Env):Promise<{run:Record<string,unknown>;runId:number;buildId:number;featureDates:string[];ingestDates:string[]}|null>{
  const run=await env.DB.prepare(`SELECT * FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();if(!run)return null;
  const runId=Number(run.backtest_run_id),buildId=Number(run.backtest_dataset_build_id);
  const rows=(await env.DB.prepare(`SELECT DISTINCT test_date_min AS d FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' ORDER BY test_date_min`).bind(runId).all<{d:string}>()).results??[];
  const featureDates=rows.map(x=>String(x.d)).filter(statcastDateOk);if(!featureDates.length)return null;
  return {run,runId,buildId,featureDates,ingestDates:statcastDateRange(statcastIsoDateAdd(featureDates[0],-30),statcastIsoDateAdd(featureDates[featureDates.length-1],-1))};
}

async function getStatcastBackfillStatus(env:Env):Promise<Response>{
  const ctx=await getStatcastBackfillContext(env);if(!ctx)return json({release:'3.6',build:'7.4.3',message:'No completed walk-forward-v2 run with executed folds found.',production_models_changed:false});
  const states=(await env.DB.prepare(`SELECT calendar_date,status,source_rows,stored_pitch_events,pitcher_games,last_error,completed_at FROM statcast_backfill_dates WHERE calendar_date>=? AND calendar_date<=? ORDER BY calendar_date`).bind(ctx.ingestDates[0],ctx.ingestDates[ctx.ingestDates.length-1]).all<Record<string,unknown>>()).results??[];
  const sm=new Map(states.map(r=>[String(r.calendar_date),r]));const complete=ctx.ingestDates.filter(d=>['COMPLETE','EMPTY'].includes(String(sm.get(d)?.status??'')));const failed=states.filter(r=>String(r.status)==='FAILED');
  const fr=(await env.DB.prepare(`SELECT feature_date,COUNT(*) n,AVG(feature_quality_score) avg_quality FROM statcast_pitcher_daily_features WHERE feature_date>=? AND feature_date<=? GROUP BY feature_date ORDER BY feature_date`).bind(ctx.featureDates[0],ctx.featureDates[ctx.featureDates.length-1]).all<Record<string,unknown>>()).results??[];const fm=new Map(fr.map(r=>[String(r.feature_date),r]));const built=ctx.featureDates.filter(d=>Number(fm.get(d)?.n??0)>0);
  const cert=await env.DB.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN certification_status='RESEARCH_CERTIFIED' THEN 1 ELSE 0 END) certified,SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded,COUNT(DISTINCT feature_date) dates FROM statcast_backfill_certifications WHERE backtest_run_id=?`).bind(ctx.runId).first<Record<string,unknown>>();
  const latest=(await env.DB.prepare(`SELECT feature_date,pitcher_mlb_id,certification_status,feature_quality_score,games_lookback,pitches_lookback,max_source_game_date,reasons_json FROM statcast_backfill_certifications WHERE backtest_run_id=? ORDER BY feature_date DESC,pitcher_mlb_id LIMIT 40`).bind(ctx.runId).all<Record<string,unknown>>()).results??[];
  const nextIngest=ctx.ingestDates.find(d=>!['COMPLETE','EMPTY'].includes(String(sm.get(d)?.status??'')))??null;const nextFeature=nextIngest?null:(ctx.featureDates.find(d=>Number(fm.get(d)?.n??0)===0)??null);const current=!nextIngest&&!nextFeature&&Number(cert?.dates??0)>=ctx.featureDates.length;
  return json({release:'3.6',build:'7.4.3',mode:'HISTORICAL_BACKFILL_CERTIFICATION',backtest_run_id:ctx.runId,dataset_build_id:ctx.buildId,range:{feature_start:ctx.featureDates[0],feature_end:ctx.featureDates.at(-1),ingest_start:ctx.ingestDates[0],ingest_end:ctx.ingestDates.at(-1)},ingestion:{required:ctx.ingestDates.length,complete:complete.length,failed:failed.length,next_date:nextIngest,recent:states.slice(-20).reverse()},features:{required_dates:ctx.featureDates.length,built_dates:built.length,next_date:nextFeature,rows:fr.reduce((a,r)=>a+Number(r.n??0),0)},certification:{rows:Number(cert?.n??0),certified:Number(cert?.certified??0),excluded:Number(cert?.excluded??0),dates:Number(cert?.dates??0),current,recent:latest},done:current,anti_lookahead:'game_date < feature_date; complete prior 30-calendar-day source window required',provenance:'Historical Baseball Savant backfill; research replay only',production_models_changed:false});
}

async function certifyStatcastBackfill(env:Env):Promise<Response>{
  const ctx=await getStatcastBackfillContext(env);if(!ctx)return json({error:'No completed walk-forward-v2 run found.'},{status:404});
  const doneRows=(await env.DB.prepare(`SELECT DISTINCT feature_date FROM statcast_backfill_certifications WHERE backtest_run_id=?`).bind(ctx.runId).all<{feature_date:string}>()).results??[];
  const doneDates=new Set(doneRows.map(r=>String(r.feature_date)));
  const featureDate=ctx.featureDates.find(d=>!doneDates.has(d));
  if(!featureDate){const totals=await env.DB.prepare(`SELECT COUNT(*) processed,SUM(CASE WHEN certification_status='RESEARCH_CERTIFIED' THEN 1 ELSE 0 END) certified,SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded FROM statcast_backfill_certifications WHERE backtest_run_id=?`).bind(ctx.runId).first<Record<string,unknown>>();return json({release:'3.6',build:'7.4.3',status:'DONE',processed:Number(totals?.processed??0),certified:Number(totals?.certified??0),excluded:Number(totals?.excluded??0),feature_dates:ctx.featureDates.length,production_models_changed:false});}
  const ws=statcastIsoDateAdd(featureDate,-30),we=statcastIsoDateAdd(featureDate,-1);
  const sd=await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_backfill_dates WHERE calendar_date>=? AND calendar_date<=? AND status IN ('COMPLETE','EMPTY')`).bind(ws,we).first<{n:number}>();const sourceComplete=Number(sd?.n??0)===30;
  const ps=(await env.DB.prepare(`SELECT DISTINCT p.mlb_id AS pitcher_mlb_id FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id JOIN pitchers p ON p.pitcher_id=r.pitcher_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND f.test_date_min=? AND p.mlb_id IS NOT NULL ORDER BY p.mlb_id`).bind(ctx.runId,featureDate).all<{pitcher_mlb_id:number}>()).results??[];
  let certified=0,excluded=0,processed=0;
  for(const pr of ps){const f=await env.DB.prepare(`SELECT games_lookback,pitches_lookback,feature_quality_score,last_game_date FROM statcast_pitcher_daily_features WHERE feature_date=? AND pitcher_mlb_id=? LIMIT 1`).bind(featureDate,pr.pitcher_mlb_id).first<Record<string,unknown>>();const reasons:string[]=[];if(!sourceComplete)reasons.push('incomplete_30d_source_window');if(!f)reasons.push('missing_daily_feature');if(f&&Number(f.pitches_lookback??0)<=0)reasons.push('no_prior_statcast_pitches');if(f&&f.last_game_date&&String(f.last_game_date)>=featureDate)reasons.push('lookahead_violation');const status=reasons.length?'EXCLUDED':'RESEARCH_CERTIFIED';const mx=f?.last_game_date==null?null:String(f.last_game_date);
    await env.DB.prepare(`INSERT INTO statcast_backfill_certifications(backtest_run_id,backtest_dataset_build_id,feature_date,pitcher_mlb_id,certification_status,source_window_complete,games_lookback,pitches_lookback,feature_quality_score,max_source_game_date,reasons_json,evidence_json,certified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(backtest_run_id,feature_date,pitcher_mlb_id) DO UPDATE SET certification_status=excluded.certification_status,source_window_complete=excluded.source_window_complete,games_lookback=excluded.games_lookback,pitches_lookback=excluded.pitches_lookback,feature_quality_score=excluded.feature_quality_score,max_source_game_date=excluded.max_source_game_date,reasons_json=excluded.reasons_json,evidence_json=excluded.evidence_json,certified_at=CURRENT_TIMESTAMP`).bind(ctx.runId,ctx.buildId,featureDate,pr.pitcher_mlb_id,status,sourceComplete?1:0,Number(f?.games_lookback??0),Number(f?.pitches_lookback??0),Number(f?.feature_quality_score??0),mx,JSON.stringify(reasons),JSON.stringify({window_start:ws,window_end:we,source_days:Number(sd?.n??0),anti_lookahead:mx==null?null:mx<featureDate})).run();processed++;if(status==='RESEARCH_CERTIFIED')certified++;else excluded++;}
  await env.DB.prepare(`INSERT INTO audit_events(event_type,entity_type,event_details) VALUES('STATCAST_BACKFILL_CERTIFIED_DATE','BACKTEST',?)`).bind(JSON.stringify({release:'3.6',build:'7.4.3',backtest_run_id:ctx.runId,feature_date:featureDate,processed,certified,excluded})).run();
  return json({release:'3.6',build:'7.4.3',status:'SUCCEEDED',feature_date:featureDate,processed,certified,excluded,remaining_dates:Math.max(0,ctx.featureDates.length-doneDates.size-1),production_models_changed:false});
}


type StatcastReplayRow = {
  backtest_dataset_row_id:number; board_date:string; pitcher_id:number; pitcher_mlb_id:number; pitcher_hand:string|null;
  prop_line:number; projected_strikeouts:number|null; model_edge:number|null; preferred_side:string|null; preferred_outcome:string|null;
  more_outcome:string|null; less_outcome:string|null; raw_more_probability:number|null; calibrated_more_probability:number|null;
  whiff_rate:number|null; swinging_strike_rate:number|null; csw_rate:number|null; chase_rate:number|null;
  avg_fastball_velocity:number|null; velocity_delta_30d:number|null; avg_fastball_spin:number|null;
  games_lookback:number|null; pitches_lookback:number|null; feature_quality_score:number|null; pitch_mix_json:string|null;
};
type StatcastReplayModel={means:number[];scales:number[];weights:number[];train_rows:number;lambda:number;iterations:number;feature_names:string[]};
const statcastReplayFeatureNames=['baseline_margin','abs_margin','prop_line','pitcher_is_left','whiff_rate','swinging_strike_rate','csw_rate','chase_rate','avg_fastball_velocity','velocity_delta_30d','avg_fastball_spin','fastball_mix_share','games_lookback','log_pitches_lookback','feature_quality_score'];
function statcastMixShare(raw:string|null):number|null{try{const o=JSON.parse(raw||'{}');let total=0,fb=0;for(const [k,v] of Object.entries(o)){const n=Number(v);if(!Number.isFinite(n))continue;total+=n;if(['FF','SI','FC'].includes(k))fb+=n;}return total>0?fb/total:null}catch{return null}}
function statcastReplayVector(r:StatcastReplayRow):(number|null)[]{const margin=r.projected_strikeouts==null?null:Number(r.projected_strikeouts)-Number(r.prop_line);return [margin,margin==null?null:Math.abs(margin),Number(r.prop_line),String(r.pitcher_hand||'').toUpperCase()==='L'?1:0,r.whiff_rate,r.swinging_strike_rate,r.csw_rate,r.chase_rate,r.avg_fastball_velocity,r.velocity_delta_30d,r.avg_fastball_spin,statcastMixShare(r.pitch_mix_json),r.games_lookback,r.pitches_lookback==null?null:Math.log1p(Math.max(0,Number(r.pitches_lookback))),r.feature_quality_score==null?null:Number(r.feature_quality_score)/100];}
function trainStatcastReplay(rows:StatcastReplayRow[]):StatcastReplayModel|null{const usable=rows.filter(r=>['WIN','LOSS'].includes(String(r.more_outcome||'').toUpperCase()));if(usable.length<80)return null;const rawX=usable.map(statcastReplayVector),d=statcastReplayFeatureNames.length,means=Array(d).fill(0),counts=Array(d).fill(0);for(const x of rawX)for(let j=0;j<d;j++)if(x[j]!=null&&Number.isFinite(Number(x[j]))){means[j]+=Number(x[j]);counts[j]++;}for(let j=0;j<d;j++)means[j]=counts[j]?means[j]/counts[j]:0;const scales=Array(d).fill(0);for(const x of rawX)for(let j=0;j<d;j++){const v=x[j]==null?means[j]:Number(x[j]);scales[j]+=(v-means[j])*(v-means[j]);}for(let j=0;j<d;j++){scales[j]=Math.sqrt(scales[j]/Math.max(1,usable.length-1));if(!Number.isFinite(scales[j])||scales[j]<1e-6)scales[j]=1;}const X=rawX.map(x=>[1,...x.map((v,j)=>((v==null?means[j]:Number(v))-means[j])/scales[j])]),y=usable.map(r=>String(r.more_outcome).toUpperCase()==='WIN'?1:0),w=Array(d+1).fill(0),lambda=0.75,lr=.06,iterations=120;for(let it=0;it<iterations;it++){const g=Array(d+1).fill(0);for(let i=0;i<X.length;i++){let z=0;for(let j=0;j<w.length;j++)z+=w[j]*X[i][j];const e=learnedSigmoid(z)-y[i];for(let j=0;j<w.length;j++)g[j]+=e*X[i][j];}for(let j=0;j<w.length;j++){g[j]/=X.length;if(j>0)g[j]+=lambda*w[j]/X.length;w[j]-=lr*g[j];}}return {means,scales,weights:w,train_rows:usable.length,lambda,iterations,feature_names:statcastReplayFeatureNames};}
function predictStatcastReplay(m:StatcastReplayModel,r:StatcastReplayRow):number{const x=statcastReplayVector(r);let z=m.weights[0];for(let j=0;j<x.length;j++){const v=x[j]==null?m.means[j]:Number(x[j]);z+=m.weights[j+1]*((v-m.means[j])/m.scales[j]);}const raw=learnedSigmoid(z);return clamp(.5+.72*(raw-.5),.36,.64);}
async function statcastReplayDates(env:Env,runId:number):Promise<string[]>{return ((await env.DB.prepare(`SELECT DISTINCT test_date_min d FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' ORDER BY test_date_min`).bind(runId).all<{d:string}>()).results??[]).map(x=>String(x.d));}


async function contextSha256(text:string):Promise<string>{
  const bytes=new TextEncoder().encode(text);const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function contextWindSpeed(raw:string|null):number|null{if(!raw)return null;const m=raw.match(/(\d+(?:\.\d+)?)\s*mph/i);return m?Number(m[1]):null;}
async function syncGameContextDate(request:Request,env:Env):Promise<Response>{
  const body=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
  const date=validateDate(String(body.date||new Date().toISOString().slice(0,10)));
  const offset=Math.max(0,Number(body.offset||0));
  const limit=Math.max(1,Math.min(4,Number(body.limit||4)));
  const schedUrl=new URL('https://statsapi.mlb.com/api/v1/schedule');schedUrl.searchParams.set('sportId','1');schedUrl.searchParams.set('date',date);
  const schedule=await fetchMlbJson(schedUrl.toString());const allGames=((schedule as any)?.dates??[]).flatMap((d:any)=>Array.isArray(d.games)?d.games:[]);
  const games=allGames.slice(offset,offset+limit);
  const run=await env.DB.prepare(`INSERT INTO sync_runs(run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end) VALUES(?,'MLB_STATS_API','GAME_CONTEXT','INCREMENTAL','ADMIN','RUNNING',?,?)`).bind(crypto.randomUUID(),`${date}:${offset}`,`${date}:${Math.max(offset,offset+games.length-1)}`).run();
  const syncRunId=Number(run.meta.last_row_id);let stored=0,weather=0,umpires=0,errors=0,requests=1;
  for(const g of games){const gamePk=Number(g?.gamePk??0);if(!gamePk)continue;try{
    const feed=await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);requests++;
    const gd=(feed as any)?.gameData??{}, weatherObj=gd?.weather??{}, venue=gd?.venue??{};
    const officials=(feed as any)?.liveData?.boxscore?.officials??gd?.officials??[];
    const hp=officials.find((o:any)=>String(o?.officialType??'').toLowerCase().includes('home plate'))??null;
    const wind=String(weatherObj?.wind??'')||null,temp=Number(weatherObj?.temp);const humidity=Number(weatherObj?.humidity);
    const canonical=JSON.stringify({gamePk,date,temp:Number.isFinite(temp)?temp:null,condition:weatherObj?.condition??null,wind,humidity:Number.isFinite(humidity)?humidity:null,venue:venue?.name??g?.venue?.name??null,dayNight:gd?.datetime?.dayNight??g?.dayNight??null,umpire:hp?.official?.id??null});
    const hash=await contextSha256(canonical);let quality=20;
    if(Number.isFinite(temp)||weatherObj?.condition||wind)quality+=35;
    if(hp?.official?.id||hp?.official?.fullName)quality+=30;
    if(venue?.name||g?.venue?.name)quality+=10;if(gd?.datetime?.dateTime||g?.gameDate)quality+=5;
    await env.DB.prepare(`INSERT INTO game_context_snapshots(mlb_game_pk,official_date,captured_at,scheduled_start,venue_id,venue_name,day_night,temperature_f,weather_condition,wind_text,wind_speed_mph,humidity_pct,home_plate_umpire_mlb_id,home_plate_umpire_name,source_name,source_mode,payload_hash,quality_score,details_json,sync_run_id) VALUES(?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mlb_game_pk,payload_hash) DO UPDATE SET captured_at=CURRENT_TIMESTAMP,quality_score=excluded.quality_score,details_json=excluded.details_json,sync_run_id=excluded.sync_run_id`).bind(gamePk,date,String(gd?.datetime?.dateTime??g?.gameDate??'')||null,Number(venue?.id)||null,String(venue?.name??g?.venue?.name??'')||null,String(gd?.datetime?.dayNight??g?.dayNight??'')||null,Number.isFinite(temp)?temp:null,String(weatherObj?.condition??'')||null,wind,contextWindSpeed(wind),Number.isFinite(humidity)?humidity:null,Number(hp?.official?.id)||null,String(hp?.official?.fullName??'')||null,'MLB_STATS_API','CURRENT_SYNC',hash,quality,JSON.stringify({game_status:gd?.status?.detailedState??g?.status?.detailedState??null,weather:weatherObj,venue}),syncRunId).run();
    stored++;if(Number.isFinite(temp)||weatherObj?.condition||wind)weather++;if(hp?.official?.id||hp?.official?.fullName)umpires++;
  }catch(e){errors++;await env.DB.prepare(`INSERT INTO sync_errors(sync_run_id,error_stage,error_code,error_message,source_record_key) VALUES(?,'GAME_CONTEXT','CONTEXT_FETCH',?,?)`).bind(syncRunId,String((e as Error)?.message??e),String(gamePk)).run();}}
  const nextOffset=offset+games.length,done=nextOffset>=allGames.length;
  const status=errors&&stored===0?'FAILED':errors?'DEGRADED':'HEALTHY';
  await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,request_count=?,details_json=? WHERE sync_run_id=?`).bind(errors&&stored===0?'FAILED':'SUCCEEDED',games.length,stored,requests,JSON.stringify({date,offset,limit,total_games:allGames.length,stored,weather,umpires,errors,done}),syncRunId).run();
  await env.DB.prepare(`UPDATE data_source_status SET status=?,last_attempt_at=CURRENT_TIMESTAMP,last_success_at=CASE WHEN ?!='FAILED' THEN CURRENT_TIMESTAMP ELSE last_success_at END,last_sync_run_id=?,status_message=?,record_count=(SELECT COUNT(*) FROM game_context_snapshots),last_complete_through_at=CASE WHEN ? THEN ? ELSE last_complete_through_at END,consecutive_failures=CASE WHEN ?='FAILED' THEN consecutive_failures+1 ELSE 0 END,metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE source_name='MLB_STATS_API' AND dataset_name='GAME_CONTEXT'`).bind(status,status,syncRunId,`${date}: batch ${offset}-${Math.max(offset,nextOffset-1)}; ${stored}/${games.length} stored; errors ${errors}`,done?1:0,date,status,JSON.stringify({date,offset,limit,total_games:allGames.length,stored,weather,umpires,errors,done,next_offset:nextOffset})).run();
  return json({ok:errors===0,date,total_games:allGames.length,batch_offset:offset,batch_games:games.length,stored,weather,umpires,errors,status,next_offset:nextOffset,done});
}
async function getGameContextStatus(env:Env,url:URL):Promise<Response>{
  const date=url.searchParams.get('date');
  const state=await env.DB.prepare(`SELECT * FROM data_source_status WHERE source_name='MLB_STATS_API' AND dataset_name='GAME_CONTEXT'`).first<Record<string,unknown>>();
  const rows=date?(await env.DB.prepare(`SELECT * FROM game_context_snapshots WHERE official_date=? ORDER BY scheduled_start,mlb_game_pk`).bind(validateDate(date)).all<Record<string,unknown>>()).results??[]:(await env.DB.prepare(`SELECT * FROM game_context_snapshots ORDER BY official_date DESC,scheduled_start DESC LIMIT 100`).all<Record<string,unknown>>()).results??[];
  const summary=await env.DB.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT official_date) dates,COUNT(DISTINCT mlb_game_pk) games,SUM(CASE WHEN temperature_f IS NOT NULL OR weather_condition IS NOT NULL OR wind_text IS NOT NULL THEN 1 ELSE 0 END) weather_rows,SUM(CASE WHEN home_plate_umpire_mlb_id IS NOT NULL OR home_plate_umpire_name IS NOT NULL THEN 1 ELSE 0 END) umpire_rows,AVG(quality_score) avg_quality,MAX(official_date) complete_through FROM game_context_snapshots`).first<Record<string,unknown>>();
  return json({release:'3.7',build:'8.1.2',state,summary,rows,research_only:true,production_models_changed:false});
}
async function runStatcastReplayDate(request:Request,env:Env):Promise<Response>{const body=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));const ctx=await getStatcastBackfillContext(env);if(!ctx)return json({error:'No completed walk-forward-v2 run found.'},{status:404});const cert=await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_backfill_certifications WHERE backtest_run_id=? AND certification_status='RESEARCH_CERTIFIED'`).bind(ctx.runId).first<{n:number}>();if(Number(cert?.n||0)<=0)return json({error:'Statcast backfill certification is not ready.'},{status:409});let run=await env.DB.prepare(`SELECT * FROM statcast_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? AND replay_version='statcast-challenger-replay-v1' ORDER BY statcast_replay_run_id DESC LIMIT 1`).bind(ctx.runId,ctx.buildId).first<Record<string,unknown>>();if(!run){const x=await env.DB.prepare(`INSERT INTO statcast_challenger_replay_runs(run_uuid,backtest_run_id,backtest_dataset_build_id,replay_version,status) VALUES(?,?,?,'statcast-challenger-replay-v1','RUNNING')`).bind(crypto.randomUUID(),ctx.runId,ctx.buildId).run();run={statcast_replay_run_id:Number(x.meta.last_row_id)};}const runId=Number(run.statcast_replay_run_id),dates=await statcastReplayDates(env,ctx.runId);let date=String(body.date||'');if(!date){const done=(await env.DB.prepare(`SELECT board_date FROM statcast_challenger_replay_dates WHERE statcast_replay_run_id=? AND status IN ('SKIPPED','EXECUTED')`).bind(runId).all<{board_date:string}>()).results??[];const ds=new Set(done.map(x=>String(x.board_date)));date=dates.find(d=>!ds.has(d))||'';}if(!date){await env.DB.prepare(`UPDATE statcast_challenger_replay_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP WHERE statcast_replay_run_id=?`).bind(runId).run();return json({ok:true,done:true,statcast_replay_run_id:runId});}
const q=`SELECT r.backtest_dataset_row_id,r.board_date,r.pitcher_id,p.mlb_id pitcher_mlb_id,r.pitcher_hand,r.prop_line,r.projected_strikeouts,r.model_edge,r.preferred_side,r.preferred_outcome,r.more_outcome,r.less_outcome,r.raw_more_probability,r.calibrated_more_probability,s.whiff_rate,s.swinging_strike_rate,s.csw_rate,s.chase_rate,s.avg_fastball_velocity,s.velocity_delta_30d,s.avg_fastball_spin,s.games_lookback,s.pitches_lookback,s.feature_quality_score,s.pitch_mix_json FROM backtest_dataset_rows_v3 r JOIN pitchers p ON p.pitcher_id=r.pitcher_id JOIN statcast_backfill_certifications c ON c.backtest_run_id=? AND c.feature_date=r.board_date AND c.pitcher_mlb_id=p.mlb_id AND c.certification_status='RESEARCH_CERTIFIED' JOIN statcast_pitcher_daily_features s ON s.feature_date=r.board_date AND s.pitcher_mlb_id=p.mlb_id WHERE r.backtest_dataset_build_id=? AND r.backtest_eligible=1`;
const train=(await env.DB.prepare(q+` AND r.board_date<? AND r.more_outcome IN ('WIN','LOSS') ORDER BY r.board_date,r.backtest_dataset_row_id`).bind(ctx.runId,ctx.buildId,date).all<StatcastReplayRow>()).results??[];const fold=await env.DB.prepare(`SELECT backtest_fold_id FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' AND test_date_min=? LIMIT 1`).bind(ctx.runId,date).first<{backtest_fold_id:number}>();if(!fold)return json({error:'Executed fold not found.'},{status:404});const tests=(await env.DB.prepare(q+` AND r.backtest_dataset_row_id IN (SELECT backtest_dataset_row_id FROM backtest_fold_rows_v3 WHERE backtest_fold_id=? AND partition='TEST') AND r.more_outcome IN ('WIN','LOSS') ORDER BY r.backtest_dataset_row_id`).bind(ctx.runId,ctx.buildId,fold.backtest_fold_id).all<StatcastReplayRow>()).results??[];const model=trainStatcastReplay(train);if(!model){await env.DB.prepare(`INSERT OR REPLACE INTO statcast_challenger_replay_dates(statcast_replay_run_id,board_date,status,train_rows,test_rows,details_json,completed_at) VALUES(?,?,'SKIPPED',?,?,?,CURRENT_TIMESTAMP)`).bind(runId,date,train.length,tests.length,JSON.stringify({reason:'need_80_prior_certified_rows'})).run();return json({ok:true,date,status:'SKIPPED',train_rows:train.length,test_rows:tests.length});}
let wins=0,losses=0,disagreements=0,improved=0,harmed=0;for(const r of tests){const pMore=predictStatcastReplay(model,r),challengerSide=pMore>=.5?'MORE':'LESS',challengerProb=challengerSide==='MORE'?pMore:1-pMore,baselineSide=String(r.preferred_side||'').toUpperCase(),baselineOutcome=String(r.preferred_outcome||'').toUpperCase(),challengerOutcome=String(challengerSide==='MORE'?r.more_outcome:r.less_outcome).toUpperCase(),baselineHit=baselineOutcome==='WIN'?1:baselineOutcome==='LOSS'?0:null,challengerHit=challengerOutcome==='WIN'?1:challengerOutcome==='LOSS'?0:null,disagreement=baselineSide!==challengerSide?1:0;if(challengerHit===1)wins++;else if(challengerHit===0)losses++;if(disagreement){disagreements++;if(challengerHit===1&&baselineHit===0)improved++;if(challengerHit===0&&baselineHit===1)harmed++;}await env.DB.prepare(`INSERT OR REPLACE INTO statcast_challenger_replay_rows(statcast_replay_run_id,backtest_dataset_row_id,board_date,pitcher_id,pitcher_mlb_id,pitcher_hand,prop_line,model_edge,baseline_side,baseline_outcome,baseline_hit,challenger_side,challenger_probability,challenger_outcome,challenger_hit,challenger_play,disagreement,feature_quality_score,games_lookback,pitches_lookback,whiff_rate,swinging_strike_rate,csw_rate,chase_rate,avg_fastball_velocity,velocity_delta_30d,avg_fastball_spin,fastball_mix_share,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(runId,r.backtest_dataset_row_id,date,r.pitcher_id,r.pitcher_mlb_id,r.pitcher_hand,r.prop_line,r.model_edge,baselineSide,baselineOutcome,baselineHit,challengerSide,challengerProb,challengerOutcome,challengerHit,challengerProb>=.55?1:0,disagreement,r.feature_quality_score,r.games_lookback,r.pitches_lookback,r.whiff_rate,r.swinging_strike_rate,r.csw_rate,r.chase_rate,r.avg_fastball_velocity,r.velocity_delta_30d,r.avg_fastball_spin,statcastMixShare(r.pitch_mix_json),JSON.stringify({model:'prior-only-ridge-logistic-v1',train_rows:model.train_rows,lambda:model.lambda,features:model.feature_names})).run();}
await env.DB.prepare(`INSERT OR REPLACE INTO statcast_challenger_replay_dates(statcast_replay_run_id,board_date,status,train_rows,test_rows,wins,losses,disagreements,improved,harmed,details_json,completed_at) VALUES(?,?,'EXECUTED',?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(runId,date,model.train_rows,tests.length,wins,losses,disagreements,improved,harmed,JSON.stringify({anti_lookahead:'training rows board_date strictly before target date',certification:'RESEARCH_CERTIFIED only'})).run();const completed=Number((await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_challenger_replay_dates WHERE statcast_replay_run_id=?`).bind(runId).first<{n:number}>())?.n||0),done=completed>=dates.length;await env.DB.prepare(`UPDATE statcast_challenger_replay_runs SET status=?,dates_completed=?,rows_scored=(SELECT COUNT(*) FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=?),completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,details_json=? WHERE statcast_replay_run_id=?`).bind(done?'SUCCEEDED':'RUNNING',completed,runId,done?1:0,JSON.stringify({latest_date:date,total_dates:dates.length,production_models_changed:false}),runId).run();return json({ok:true,date,status:'EXECUTED',train_rows:model.train_rows,test_rows:tests.length,wins,losses,hit_rate:wins+losses?wins/(wins+losses):null,disagreements,improved,harmed,dates_completed:completed,total_dates:dates.length,done});}
async function getStatcastChallengerReplay(env:Env):Promise<Response>{const ctx=await getStatcastBackfillContext(env);if(!ctx)return json({run:null});const run=await env.DB.prepare(`SELECT * FROM statcast_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? ORDER BY statcast_replay_run_id DESC LIMIT 1`).bind(ctx.runId,ctx.buildId).first<Record<string,unknown>>();const dates=await statcastReplayDates(env,ctx.runId);if(!run)return json({release:'3.6',build:'7.5.2',run:null,total_dates:dates.length,certified_rows:(await env.DB.prepare(`SELECT COUNT(*) n FROM statcast_backfill_certifications WHERE backtest_run_id=? AND certification_status='RESEARCH_CERTIFIED'`).bind(ctx.runId).first<{n:number}>())?.n||0,production_models_changed:false});const id=Number(run.statcast_replay_run_id);const summary=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(CASE WHEN baseline_hit=1 THEN 1 ELSE 0 END) baseline_wins,SUM(CASE WHEN baseline_hit=0 THEN 1 ELSE 0 END) baseline_losses,SUM(CASE WHEN challenger_hit=1 THEN 1 ELSE 0 END) challenger_wins,SUM(CASE WHEN challenger_hit=0 THEN 1 ELSE 0 END) challenger_losses,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND challenger_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 THEN 1 ELSE 0 END) disagreement_wins,SUM(challenger_play) plays,SUM(CASE WHEN challenger_play=1 AND challenger_hit=1 THEN 1 ELSE 0 END) play_wins,AVG(challenger_probability) avg_probability,AVG(feature_quality_score) avg_quality FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=?`).bind(id).first<Record<string,unknown>>();const months=(await env.DB.prepare(`SELECT substr(board_date,1,7) bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(challenger_hit) challenger_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 THEN 1 ELSE 0 END) disagreement_wins FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=? GROUP BY substr(board_date,1,7) ORDER BY bucket`).bind(id).all<Record<string,unknown>>()).results??[];const sides=(await env.DB.prepare(`SELECT baseline_side bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(challenger_hit) challenger_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 THEN 1 ELSE 0 END) disagreement_wins FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=? GROUP BY baseline_side ORDER BY bucket`).bind(id).all<Record<string,unknown>>()).results??[];const quality=(await env.DB.prepare(`SELECT CASE WHEN feature_quality_score<60 THEN '<60' WHEN feature_quality_score<75 THEN '60-74' WHEN feature_quality_score<90 THEN '75-89' ELSE '90-100' END bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(challenger_hit) challenger_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 THEN 1 ELSE 0 END) disagreement_wins FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=? GROUP BY bucket ORDER BY MIN(feature_quality_score)`).bind(id).all<Record<string,unknown>>()).results??[];const velo=(await env.DB.prepare(`SELECT CASE WHEN velocity_delta_30d<=-1 THEN '<=-1.0' WHEN velocity_delta_30d<-.3 THEN '-1.0 to -0.3' WHEN velocity_delta_30d<=.3 THEN '-0.3 to +0.3' WHEN velocity_delta_30d<1 THEN '+0.3 to +1.0' ELSE '>=+1.0' END bucket,COUNT(*) n,SUM(baseline_hit) baseline_wins,SUM(challenger_hit) challenger_wins,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 THEN 1 ELSE 0 END) disagreement_wins FROM statcast_challenger_replay_rows WHERE statcast_replay_run_id=? AND velocity_delta_30d IS NOT NULL GROUP BY bucket ORDER BY MIN(velocity_delta_30d)`).bind(id).all<Record<string,unknown>>()).results??[];const recent=(await env.DB.prepare(`SELECT r.*,p.canonical_name pitcher_name FROM statcast_challenger_replay_rows r JOIN pitchers p ON p.pitcher_id=r.pitcher_id WHERE r.statcast_replay_run_id=? ORDER BY r.board_date DESC,r.statcast_replay_row_id DESC LIMIT 80`).bind(id).all<Record<string,unknown>>()).results??[];const done=(await env.DB.prepare(`SELECT board_date,status,train_rows,test_rows,wins,losses,disagreements,improved,harmed FROM statcast_challenger_replay_dates WHERE statcast_replay_run_id=? ORDER BY board_date`).bind(id).all<Record<string,unknown>>()).results??[];const ds=new Set(done.map(x=>String(x.board_date)));return json({release:'3.6',build:'7.5.2',replay_version:'statcast-challenger-replay-v1',run,summary,months,sides,quality,velocity:velo,recent,dates:done,total_dates:dates.length,next_date:dates.find(d=>!ds.has(d))||null,anti_lookahead:'Statcast features certified game_date < feature_date; challenger training rows board_date strictly before target date.',research_only:true,production_models_changed:false});}


type ContextBackfillContext={runId:number;buildId:number;dates:string[]};
async function getContextBackfillContext(env:Env):Promise<ContextBackfillContext|null>{
  const run=await env.DB.prepare(`SELECT backtest_run_id,backtest_dataset_build_id FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<{backtest_run_id:number;backtest_dataset_build_id:number}>();
  if(!run)return null;
  const rows=(await env.DB.prepare(`SELECT DISTINCT test_date_min d FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' ORDER BY test_date_min`).bind(run.backtest_run_id).all<{d:string}>()).results??[];
  const dates=rows.map(r=>String(r.d)).filter(statcastDateOk);
  return dates.length?{runId:Number(run.backtest_run_id),buildId:Number(run.backtest_dataset_build_id),dates}:null;
}

async function certifyContextBackfillDate(env:Env,ctx:ContextBackfillContext,date:string):Promise<{processed:number;certified:number;excluded:number}> {
  const rows=(await env.DB.prepare(`
    SELECT DISTINCT
      r.backtest_dataset_row_id,
      r.prop_id,
      r.board_date,
      r.pitcher_id,
      pit.mlb_id AS pitcher_mlb_id,
      r.historical_archive_prop_id,
      hap.team_abbreviation,
      hap.opponent_abbreviation,
      hap.pitcher_name AS archive_pitcher_name,
      hap.source_url AS archive_source_url
    FROM backtest_folds f
    JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST'
    JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id
    LEFT JOIN pitchers pit ON pit.pitcher_id=r.pitcher_id
    LEFT JOIN historical_archive_props hap ON hap.historical_archive_prop_id=r.historical_archive_prop_id
    WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND f.test_date_min=?
    ORDER BY r.backtest_dataset_row_id
  `).bind(ctx.runId,date).all<{backtest_dataset_row_id:number;prop_id:number|null;board_date:string;pitcher_id:number|null;pitcher_mlb_id:number|null;historical_archive_prop_id:number|null;team_abbreviation:string|null;opponent_abbreviation:string|null;archive_pitcher_name:string|null;archive_source_url:string|null}>()).results??[];

  const snaps=(await env.DB.prepare(`SELECT game_context_snapshot_id,mlb_game_pk,quality_score,temperature_f,weather_condition,wind_text,home_plate_umpire_mlb_id,home_plate_umpire_name,captured_at,source_mode,details_json FROM game_context_snapshots WHERE official_date=? AND source_mode='HISTORICAL_BACKFILL' ORDER BY game_context_snapshot_id DESC`).bind(date).all<Record<string,unknown>>()).results??[];
  const matchupMap=new Map<string,Record<string,unknown>[]>();
  for(const snap of snaps){
    let d:any={};try{d=JSON.parse(String(snap.details_json??'{}'));}catch{}
    const away=String(d?.teams?.away?.abbreviation??'').toUpperCase();
    const home=String(d?.teams?.home?.abbreviation??'').toUpperCase();
    if(!away||!home)continue;
    const key=[away,home].sort().join('|');
    const arr=matchupMap.get(key)??[];arr.push(snap);matchupMap.set(key,arr);
  }

  const opponentSets=new Map<string,Set<string>>();
  for(const r of rows){
    const k=`${r.pitcher_id??'null'}|${r.board_date}`;
    const set=opponentSets.get(k)??new Set<string>();
    const opp=String(r.opponent_abbreviation??'').toUpperCase();if(opp)set.add(opp);opponentSets.set(k,set);
  }

  let processed=0,certified=0,excluded=0;
  for(const r of rows){
    const team=String(r.team_abbreviation??'').toUpperCase();
    const opp=String(r.opponent_abbreviation??'').toUpperCase();
    const key=team&&opp?[team,opp].sort().join('|'):'';
    const candidates=key?(matchupMap.get(key)??[]):[];
    const pitcherDateKey=`${r.pitcher_id??'null'}|${r.board_date}`;
    const conflictingOpponents=(opponentSets.get(pitcherDateKey)?.size??0)>1;
    const snap=!conflictingOpponents&&candidates.length===1?candidates[0]:null;
    const reasons:string[]=[];
    if(!team||!opp)reasons.push('missing_archive_matchup');
    if(conflictingOpponents)reasons.push('ambiguous_pitcher_date_multiple_opponents');
    if(!conflictingOpponents&&key&&candidates.length===0)reasons.push('missing_context_matchup');
    if(!conflictingOpponents&&candidates.length>1)reasons.push('ambiguous_context_matchup');
    const q=Number(snap?.quality_score??0);
    const weather=!!snap&&(snap.temperature_f!=null||snap.weather_condition!=null||snap.wind_text!=null);
    const umpire=!!snap&&(snap.home_plate_umpire_mlb_id!=null||snap.home_plate_umpire_name!=null);
    if(snap&&q<65)reasons.push('context_quality_below_65');
    if(snap&&!weather)reasons.push('weather_missing');
    if(snap&&!umpire)reasons.push('umpire_missing');
    const status=reasons.length?'EXCLUDED':'RECONSTRUCTED_CERTIFIED';
    await env.DB.prepare(`INSERT INTO game_context_backfill_certifications(backtest_run_id,backtest_dataset_build_id,backtest_dataset_row_id,board_date,prop_id,mlb_game_pk,game_context_snapshot_id,certification_status,quality_score,weather_available,umpire_available,provenance,reasons_json,evidence_json,certified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',?,?,CURRENT_TIMESTAMP) ON CONFLICT(backtest_run_id,backtest_dataset_row_id) DO UPDATE SET mlb_game_pk=excluded.mlb_game_pk,game_context_snapshot_id=excluded.game_context_snapshot_id,certification_status=excluded.certification_status,quality_score=excluded.quality_score,weather_available=excluded.weather_available,umpire_available=excluded.umpire_available,provenance=excluded.provenance,reasons_json=excluded.reasons_json,evidence_json=excluded.evidence_json,certified_at=CURRENT_TIMESTAMP`).bind(ctx.runId,ctx.buildId,r.backtest_dataset_row_id,date,r.prop_id??null,snap?.mlb_game_pk??null,snap?.game_context_snapshot_id??null,status,q,weather?1:0,umpire?1:0,JSON.stringify(reasons),JSON.stringify({source_mode:snap?.source_mode??null,captured_at:snap?.captured_at??null,retrospective_reconstruction:true,allowed_fields:['venue','day_night','temperature','condition','wind','home_plate_umpire'],postgame_outcomes_used:false,mapping_version:'archive-matchup-v3',mapping_source:'HISTORICAL_ARCHIVE_MATCHUP',historical_archive_prop_id:r.historical_archive_prop_id??null,archive_pitcher_name:r.archive_pitcher_name??null,archive_source_url:r.archive_source_url??null,team_abbreviation:team||null,opponent_abbreviation:opp||null,pitcher_id:r.pitcher_id??null,pitcher_mlb_id:r.pitcher_mlb_id??null,conflicting_pitcher_date_opponents:conflictingOpponents,candidate_context_games:candidates.map(x=>x.mlb_game_pk)})).run();
    processed++; if(status==='RECONSTRUCTED_CERTIFIED')certified++; else excluded++;
  }
  return {processed,certified,excluded};
}

async function runContextBackfillBatch(request:Request,env:Env):Promise<Response>{
  const ctx=await getContextBackfillContext(env);if(!ctx)return json({error:'No completed walk-forward-v2 run found.'},{status:404});
  const body=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
  const states=(await env.DB.prepare(`SELECT calendar_date,status,games_processed,total_games FROM game_context_backfill_dates ORDER BY calendar_date`).all<Record<string,unknown>>()).results??[];
  const stateMap=new Map(states.map(x=>[String(x.calendar_date),x]));
  const repairRows=(await env.DB.prepare(`SELECT DISTINCT d.calendar_date FROM game_context_backfill_dates d WHERE d.status='COMPLETE' AND d.calendar_date>=? AND d.calendar_date<=? AND (EXISTS(SELECT 1 FROM game_context_snapshots s WHERE s.official_date=d.calendar_date AND s.source_mode='HISTORICAL_BACKFILL' AND (json_extract(s.details_json,'$.teams.away.abbreviation') IS NULL OR json_extract(s.details_json,'$.teams.home.abbreviation') IS NULL)) OR EXISTS(SELECT 1 FROM game_context_backfill_certifications c WHERE c.backtest_run_id=? AND c.board_date=d.calendar_date AND c.evidence_json NOT LIKE '%archive-matchup-v3%')) ORDER BY d.calendar_date`).bind(ctx.dates[0],ctx.dates.at(-1),ctx.runId).all<{calendar_date:string}>()).results??[];
  const repairDate=repairRows.length?String(repairRows[0].calendar_date):'';
  let date=String(body.date||'');
  if(!date)date=repairDate||ctx.dates.find(d=>String(stateMap.get(d)?.status??'')!=='COMPLETE')||'';
  if(!date)return json({release:'3.7',build:'8.2.4',status:'DONE',done:true,production_models_changed:false});
  if(!ctx.dates.includes(date))return json({error:'Date is not an executed walk-forward TEST date.'},{status:400});
  let prior=stateMap.get(date);let offset=Math.max(0,Number(body.offset??prior?.games_processed??0));
  if(date===repairDate && String(prior?.status??'')==='COMPLETE' && body.offset==null){
    await env.DB.prepare(`UPDATE game_context_backfill_dates SET status='REPAIRING',games_processed=0,snapshots_stored=0,weather_rows=0,umpire_rows=0,error_count=0,last_error=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE calendar_date=?`).bind(date).run();
    prior={...prior,status:'REPAIRING',games_processed:0};offset=0;
  }
  const limit=Math.max(1,Math.min(4,Number(body.limit??4)));
  const schedUrl=new URL('https://statsapi.mlb.com/api/v1/schedule');schedUrl.searchParams.set('sportId','1');schedUrl.searchParams.set('date',date);
  try{
    const schedule=await fetchMlbJson(schedUrl.toString());const allGames=((schedule as any)?.dates??[]).flatMap((d:any)=>Array.isArray(d.games)?d.games:[]);const games=allGames.slice(offset,offset+limit);
    const run=await env.DB.prepare(`INSERT INTO sync_runs(run_uuid,source_name,dataset_name,sync_mode,trigger_source,status,source_cursor_start,source_cursor_end) VALUES(?,'MLB_STATS_API','GAME_CONTEXT_BACKFILL','BACKFILL','ADMIN','RUNNING',?,?)`).bind(crypto.randomUUID(),`${date}:${offset}`,`${date}:${Math.max(offset,offset+games.length-1)}`).run();
    const syncRunId=Number(run.meta.last_row_id);let stored=0,weather=0,umpires=0,errors=0,requests=1;
    for(const g of games){const gamePk=Number(g?.gamePk??0);if(!gamePk)continue;try{
      const feed=await fetchMlbJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);requests++;
      const gd=(feed as any)?.gameData??{},weatherObj=gd?.weather??{},venue=gd?.venue??{};const officials=(feed as any)?.liveData?.boxscore?.officials??gd?.officials??[];const hp=officials.find((o:any)=>String(o?.officialType??'').toLowerCase().includes('home plate'))??null;
      const awayTeam=gd?.teams?.away??g?.teams?.away?.team??{};const homeTeam=gd?.teams?.home??g?.teams?.home?.team??{};
      const teams={away:{mlb_id:Number(awayTeam?.id)||null,abbreviation:String(awayTeam?.abbreviation??'')||null,name:String(awayTeam?.name??'')||null},home:{mlb_id:Number(homeTeam?.id)||null,abbreviation:String(homeTeam?.abbreviation??'')||null,name:String(homeTeam?.name??'')||null}};
      const wind=String(weatherObj?.wind??'')||null,temp=Number(weatherObj?.temp),humidity=Number(weatherObj?.humidity);const canonical=JSON.stringify({gamePk,date,temp:Number.isFinite(temp)?temp:null,condition:weatherObj?.condition??null,wind,humidity:Number.isFinite(humidity)?humidity:null,venue:venue?.name??g?.venue?.name??null,dayNight:gd?.datetime?.dayNight??g?.dayNight??null,umpire:hp?.official?.id??null,source_mode:'HISTORICAL_BACKFILL'});const hash=await contextSha256(canonical);let quality=20;if(Number.isFinite(temp)||weatherObj?.condition||wind)quality+=35;if(hp?.official?.id||hp?.official?.fullName)quality+=30;if(venue?.name||g?.venue?.name)quality+=10;if(gd?.datetime?.dateTime||g?.gameDate)quality+=5;
      await env.DB.prepare(`INSERT INTO game_context_snapshots(mlb_game_pk,official_date,captured_at,scheduled_start,venue_id,venue_name,day_night,temperature_f,weather_condition,wind_text,wind_speed_mph,humidity_pct,home_plate_umpire_mlb_id,home_plate_umpire_name,source_name,source_mode,payload_hash,quality_score,details_json,sync_run_id) VALUES(?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mlb_game_pk,payload_hash) DO UPDATE SET captured_at=CURRENT_TIMESTAMP,quality_score=excluded.quality_score,details_json=excluded.details_json,sync_run_id=excluded.sync_run_id`).bind(gamePk,date,String(gd?.datetime?.dateTime??g?.gameDate??'')||null,Number(venue?.id)||null,String(venue?.name??g?.venue?.name??'')||null,String(gd?.datetime?.dayNight??g?.dayNight??'')||null,Number.isFinite(temp)?temp:null,String(weatherObj?.condition??'')||null,wind,contextWindSpeed(wind),Number.isFinite(humidity)?humidity:null,Number(hp?.official?.id)||null,String(hp?.official?.fullName??'')||null,'MLB_STATS_API','HISTORICAL_BACKFILL',hash,quality,JSON.stringify({retrospective_reconstruction:true,game_status:gd?.status?.detailedState??g?.status?.detailedState??null,teams,weather:weatherObj,venue}),syncRunId).run();stored++;if(Number.isFinite(temp)||weatherObj?.condition||wind)weather++;if(hp?.official?.id||hp?.official?.fullName)umpires++;
    }catch(e){errors++;await env.DB.prepare(`INSERT INTO sync_errors(sync_run_id,error_stage,error_code,error_message,source_record_key) VALUES(?,'CONTEXT_BACKFILL_GAME','GAME_FETCH',?,?)`).bind(syncRunId,e instanceof Error?e.message:String(e),String(gamePk)).run().catch(()=>null);}}
    const nextOffset=Math.min(allGames.length,offset+games.length),done=nextOffset>=allGames.length;
    await env.DB.prepare(`UPDATE sync_runs SET status=?,completed_at=CURRENT_TIMESTAMP,rows_read=?,rows_inserted=?,request_count=?,details_json=? WHERE sync_run_id=?`).bind(errors>0&&stored===0?'FAILED':errors>0?'PARTIAL':'SUCCEEDED',games.length,stored,requests,JSON.stringify({date,offset,limit,total_games:allGames.length,stored,weather,umpires,errors,done,next_offset:nextOffset,source_mode:'HISTORICAL_BACKFILL',matchup_metadata:'teams-v1'}),syncRunId).run();
    const actual=await env.DB.prepare(`SELECT COUNT(*) snapshots,SUM(CASE WHEN temperature_f IS NOT NULL OR weather_condition IS NOT NULL OR wind_text IS NOT NULL THEN 1 ELSE 0 END) weather_rows,SUM(CASE WHEN home_plate_umpire_mlb_id IS NOT NULL OR home_plate_umpire_name IS NOT NULL THEN 1 ELSE 0 END) umpire_rows FROM game_context_snapshots WHERE official_date=? AND source_mode='HISTORICAL_BACKFILL'`).bind(date).first<Record<string,unknown>>();
    await env.DB.prepare(`INSERT INTO game_context_backfill_dates(calendar_date,status,total_games,games_processed,snapshots_stored,weather_rows,umpire_rows,error_count,last_error,attempted_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP,CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP) ON CONFLICT(calendar_date) DO UPDATE SET status=excluded.status,total_games=excluded.total_games,games_processed=excluded.games_processed,snapshots_stored=excluded.snapshots_stored,weather_rows=excluded.weather_rows,umpire_rows=excluded.umpire_rows,error_count=game_context_backfill_dates.error_count+excluded.error_count,last_error=NULL,attempted_at=CURRENT_TIMESTAMP,completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE game_context_backfill_dates.completed_at END,updated_at=CURRENT_TIMESTAMP`).bind(date,done?'COMPLETE':'RUNNING',allGames.length,nextOffset,Number(actual?.snapshots??0),Number(actual?.weather_rows??0),Number(actual?.umpire_rows??0),errors,done?1:0,done?1:0).run();
    let certification=null;if(done)certification=await certifyContextBackfillDate(env,ctx,date);
    return json({release:'3.7',build:'8.2.4',date,offset,next_offset:nextOffset,total_games:allGames.length,stored,weather,umpires,errors,done,repair:date===repairDate,certification,production_models_changed:false});
  }catch(e){const msg=e instanceof Error?e.message:String(e);await env.DB.prepare(`INSERT INTO game_context_backfill_dates(calendar_date,status,last_error,attempted_at,updated_at) VALUES(?,'FAILED',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(calendar_date) DO UPDATE SET status='FAILED',last_error=excluded.last_error,attempted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(date,msg).run().catch(()=>null);return json({error:msg,date},{status:500});}
}

async function getContextBackfillStatus(env:Env):Promise<Response>{
  const ctx=await getContextBackfillContext(env);if(!ctx)return json({release:'3.7',build:'8.2.4',message:'No completed walk-forward-v2 run found.',production_models_changed:false});
  const rows=(await env.DB.prepare(`SELECT * FROM game_context_backfill_dates WHERE calendar_date>=? AND calendar_date<=? ORDER BY calendar_date`).bind(ctx.dates[0],ctx.dates.at(-1)).all<Record<string,unknown>>()).results??[];const m=new Map(rows.map(r=>[String(r.calendar_date),r]));
  const complete=ctx.dates.filter(d=>String(m.get(d)?.status??'')==='COMPLETE');const failed=rows.filter(r=>String(r.status)==='FAILED');
  const repairRows=(await env.DB.prepare(`SELECT DISTINCT d.calendar_date FROM game_context_backfill_dates d WHERE d.status='COMPLETE' AND d.calendar_date>=? AND d.calendar_date<=? AND (EXISTS(SELECT 1 FROM game_context_snapshots s WHERE s.official_date=d.calendar_date AND s.source_mode='HISTORICAL_BACKFILL' AND (json_extract(s.details_json,'$.teams.away.abbreviation') IS NULL OR json_extract(s.details_json,'$.teams.home.abbreviation') IS NULL)) OR EXISTS(SELECT 1 FROM game_context_backfill_certifications c WHERE c.backtest_run_id=? AND c.board_date=d.calendar_date AND c.evidence_json NOT LIKE '%archive-matchup-v3%')) ORDER BY d.calendar_date`).bind(ctx.dates[0],ctx.dates.at(-1),ctx.runId).all<{calendar_date:string}>()).results??[];
  const repairDate=repairRows.length?String(repairRows[0].calendar_date):null;
  const next=repairDate||ctx.dates.find(d=>String(m.get(d)?.status??'')!=='COMPLETE')||null;
  const cert=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(CASE WHEN certification_status='RECONSTRUCTED_CERTIFIED' THEN 1 ELSE 0 END) certified,SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded,COUNT(DISTINCT board_date) dates,AVG(quality_score) avg_quality,SUM(weather_available) weather_rows,SUM(umpire_available) umpire_rows FROM game_context_backfill_certifications WHERE backtest_run_id=?`).bind(ctx.runId).first<Record<string,unknown>>();
  const recent=(await env.DB.prepare(`SELECT board_date,certification_status,quality_score,weather_available,umpire_available,reasons_json FROM game_context_backfill_certifications WHERE backtest_run_id=? ORDER BY board_date DESC,context_certification_id DESC LIMIT 40`).bind(ctx.runId).all<Record<string,unknown>>()).results??[];
  return json({release:'3.7',build:'8.2.4',mode:'HISTORICAL_CONTEXT_BACKFILL',backtest_run_id:ctx.runId,dataset_build_id:ctx.buildId,range:{start:ctx.dates[0],end:ctx.dates.at(-1)},dates:{required:ctx.dates.length,complete:complete.length,failed:failed.length,next_date:next,repair_date:repairDate,recent:rows.slice(-20).reverse()},certification:{rows:Number(cert?.rows??0),certified:Number(cert?.certified??0),excluded:Number(cert?.excluded??0),dates:Number(cert?.dates??0),avg_quality:cert?.avg_quality==null?null:Number(cert.avg_quality),weather_rows:Number(cert?.weather_rows??0),umpire_rows:Number(cert?.umpire_rows??0),recent},done:complete.length>=ctx.dates.length&&!repairDate,provenance:'Historical MLB Stats API retrospective reconstruction; research replay only. No postgame outcome fields are used as context features.',production_models_changed:false});
}


type ContextFeatureRow={
  context_certification_id:number;backtest_run_id:number;backtest_dataset_build_id:number;backtest_dataset_row_id:number;board_date:string;certification_status:string;cert_quality_score:number;weather_available:number;umpire_available:number;reasons_json:string;game_context_snapshot_id:number|null;mlb_game_pk:number|null;
  venue_id:number|null;venue_name:string|null;day_night:string|null;temperature_f:number|null;weather_condition:string|null;wind_text:string|null;wind_speed_mph:number|null;humidity_pct:number|null;home_plate_umpire_mlb_id:number|null;home_plate_umpire_name:string|null;source_mode:string|null;details_json:string|null;
};

function contextWeatherGroup(condition:unknown):string{
  const x=String(condition??'').toLowerCase();
  if(!x)return 'UNKNOWN';
  if(x.includes('roof closed'))return 'ROOF_CLOSED';
  if(/rain|drizzle|shower|thunder|storm/.test(x))return 'WET';
  if(/snow|sleet|ice/.test(x))return 'WINTER';
  if(/clear|sunny/.test(x))return 'CLEAR';
  if(/cloud|overcast/.test(x))return 'CLOUDY';
  return 'OTHER';
}
function contextWindGroup(windText:unknown,windSpeed:unknown):string{
  const x=String(windText??'').toLowerCase();const speed=Number(windSpeed);
  if((Number.isFinite(speed)&&speed===0)||x.includes('calm')||x.includes('none'))return 'CALM';
  if(x.includes('out to'))return 'OUT';
  if(x.includes('in from'))return 'IN';
  if(x.includes('l to r')||x.includes('r to l')||x.includes('cross'))return 'CROSS';
  if(x.includes('varies')||x.includes('variable'))return 'VARIABLE';
  return x?'OTHER':'UNKNOWN';
}
function contextFeaturePayload(r:ContextFeatureRow){
  let d:any={};try{d=JSON.parse(String(r.details_json??'{}'));}catch{}
  const roofType=String(d?.venue?.fieldInfo?.roofType??'')||null;
  const weatherGroup=contextWeatherGroup(r.weather_condition);
  const windGroup=contextWindGroup(r.wind_text,r.wind_speed_mph);
  const isNight=String(r.day_night??'').toLowerCase()==='night'?1:0;
  const isRoofClosed=weatherGroup==='ROOF_CLOSED'?1:0;
  const temp=Number(r.temperature_f);const tempDelta=Number.isFinite(temp)?Math.round((temp-70)*1000)/1000:null;
  const sourceCertified=String(r.certification_status)==='RECONSTRUCTED_CERTIFIED'&&r.game_context_snapshot_id!=null;
  const featureStatus=sourceCertified?'FEATURE_READY':'SOURCE_EXCLUDED';
  const quality=sourceCertified?Math.max(0,Math.min(100,Number(r.cert_quality_score)||0)):0;
  const flags:string[]=[];
  if(!sourceCertified)flags.push('source_not_reconstructed_certified');
  if(sourceCertified&&!r.venue_name)flags.push('venue_missing');
  if(sourceCertified&&!r.day_night)flags.push('day_night_missing');
  if(sourceCertified&&!r.weather_available)flags.push('weather_missing');
  if(sourceCertified&&!r.umpire_available)flags.push('umpire_missing');
  const provenance={
    class:'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',
    promotion_eligible:false,
    native_pregame_snapshot:false,
    structural_fields:['venue_id','venue_name','day_night','roof_type'],
    retrospective_observed_fields:['temperature_f','weather_condition','wind_text','wind_speed_mph'],
    retrospective_pregame_known_fields:['home_plate_umpire_mlb_id','home_plate_umpire_name'],
    postgame_outcomes_used:false
  };
  return {roofType,weatherGroup,windGroup,isNight,isRoofClosed,tempDelta,featureStatus,quality,flags,provenance};
}

async function buildHistoricalContextFeatures(request:Request,env:Env):Promise<Response>{
  const ctx=await getContextBackfillContext(env);if(!ctx)return json({error:'No completed walk-forward-v2 run found.'},{status:404});
  const body=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
  const limit=Math.max(1,Math.min(100,Number(body.limit??80)));
  const rows=(await env.DB.prepare(`SELECT c.context_certification_id,c.backtest_run_id,c.backtest_dataset_build_id,c.backtest_dataset_row_id,c.board_date,c.certification_status,c.quality_score cert_quality_score,c.weather_available,c.umpire_available,c.reasons_json,c.game_context_snapshot_id,c.mlb_game_pk,s.venue_id,s.venue_name,s.day_night,s.temperature_f,s.weather_condition,s.wind_text,s.wind_speed_mph,s.humidity_pct,s.home_plate_umpire_mlb_id,s.home_plate_umpire_name,s.source_mode,s.details_json FROM game_context_backfill_certifications c LEFT JOIN game_context_snapshots s ON s.game_context_snapshot_id=c.game_context_snapshot_id WHERE c.backtest_run_id=? AND NOT EXISTS(SELECT 1 FROM historical_context_features f WHERE f.backtest_run_id=c.backtest_run_id AND f.backtest_dataset_row_id=c.backtest_dataset_row_id AND f.feature_version='context-v1') ORDER BY c.board_date,c.context_certification_id LIMIT ?`).bind(ctx.runId,limit).all<ContextFeatureRow>()).results??[];
  if(!rows.length){
    await env.DB.prepare(`INSERT INTO data_source_status(source_name,dataset_name,status,last_attempt_at,last_success_at,last_complete_through_at,expected_refresh_minutes,stale_after_minutes,consecutive_failures,record_count,status_message,metadata_json,updated_at) VALUES('FEATURE_STORE','HISTORICAL_CONTEXT_FEATURES','HEALTHY',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,1440,10080,0,(SELECT COUNT(*) FROM historical_context_features WHERE feature_version='context-v1'),'Build 8.3 context feature engineering complete.',?,CURRENT_TIMESTAMP) ON CONFLICT(source_name,dataset_name) DO UPDATE SET status='HEALTHY',last_attempt_at=CURRENT_TIMESTAMP,last_success_at=CURRENT_TIMESTAMP,last_complete_through_at=excluded.last_complete_through_at,record_count=excluded.record_count,status_message=excluded.status_message,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`).bind(ctx.dates.at(-1)??null,JSON.stringify({backtest_run_id:ctx.runId,feature_version:'context-v1',research_only:true})).run();
    return json({release:'3.7',build:'8.3',feature_version:'context-v1',processed:0,done:true,production_models_changed:false});
  }
  const stmts=[];let ready=0,excluded=0;
  for(const r of rows){
    const f=contextFeaturePayload(r);if(f.featureStatus==='FEATURE_READY')ready++;else excluded++;
    stmts.push(env.DB.prepare(`INSERT INTO historical_context_features(backtest_run_id,backtest_dataset_build_id,backtest_dataset_row_id,board_date,context_certification_id,game_context_snapshot_id,mlb_game_pk,feature_version,feature_status,venue_id,venue_name,roof_type,day_night,is_night,temperature_f,temperature_delta_70,weather_condition,weather_group,wind_text,wind_speed_mph,wind_direction_group,is_roof_closed,home_plate_umpire_mlb_id,home_plate_umpire_name,source_quality_score,feature_quality_score,promotion_eligible,provenance_class,quality_flags_json,feature_json,generated_at) VALUES(?,?,?,?,?,?,?,'context-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'HISTORICAL_RETROSPECTIVE_RECONSTRUCTION',?,?,CURRENT_TIMESTAMP) ON CONFLICT(backtest_run_id,backtest_dataset_row_id,feature_version) DO UPDATE SET context_certification_id=excluded.context_certification_id,game_context_snapshot_id=excluded.game_context_snapshot_id,mlb_game_pk=excluded.mlb_game_pk,feature_status=excluded.feature_status,venue_id=excluded.venue_id,venue_name=excluded.venue_name,roof_type=excluded.roof_type,day_night=excluded.day_night,is_night=excluded.is_night,temperature_f=excluded.temperature_f,temperature_delta_70=excluded.temperature_delta_70,weather_condition=excluded.weather_condition,weather_group=excluded.weather_group,wind_text=excluded.wind_text,wind_speed_mph=excluded.wind_speed_mph,wind_direction_group=excluded.wind_direction_group,is_roof_closed=excluded.is_roof_closed,home_plate_umpire_mlb_id=excluded.home_plate_umpire_mlb_id,home_plate_umpire_name=excluded.home_plate_umpire_name,source_quality_score=excluded.source_quality_score,feature_quality_score=excluded.feature_quality_score,promotion_eligible=0,provenance_class=excluded.provenance_class,quality_flags_json=excluded.quality_flags_json,feature_json=excluded.feature_json,generated_at=CURRENT_TIMESTAMP`).bind(ctx.runId,ctx.buildId,r.backtest_dataset_row_id,r.board_date,r.context_certification_id,r.game_context_snapshot_id??null,r.mlb_game_pk??null,f.featureStatus,r.venue_id??null,r.venue_name??null,f.roofType,r.day_night??null,f.isNight,r.temperature_f??null,f.tempDelta,r.weather_condition??null,f.weatherGroup,r.wind_text??null,r.wind_speed_mph??null,f.windGroup,f.isRoofClosed,r.home_plate_umpire_mlb_id??null,r.home_plate_umpire_name??null,Number(r.cert_quality_score)||0,f.quality,JSON.stringify(f.flags),JSON.stringify({feature_version:'context-v1',source_certification_status:r.certification_status,source_reasons:r.reasons_json,roof_type:f.roofType,weather_group:f.weatherGroup,wind_direction_group:f.windGroup,temperature_delta_70:f.tempDelta,provenance:f.provenance,raw:{venue_id:r.venue_id,venue_name:r.venue_name,day_night:r.day_night,temperature_f:r.temperature_f,weather_condition:r.weather_condition,wind_text:r.wind_text,wind_speed_mph:r.wind_speed_mph,home_plate_umpire_mlb_id:r.home_plate_umpire_mlb_id,home_plate_umpire_name:r.home_plate_umpire_name}})));
  }
  await env.DB.batch(stmts);
  const left=await env.DB.prepare(`SELECT COUNT(*) n FROM game_context_backfill_certifications c WHERE c.backtest_run_id=? AND NOT EXISTS(SELECT 1 FROM historical_context_features f WHERE f.backtest_run_id=c.backtest_run_id AND f.backtest_dataset_row_id=c.backtest_dataset_row_id AND f.feature_version='context-v1')`).bind(ctx.runId).first<{n:number}>();
  return json({release:'3.7',build:'8.3',feature_version:'context-v1',processed:rows.length,ready,excluded,remaining:Number(left?.n??0),done:Number(left?.n??0)===0,production_models_changed:false});
}

async function getHistoricalContextFeatureStatus(env:Env):Promise<Response>{
  const ctx=await getContextBackfillContext(env);if(!ctx)return json({release:'3.7',build:'8.3',message:'No completed walk-forward-v2 run found.',production_models_changed:false});
  const source=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(CASE WHEN certification_status='RECONSTRUCTED_CERTIFIED' THEN 1 ELSE 0 END) certified,SUM(CASE WHEN certification_status='EXCLUDED' THEN 1 ELSE 0 END) excluded FROM game_context_backfill_certifications WHERE backtest_run_id=?`).bind(ctx.runId).first<Record<string,unknown>>();
  const built=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(CASE WHEN feature_status='FEATURE_READY' THEN 1 ELSE 0 END) ready,SUM(CASE WHEN feature_status='SOURCE_EXCLUDED' THEN 1 ELSE 0 END) excluded,COUNT(DISTINCT board_date) dates,AVG(CASE WHEN feature_status='FEATURE_READY' THEN feature_quality_score END) avg_ready_quality,SUM(CASE WHEN feature_status='FEATURE_READY' AND weather_group!='UNKNOWN' THEN 1 ELSE 0 END) weather_classified,SUM(CASE WHEN feature_status='FEATURE_READY' AND wind_direction_group!='UNKNOWN' THEN 1 ELSE 0 END) wind_classified,SUM(CASE WHEN feature_status='FEATURE_READY' AND home_plate_umpire_mlb_id IS NOT NULL THEN 1 ELSE 0 END) umpire_identified FROM historical_context_features WHERE backtest_run_id=? AND feature_version='context-v1'`).bind(ctx.runId).first<Record<string,unknown>>();
  const total=Number(source?.rows??0),rows=Number(built?.rows??0);
  const recent=(await env.DB.prepare(`SELECT board_date,backtest_dataset_row_id,feature_status,venue_name,roof_type,day_night,temperature_f,weather_group,wind_direction_group,home_plate_umpire_name,feature_quality_score,quality_flags_json FROM historical_context_features WHERE backtest_run_id=? AND feature_version='context-v1' ORDER BY board_date DESC,context_feature_id DESC LIMIT 50`).bind(ctx.runId).all<Record<string,unknown>>()).results??[];
  const buckets=(await env.DB.prepare(`SELECT weather_group,COUNT(*) n FROM historical_context_features WHERE backtest_run_id=? AND feature_version='context-v1' AND feature_status='FEATURE_READY' GROUP BY weather_group ORDER BY n DESC`).bind(ctx.runId).all<Record<string,unknown>>()).results??[];
  return json({release:'3.7',build:'8.3',feature_version:'context-v1',backtest_run_id:ctx.runId,dataset_build_id:ctx.buildId,source:{rows:total,certified:Number(source?.certified??0),excluded:Number(source?.excluded??0)},features:{rows,ready:Number(built?.ready??0),excluded:Number(built?.excluded??0),dates:Number(built?.dates??0),avg_ready_quality:built?.avg_ready_quality==null?null:Number(built.avg_ready_quality),weather_classified:Number(built?.weather_classified??0),wind_classified:Number(built?.wind_classified??0),umpire_identified:Number(built?.umpire_identified??0),remaining:Math.max(0,total-rows)},weather_buckets:buckets,recent,done:total>0&&rows>=total,research_only:true,provenance:'Historical retrospective context features. Structural fields are separated from retrospective observed weather/wind and retrospectively sourced umpire identity. No outcome-derived context features.',production_models_changed:false});
}


type ContextReplayJoinedRow={
  backtest_dataset_row_id:number;board_date:string;pitcher_id:number;prop_line:number;model_edge:number|null;preferred_side:string|null;preferred_outcome:string|null;more_outcome:string|null;less_outcome:string|null;
  weather_group:string|null;wind_direction_group:string|null;roof_type:string|null;is_roof_closed:number;day_night:string|null;temperature_f:number|null;home_plate_umpire_mlb_id:number|null;feature_quality_score:number|null;
};
type ContextSegStat={n:number;wins:number};
function contextTempBand(v:unknown){const x=Number(v);if(!Number.isFinite(x))return 'UNKNOWN';if(x<=55)return '<=55';if(x<70)return '56-69';if(x<85)return '70-84';return '85+';}
function contextBaselineHit(r:ContextReplayJoinedRow){const x=String(r.preferred_outcome??'').toUpperCase();return x==='WIN'?1:x==='LOSS'?0:null;}
function contextOppositeSide(s:unknown){return String(s??'').toUpperCase()==='MORE'?'LESS':'MORE';}
function contextOutcomeForSide(r:ContextReplayJoinedRow,side:string){const x=String(side==='MORE'?r.more_outcome:r.less_outcome).toUpperCase();return x==='WIN'?1:x==='LOSS'?0:null;}
function contextAddStat(map:Map<string,ContextSegStat>,key:string,hit:number){const x=map.get(key)??{n:0,wins:0};x.n++;x.wins+=hit;map.set(key,x);}
function contextSegmentKey(kind:string,r:ContextReplayJoinedRow){
  if(kind==='day')return String(r.day_night??'UNKNOWN').toUpperCase();
  if(kind==='roof')return r.is_roof_closed?'ROOF_CLOSED':String(r.roof_type??'UNKNOWN').toUpperCase();
  if(kind==='weather')return String(r.weather_group??'UNKNOWN').toUpperCase();
  if(kind==='wind')return String(r.wind_direction_group??'UNKNOWN').toUpperCase();
  if(kind==='temp')return contextTempBand(r.temperature_f);
  if(kind==='umpire')return r.home_plate_umpire_mlb_id==null?'UNKNOWN':String(r.home_plate_umpire_mlb_id);
  return 'UNKNOWN';
}
function contextReplayEstimate(train:ContextReplayJoinedRow[],r:ContextReplayJoinedRow){
  let globalN=0,globalWins=0;const kinds=['day','roof','weather','wind','temp','umpire'];const maps=new Map<string,Map<string,ContextSegStat>>();for(const k of kinds)maps.set(k,new Map());
  for(const x of train){const hit=contextBaselineHit(x);if(hit==null)continue;globalN++;globalWins+=hit;for(const k of kinds){const key=contextSegmentKey(k,x);if(key!=='UNKNOWN')contextAddStat(maps.get(k)!,key,hit);}}
  const global=globalN?globalWins/globalN:.5;let sumDelta=0,signals=0;const detail:any={};
  for(const k of kinds){const key=contextSegmentKey(k,r),st=maps.get(k)!.get(key);if(!st)continue;const minN=k==='umpire'?8:20,shrink=k==='umpire'?25:40;if(st.n<minN)continue;const rate=st.wins/st.n,weight=st.n/(st.n+shrink),delta=(rate-global)*weight;sumDelta+=delta;signals++;detail[k]={key,n:st.n,hit_rate:rate,shrunk_delta:delta};}
  const expected=Math.max(.30,Math.min(.70,global+(signals?sumDelta/signals:0)));
  const confidence=signals>=2&&expected>=global+.035?'BOOST':signals>=2&&expected<=global-.035?'SUPPRESS':'NEUTRAL';
  const flip=signals>=3&&expected<=.46;
  return {globalN,global,expected,signals,confidence,flip,detail};
}
async function contextReplayDates(env:Env,runId:number){const r=(await env.DB.prepare(`SELECT DISTINCT test_date_min d FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' ORDER BY test_date_min`).bind(runId).all<{d:string}>()).results??[];return r.map(x=>String(x.d));}
async function runContextReplayDate(request:Request,env:Env):Promise<Response>{
  const body=await request.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));const ctx=await getContextBackfillContext(env);if(!ctx)return json({error:'No completed walk-forward-v2 run found.'},{status:404});
  const ready=await env.DB.prepare(`SELECT COUNT(*) n FROM historical_context_features WHERE backtest_run_id=? AND feature_version='context-v1' AND feature_status='FEATURE_READY'`).bind(ctx.runId).first<{n:number}>();if(Number(ready?.n||0)<=0)return json({error:'Build 8.3 context features are not ready.'},{status:409});
  let run=await env.DB.prepare(`SELECT * FROM context_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? AND replay_version='context-challenger-replay-v1' ORDER BY context_replay_run_id DESC LIMIT 1`).bind(ctx.runId,ctx.buildId).first<Record<string,unknown>>();
  if(!run){const x=await env.DB.prepare(`INSERT INTO context_challenger_replay_runs(run_uuid,backtest_run_id,backtest_dataset_build_id,replay_version,status,details_json) VALUES(?,?,?,'context-challenger-replay-v1','RUNNING',?)`).bind(crypto.randomUUID(),ctx.runId,ctx.buildId,JSON.stringify({anti_lookahead:'Only rows with board_date strictly before target date contribute to context segment history.',flip_rule:'flip only when >=3 qualifying prior-only context segments estimate baseline correctness <=46%',confidence_rule:'BOOST/SUPPRESS when >=2 segments shift expected correctness by >=3.5 percentage points versus prior global baseline'})).run();run={context_replay_run_id:Number(x.meta.last_row_id)};}
  const runId=Number(run.context_replay_run_id),dates=await contextReplayDates(env,ctx.runId);let date=String(body.date??'');if(!date){const done=(await env.DB.prepare(`SELECT board_date FROM context_challenger_replay_dates WHERE context_replay_run_id=? AND status IN ('SKIPPED','EXECUTED')`).bind(runId).all<{board_date:string}>()).results??[];const ds=new Set(done.map(x=>String(x.board_date)));date=dates.find(d=>!ds.has(d))||'';}
  if(!date){await env.DB.prepare(`UPDATE context_challenger_replay_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP,dates_completed=(SELECT COUNT(*) FROM context_challenger_replay_dates WHERE context_replay_run_id=? AND status='EXECUTED'),rows_scored=(SELECT COUNT(*) FROM context_challenger_replay_rows WHERE context_replay_run_id=?) WHERE context_replay_run_id=?`).bind(runId,runId,runId).run();return json({ok:true,done:true,context_replay_run_id:runId});}
  const all=(await env.DB.prepare(`SELECT r.backtest_dataset_row_id,r.board_date,r.pitcher_id,r.prop_line,r.model_edge,r.preferred_side,r.preferred_outcome,r.more_outcome,r.less_outcome,f.weather_group,f.wind_direction_group,f.roof_type,f.is_roof_closed,f.day_night,f.temperature_f,f.home_plate_umpire_mlb_id,f.feature_quality_score FROM backtest_dataset_rows_v3 r JOIN historical_context_features f ON f.backtest_run_id=? AND f.backtest_dataset_row_id=r.backtest_dataset_row_id AND f.feature_version='context-v1' AND f.feature_status='FEATURE_READY' WHERE r.backtest_dataset_build_id=? AND r.backtest_eligible=1 AND r.more_outcome IN ('WIN','LOSS') AND r.board_date<=? ORDER BY r.board_date,r.backtest_dataset_row_id`).bind(ctx.runId,ctx.buildId,date).all<ContextReplayJoinedRow>()).results??[];
  const train=all.filter(x=>String(x.board_date)<date);const fold=await env.DB.prepare(`SELECT backtest_fold_id FROM backtest_folds WHERE backtest_run_id=? AND status='EXECUTED' AND test_date_min=? LIMIT 1`).bind(ctx.runId,date).first<{backtest_fold_id:number}>();if(!fold)return json({error:'Executed fold not found.'},{status:404});
  const testIds=(await env.DB.prepare(`SELECT backtest_dataset_row_id FROM backtest_fold_rows_v3 WHERE backtest_fold_id=? AND partition='TEST'`).bind(fold.backtest_fold_id).all<{backtest_dataset_row_id:number}>()).results??[];const idSet=new Set(testIds.map(x=>Number(x.backtest_dataset_row_id)));const tests=all.filter(x=>idSet.has(Number(x.backtest_dataset_row_id)));
  if(train.length<80){await env.DB.prepare(`INSERT OR REPLACE INTO context_challenger_replay_dates(context_replay_run_id,board_date,status,train_rows,test_rows,details_json,completed_at) VALUES(?,?,'SKIPPED',?,?,?,CURRENT_TIMESTAMP)`).bind(runId,date,train.length,tests.length,JSON.stringify({reason:'need_80_prior_feature_ready_rows'})).run();return json({ok:true,date,status:'SKIPPED',train_rows:train.length,test_rows:tests.length});}
  const stmts=[];let wins=0,losses=0,disagreements=0,improved=0,harmed=0,boost=0,suppress=0;
  for(const r of tests){const e=contextReplayEstimate(train,r),baselineSide=String(r.preferred_side??'').toUpperCase(),challengerSide=e.flip?contextOppositeSide(baselineSide):baselineSide,baselineHit=contextBaselineHit(r),challengerHit=contextOutcomeForSide(r,challengerSide),disagreement=challengerSide!==baselineSide?1:0;if(challengerHit===1)wins++;else if(challengerHit===0)losses++;if(disagreement){disagreements++;if(challengerHit===1&&baselineHit===0)improved++;if(challengerHit===0&&baselineHit===1)harmed++;}if(e.confidence==='BOOST')boost++;if(e.confidence==='SUPPRESS')suppress++;
    stmts.push(env.DB.prepare(`INSERT INTO context_challenger_replay_rows(context_replay_run_id,backtest_dataset_row_id,board_date,pitcher_id,prop_line,model_edge,baseline_side,baseline_hit,challenger_side,challenger_hit,disagreement,context_expected_baseline_hit,prior_global_hit_rate,context_signal_count,confidence_class,weather_group,wind_direction_group,roof_type,is_roof_closed,day_night,temperature_f,temperature_band,home_plate_umpire_mlb_id,feature_quality_score,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(context_replay_run_id,backtest_dataset_row_id) DO UPDATE SET baseline_side=excluded.baseline_side,baseline_hit=excluded.baseline_hit,challenger_side=excluded.challenger_side,challenger_hit=excluded.challenger_hit,disagreement=excluded.disagreement,context_expected_baseline_hit=excluded.context_expected_baseline_hit,prior_global_hit_rate=excluded.prior_global_hit_rate,context_signal_count=excluded.context_signal_count,confidence_class=excluded.confidence_class,details_json=excluded.details_json`).bind(runId,r.backtest_dataset_row_id,r.board_date,r.pitcher_id,r.prop_line,r.model_edge??null,baselineSide,baselineHit,challengerSide,challengerHit,disagreement,e.expected,e.global,e.signals,e.confidence,r.weather_group??null,r.wind_direction_group??null,r.roof_type??null,r.is_roof_closed||0,r.day_night??null,r.temperature_f??null,contextTempBand(r.temperature_f),r.home_plate_umpire_mlb_id??null,r.feature_quality_score??null,JSON.stringify({segment_history:e.detail,flip:e.flip,anti_lookahead:true})));
  }
  if(stmts.length)await env.DB.batch(stmts);
  await env.DB.prepare(`INSERT OR REPLACE INTO context_challenger_replay_dates(context_replay_run_id,board_date,status,train_rows,test_rows,wins,losses,disagreements,improved,harmed,boost_rows,suppress_rows,details_json,completed_at) VALUES(?,?,'EXECUTED',?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(runId,date,train.length,tests.length,wins,losses,disagreements,improved,harmed,boost,suppress,JSON.stringify({rule_version:'prior-segment-correctness-v1'})).run();
  return json({ok:true,date,status:'EXECUTED',train_rows:train.length,test_rows:tests.length,wins,losses,disagreements,improved,harmed,boost,suppress});
}
async function getContextChallengerReplay(env:Env):Promise<Response>{
  const ctx=await getContextBackfillContext(env);if(!ctx)return json({release:'3.7',build:'8.4',run:null});const dates=await contextReplayDates(env,ctx.runId);const run=await env.DB.prepare(`SELECT * FROM context_challenger_replay_runs WHERE backtest_run_id=? AND backtest_dataset_build_id=? AND replay_version='context-challenger-replay-v1' ORDER BY context_replay_run_id DESC LIMIT 1`).bind(ctx.runId,ctx.buildId).first<Record<string,unknown>>();if(!run)return json({release:'3.7',build:'8.4',run:null,total_dates:dates.length,feature_ready:(await env.DB.prepare(`SELECT COUNT(*) n FROM historical_context_features WHERE backtest_run_id=? AND feature_version='context-v1' AND feature_status='FEATURE_READY'`).bind(ctx.runId).first<{n:number}>())?.n||0,research_only:true,production_models_changed:false});
  const id=Number(run.context_replay_run_id);const summary=await env.DB.prepare(`SELECT COUNT(*) rows,SUM(baseline_hit) baseline_wins,SUM(CASE WHEN baseline_hit=0 THEN 1 ELSE 0 END) baseline_losses,SUM(challenger_hit) challenger_wins,SUM(CASE WHEN challenger_hit=0 THEN 1 ELSE 0 END) challenger_losses,SUM(disagreement) disagreements,SUM(CASE WHEN disagreement=1 AND challenger_hit=1 AND baseline_hit=0 THEN 1 ELSE 0 END) improved,SUM(CASE WHEN disagreement=1 AND challenger_hit=0 AND baseline_hit=1 THEN 1 ELSE 0 END) harmed,AVG(context_expected_baseline_hit) avg_expected_baseline_hit FROM context_challenger_replay_rows WHERE context_replay_run_id=?`).bind(id).first<Record<string,unknown>>();
  const confidence=(await env.DB.prepare(`SELECT confidence_class bucket,COUNT(*) n,SUM(baseline_hit) wins,AVG(context_expected_baseline_hit) avg_expected FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY confidence_class ORDER BY CASE confidence_class WHEN 'BOOST' THEN 1 WHEN 'NEUTRAL' THEN 2 ELSE 3 END`).bind(id).all<Record<string,unknown>>()).results??[];
  const weather=(await env.DB.prepare(`SELECT weather_group bucket,COUNT(*) n,SUM(baseline_hit) wins FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY weather_group ORDER BY n DESC`).bind(id).all<Record<string,unknown>>()).results??[];
  const wind=(await env.DB.prepare(`SELECT wind_direction_group bucket,COUNT(*) n,SUM(baseline_hit) wins FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY wind_direction_group ORDER BY n DESC`).bind(id).all<Record<string,unknown>>()).results??[];
  const roof=(await env.DB.prepare(`SELECT CASE WHEN is_roof_closed=1 THEN 'ROOF_CLOSED' ELSE COALESCE(roof_type,'UNKNOWN') END bucket,COUNT(*) n,SUM(baseline_hit) wins FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY bucket ORDER BY n DESC`).bind(id).all<Record<string,unknown>>()).results??[];
  const dayNight=(await env.DB.prepare(`SELECT COALESCE(day_night,'UNKNOWN') bucket,COUNT(*) n,SUM(baseline_hit) wins FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY bucket ORDER BY n DESC`).bind(id).all<Record<string,unknown>>()).results??[];
  const temp=(await env.DB.prepare(`SELECT temperature_band bucket,COUNT(*) n,SUM(baseline_hit) wins FROM context_challenger_replay_rows WHERE context_replay_run_id=? GROUP BY temperature_band ORDER BY MIN(temperature_f)`).bind(id).all<Record<string,unknown>>()).results??[];
  const umpires=(await env.DB.prepare(`SELECT COALESCE(f.home_plate_umpire_name,'Unknown') bucket,COUNT(*) n,SUM(r.baseline_hit) wins FROM context_challenger_replay_rows r JOIN historical_context_features f ON f.backtest_run_id=? AND f.backtest_dataset_row_id=r.backtest_dataset_row_id AND f.feature_version='context-v1' WHERE r.context_replay_run_id=? GROUP BY f.home_plate_umpire_mlb_id,f.home_plate_umpire_name HAVING COUNT(*)>=6 ORDER BY n DESC LIMIT 30`).bind(ctx.runId,id).all<Record<string,unknown>>()).results??[];
  const done=(await env.DB.prepare(`SELECT board_date,status,train_rows,test_rows,wins,losses,disagreements,improved,harmed,boost_rows,suppress_rows FROM context_challenger_replay_dates WHERE context_replay_run_id=? ORDER BY board_date`).bind(id).all<Record<string,unknown>>()).results??[];const ds=new Set(done.map(x=>String(x.board_date)));const recent=(await env.DB.prepare(`SELECT r.*,p.canonical_name pitcher_name FROM context_challenger_replay_rows r JOIN pitchers p ON p.pitcher_id=r.pitcher_id WHERE r.context_replay_run_id=? ORDER BY r.board_date DESC,r.context_replay_row_id DESC LIMIT 80`).bind(id).all<Record<string,unknown>>()).results??[];
  return json({release:'3.7',build:'8.4',replay_version:'context-challenger-replay-v1',run,summary,confidence,weather,wind,roof,day_night:dayNight,temperature:temp,umpires,recent,dates:done,total_dates:dates.length,next_date:dates.find(d=>!ds.has(d))||null,anti_lookahead:'Every context signal estimate uses only FEATURE_READY rows with board_date strictly before the target test date. Current-date outcomes never enter training.',research_only:true,production_models_changed:false});
}


type PromotionPolicyRow = {
  promotion_policy_id:number;
  policy_name:string;
  status:string;
  candidate_version_name:string;
  min_historical_paired_rows:number;
  min_live_graded_pairs:number;
  min_live_distinct_dates:number;
  min_live_hit_delta:number;
  max_live_brier_delta:number;
  max_abs_live_calibration_gap:number;
  require_zero_runtime_failures:number;
  require_manual_approval:number;
  config_json:string|null;
};

function promotionRate(wins:number, rows:number):number|null { return rows > 0 ? wins / rows : null; }

async function collectPromotionReadiness(env:Env){
  const policy=await env.DB.prepare(`SELECT * FROM promotion_policies WHERE status='ACTIVE' ORDER BY promotion_policy_id DESC LIMIT 1`).first<PromotionPolicyRow>();
  if(!policy) return {policy:null,status:'NO_ACTIVE_POLICY',production:null,candidate:null,historical:null,live:null,gates:[]};
  const production=await env.DB.prepare(`SELECT model_version_id,version_name,model_role,lifecycle_status,execution_enabled,last_execution_status,last_execution_error FROM model_versions WHERE model_role='PRODUCTION' AND lifecycle_status='ACTIVE' ORDER BY model_version_id DESC LIMIT 1`).first<Record<string,unknown>>();
  const candidate=await env.DB.prepare(`SELECT model_version_id,version_name,model_role,lifecycle_status,execution_enabled,last_execution_status,last_execution_error FROM model_versions WHERE version_name=? ORDER BY model_version_id DESC LIMIT 1`).bind(policy.candidate_version_name).first<Record<string,unknown>>();
  if(!production||!candidate) return {policy,status:'MODEL_MISSING',production,candidate,historical:null,live:null,gates:[]};
  const latestRun=await env.DB.prepare(`SELECT backtest_run_id,backtest_dataset_build_id,engine_version,status,started_at,completed_at FROM backtest_runs WHERE engine_version='walk-forward-v2' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY backtest_run_id DESC LIMIT 1`).first<Record<string,unknown>>();
  let historicalRows=0, historicalDates=0;
  if(latestRun){
    const h=await env.DB.prepare(`SELECT COUNT(DISTINCT r.backtest_dataset_row_id) rows,COUNT(DISTINCT r.board_date) dates FROM backtest_folds f JOIN backtest_fold_rows_v3 fr ON fr.backtest_fold_id=f.backtest_fold_id AND fr.partition='TEST' JOIN backtest_dataset_rows_v3 r ON r.backtest_dataset_row_id=fr.backtest_dataset_row_id WHERE f.backtest_run_id=? AND f.status='EXECUTED' AND UPPER(COALESCE(r.preferred_outcome,'')) IN ('WIN','LOSS')`).bind(Number(latestRun.backtest_run_id)).first<{rows:number;dates:number}>();
    historicalRows=Number(h?.rows??0); historicalDates=Number(h?.dates??0);
  }
  const prodId=Number(production.model_version_id), candId=Number(candidate.model_version_id);
  const liveRows=(await env.DB.prepare(`
    SELECT b.board_date,pr.result,
      p13.preferred_side v13_side,CASE WHEN UPPER(p13.preferred_side)='MORE' THEN COALESCE(p13.calibrated_more_probability,p13.raw_more_probability) ELSE COALESCE(p13.calibrated_less_probability,p13.raw_less_probability) END v13_probability,
      p14.preferred_side v14_side,CASE WHEN UPPER(p14.preferred_side)='MORE' THEN COALESCE(p14.calibrated_more_probability,p14.raw_more_probability) ELSE COALESCE(p14.calibrated_less_probability,p14.raw_less_probability) END v14_probability
    FROM props p JOIN boards b ON b.board_id=p.board_id
    JOIN model_predictions p13 ON p13.model_prediction_id=(SELECT x.model_prediction_id FROM model_predictions x WHERE x.prop_id=p.prop_id AND x.model_version_id=? AND x.prediction_mode='PRODUCTION' AND x.prediction_status='COMPLETE' ORDER BY x.model_prediction_id DESC LIMIT 1)
    JOIN model_predictions p14 ON p14.model_prediction_id=(SELECT x.model_prediction_id FROM model_predictions x WHERE x.prop_id=p.prop_id AND x.model_version_id=? AND x.prediction_mode='SHADOW' AND x.prediction_status='COMPLETE' ORDER BY x.model_prediction_id DESC LIMIT 1)
    LEFT JOIN prop_results pr ON pr.prop_id=p.prop_id AND pr.result_status<>'PENDING'
    ORDER BY b.board_date,p.prop_id
  `).bind(prodId,candId).all<Record<string,unknown>>()).results??[];
  const graded=liveRows.filter(r=>['OVER','UNDER'].includes(String(r.result??'').toUpperCase()));
  const calc=(sideKey:string,probKey:string)=>{let wins=0,brier=0,probSum=0,n=0;for(const r of graded){const side=String(r[sideKey]??'').toUpperCase(),result=String(r.result??'').toUpperCase();if(side!=='MORE'&&side!=='LESS')continue;const y=((side==='MORE'&&result==='OVER')||(side==='LESS'&&result==='UNDER'))?1:0;const p=Math.max(0,Math.min(1,Number(r[probKey]??0.5)));wins+=y;brier+=(p-y)*(p-y);probSum+=p;n++;}const hit=promotionRate(wins,n),avg=n?probSum/n:null;return {rows:n,wins,losses:n-wins,hit_rate:hit,brier:n?brier/n:null,avg_probability:avg,calibration_gap:hit!=null&&avg!=null?avg-hit:null};};
  const v13=calc('v13_side','v13_probability'), v14=calc('v14_side','v14_probability');
  const liveDates=new Set(graded.map(r=>String(r.board_date??'').slice(0,10)).filter(Boolean)).size;
  const failures=await env.DB.prepare(`SELECT COUNT(*) n FROM model_predictions WHERE model_version_id=? AND prediction_mode='SHADOW' AND prediction_status='FAILED'`).bind(candId).first<{n:number}>();
  const hitDelta=v13.hit_rate!=null&&v14.hit_rate!=null?v14.hit_rate-v13.hit_rate:null;
  const brierDelta=v13.brier!=null&&v14.brier!=null?v14.brier-v13.brier:null;
  const absCalGap=v14.calibration_gap==null?null:Math.abs(v14.calibration_gap);
  const gates=[
    {key:'historical_sample',label:'Historical paired rows',value:historicalRows,threshold:policy.min_historical_paired_rows,pass:historicalRows>=policy.min_historical_paired_rows},
    {key:'candidate_enabled',label:'Candidate shadow enabled',value:Number(candidate.execution_enabled??0),threshold:1,pass:Number(candidate.execution_enabled??0)===1},
    {key:'runtime_failures',label:'Shadow runtime failures',value:Number(failures?.n??0),threshold:0,pass:policy.require_zero_runtime_failures?Number(failures?.n??0)===0:true},
    {key:'live_sample',label:'Live graded pairs',value:graded.length,threshold:policy.min_live_graded_pairs,pass:graded.length>=policy.min_live_graded_pairs},
    {key:'live_dates',label:'Live distinct dates',value:liveDates,threshold:policy.min_live_distinct_dates,pass:liveDates>=policy.min_live_distinct_dates},
    {key:'live_hit_delta',label:'v14 − v13 live hit',value:hitDelta,threshold:policy.min_live_hit_delta,pass:hitDelta!=null&&hitDelta>=policy.min_live_hit_delta,requires_sample:true},
    {key:'live_brier_delta',label:'v14 − v13 live Brier',value:brierDelta,threshold:policy.max_live_brier_delta,pass:brierDelta!=null&&brierDelta<=policy.max_live_brier_delta,requires_sample:true},
    {key:'live_calibration_gap',label:'Absolute v14 live calibration gap',value:absCalGap,threshold:policy.max_abs_live_calibration_gap,pass:absCalGap!=null&&absCalGap<=policy.max_abs_live_calibration_gap,requires_sample:true},
  ].map(g=>({...g,evaluable:!g.requires_sample||(graded.length>=policy.min_live_graded_pairs&&liveDates>=policy.min_live_distinct_dates)}));
  const evaluated=gates.filter(g=>g.evaluable); const technicalReady=evaluated.length===gates.length&&evaluated.every(g=>g.pass);
  return {policy,status:technicalReady?'TECHNICALLY_READY':'OBSERVATION',production,candidate,historical:{run:latestRun,paired_rows:historicalRows,distinct_dates:historicalDates},live:{paired_predictions:liveRows.length,graded_pairs:graded.length,distinct_dates:liveDates,v13,v14,hit_delta:hitDelta,brier_delta:brierDelta,abs_v14_calibration_gap:absCalGap,runtime_failures:Number(failures?.n??0)},gates,technical_ready:technicalReady,manual_approval_required:Boolean(policy.require_manual_approval),promotion_enabled:false};
}


type LiveShadowCertificationRow={live_shadow_certification_id:number;certification_uuid:string;promotion_policy_id:number;production_model_version_id:number;candidate_model_version_id:number;status:string;started_at:string;completed_at:string|null;min_live_graded_pairs:number;min_live_distinct_dates:number;require_zero_runtime_failures:number;notes:string|null;};
async function collectLiveShadowCertification(env:Env){
 const cert=await env.DB.prepare(`SELECT * FROM live_shadow_certifications WHERE status IN ('COLLECTING','TECHNICALLY_READY') ORDER BY live_shadow_certification_id DESC LIMIT 1`).first<LiveShadowCertificationRow>();
 if(!cert)return {session:null,status:'NO_ACTIVE_CERTIFICATION',daily:[],failures:[],summary:null};
 const prodId=Number(cert.production_model_version_id),candId=Number(cert.candidate_model_version_id),start=String(cert.started_at);

 // Build 9.2.6: indexed ledger pass; failure exclusions are classified in Worker code, not SQL LIKE.
 const ledger=(await env.DB.prepare(`
   WITH latest_prod AS (
     SELECT mp.* FROM model_predictions mp
     JOIN (
       SELECT prop_id,MAX(model_prediction_id) model_prediction_id
       FROM model_predictions
       WHERE model_version_id=? AND prediction_mode='PRODUCTION' AND prediction_status='COMPLETE' AND predicted_at>=?
       GROUP BY prop_id
     ) x ON x.model_prediction_id=mp.model_prediction_id
   ), latest_cand AS (
     SELECT mp.* FROM model_predictions mp
     JOIN (
       SELECT prop_id,MAX(model_prediction_id) model_prediction_id
       FROM model_predictions
       WHERE model_version_id=? AND prediction_mode='SHADOW' AND prediction_status='COMPLETE' AND predicted_at>=?
       GROUP BY prop_id
     ) x ON x.model_prediction_id=mp.model_prediction_id
   ), active_props AS (
     SELECT prop_id FROM latest_prod UNION SELECT prop_id FROM latest_cand
   )
   SELECT ap.prop_id,b.board_date,pr.result,
     p13.model_prediction_id v13_prediction_id,p13.preferred_side v13_side,
     CASE WHEN UPPER(p13.preferred_side)='MORE' THEN COALESCE(p13.calibrated_more_probability,p13.raw_more_probability)
          WHEN UPPER(p13.preferred_side)='LESS' THEN COALESCE(p13.calibrated_less_probability,p13.raw_less_probability) END v13_probability,
     p14.model_prediction_id v14_prediction_id,p14.preferred_side v14_side,
     CASE WHEN UPPER(p14.preferred_side)='MORE' THEN COALESCE(p14.calibrated_more_probability,p14.raw_more_probability)
          WHEN UPPER(p14.preferred_side)='LESS' THEN COALESCE(p14.calibrated_less_probability,p14.raw_less_probability) END v14_probability
   FROM active_props ap
   JOIN props p ON p.prop_id=ap.prop_id
   JOIN boards b ON b.board_id=p.board_id
   LEFT JOIN latest_prod p13 ON p13.prop_id=ap.prop_id
   LEFT JOIN latest_cand p14 ON p14.prop_id=ap.prop_id
   LEFT JOIN prop_results pr ON pr.prop_id=ap.prop_id AND pr.result_status<>'PENDING'
   ORDER BY b.board_date,ap.prop_id
 `).bind(prodId,start,candId,start).all<Record<string,unknown>>()).results??[];

 const directional=(r:Record<string,unknown>)=>['MORE','LESS'].includes(String(r.v13_side??'').toUpperCase());
 const hasProd=(r:Record<string,unknown>)=>r.v13_prediction_id!=null;
 const hasCand=(r:Record<string,unknown>)=>r.v14_prediction_id!=null;
 const rows=ledger.filter(r=>hasProd(r)&&directional(r)&&hasCand(r));
 const missingProd=ledger.filter(r=>hasCand(r)&&!hasProd(r)).length;
 const missingCand=ledger.filter(r=>hasProd(r)&&directional(r)&&!hasCand(r)).length;
 const sourceExcluded=ledger.filter(r=>hasProd(r)&&!directional(r)).length;

 const failureLedger=(await env.DB.prepare(`SELECT f.live_shadow_failure_id,f.model_prediction_id,f.prop_id,f.board_date,f.failed_at,f.failure_type,f.error_message,pi.canonical_name pitcher_name FROM live_shadow_failure_ledger f JOIN props pr ON pr.prop_id=f.prop_id JOIN pitchers pi ON pi.pitcher_id=pr.pitcher_id WHERE f.live_shadow_certification_id=? AND f.failure_type='SHADOW_RUNTIME' ORDER BY f.failed_at DESC LIMIT 250`).bind(cert.live_shadow_certification_id).all<Record<string,unknown>>()).results??[];
 const failures=failureLedger.filter(f=>!String(f.error_message??'').startsWith('v14 baseline requires a directional source recommendation'));
 const historicalFailures=Number((await env.DB.prepare(`SELECT COUNT(*) n FROM live_shadow_failure_ledger f JOIN model_predictions mp ON mp.model_prediction_id=f.model_prediction_id WHERE f.failure_scope='PRE_CERTIFICATION' AND mp.model_version_id=?`).bind(candId).first<{n:number}>())?.n??0);
 const calc=(rr:Record<string,unknown>[],sk:string,pk:string)=>{let wins=0,brier=0,sum=0,n=0;for(const r of rr){const result=String(r.result??'').toUpperCase(),side=String(r[sk]??'').toUpperCase();if(!['OVER','UNDER'].includes(result)||!['MORE','LESS'].includes(side))continue;const y=((side==='MORE'&&result==='OVER')||(side==='LESS'&&result==='UNDER'))?1:0,p=Math.max(0,Math.min(1,Number(r[pk]??.5)));wins+=y;brier+=(p-y)*(p-y);sum+=p;n++;}const hit=n?wins/n:null,avg=n?sum/n:null;return {rows:n,wins,losses:n-wins,hit_rate:hit,brier:n?brier/n:null,avg_probability:avg,calibration_gap:hit!=null&&avg!=null?avg-hit:null};};
 const graded=rows.filter(r=>['OVER','UNDER'].includes(String(r.result??'').toUpperCase())),v13=calc(graded,'v13_side','v13_probability'),v14=calc(graded,'v14_side','v14_probability');
 const dates=[...new Set(graded.map(r=>String(r.board_date??'').slice(0,10)).filter(Boolean))].sort();
 const daily=dates.map(date=>{const rr=rows.filter(r=>String(r.board_date??'').slice(0,10)===date),gg=graded.filter(r=>String(r.board_date??'').slice(0,10)===date),a=calc(gg,'v13_side','v13_probability'),b=calc(gg,'v14_side','v14_probability');return {date,paired_predictions:rr.length,graded_pairs:gg.length,v13:a,v14:b,hit_delta:a.hit_rate!=null&&b.hit_rate!=null?b.hit_rate-a.hit_rate:null,brier_delta:a.brier!=null&&b.brier!=null?b.brier-a.brier:null,runtime_failures:failures.filter(x=>String(x.board_date??'').slice(0,10)===date).length};});
 const hitDelta=v13.hit_rate!=null&&v14.hit_rate!=null?v14.hit_rate-v13.hit_rate:null,brierDelta=v13.brier!=null&&v14.brier!=null?v14.brier-v13.brier:null,absCal=v14.calibration_gap==null?null:Math.abs(v14.calibration_gap),sampleReady=graded.length>=cert.min_live_graded_pairs&&dates.length>=cert.min_live_distinct_dates,clean=failures.length===0&&missingProd===0&&missingCand===0;
 return {session:cert,status:sampleReady&&clean?'WINDOW_READY':'COLLECTING',summary:{paired_predictions:rows.length,graded_pairs:graded.length,distinct_dates:dates.length,min_graded_pairs:cert.min_live_graded_pairs,min_distinct_dates:cert.min_live_distinct_dates,runtime_failures:failures.length,pre_certification_runtime_failures:historicalFailures,missing_production_pairs:missingProd,missing_candidate_pairs:missingCand,source_excluded_predictions:sourceExcluded,v13,v14,hit_delta:hitDelta,brier_delta:brierDelta,abs_v14_calibration_gap:absCal,sample_ready:sampleReady,clean_window:clean},daily,failures};
}

type CertificationMonitorCheckpoint={live_shadow_monitor_checkpoint_id:number;checkpoint_type:string;checkpoint_key:string;checkpoint_label:string;graded_pairs:number;distinct_dates:number;runtime_failures:number;pair_integrity_failures:number;hit_delta:number|null;brier_delta:number|null;abs_calibration_gap:number|null;monitor_status:string;captured_at:string;trigger_source:string;};
function certificationMonitorStatus(summary:any,policy:any){
  const integrity=Number(summary?.missing_production_pairs??0)+Number(summary?.missing_candidate_pairs??0);
  if(Number(summary?.runtime_failures??0)>0||integrity>0)return 'BLOCKED';
  const sampleReady=Number(summary?.graded_pairs??0)>=Number(policy?.min_live_graded_pairs??Infinity)&&Number(summary?.distinct_dates??0)>=Number(policy?.min_live_distinct_dates??Infinity);
  if(!sampleReady)return 'COLLECTING';
  const hitOk=summary?.hit_delta!=null&&Number(summary.hit_delta)>=Number(policy?.min_live_hit_delta??-Infinity);
  const brierOk=summary?.brier_delta!=null&&Number(summary.brier_delta)<=Number(policy?.max_live_brier_delta??Infinity);
  const calOk=summary?.abs_v14_calibration_gap!=null&&Number(summary.abs_v14_calibration_gap)<=Number(policy?.max_abs_live_calibration_gap??Infinity);
  return hitOk&&brierOk&&calOk?'TECHNICALLY_READY':'BLOCKED';
}
async function insertCertificationMonitorCheckpoint(env:Env,cert:any,summary:any,policy:any,type:string,key:string,label:string,trigger:string){
  const integrity=Number(summary.missing_production_pairs??0)+Number(summary.missing_candidate_pairs??0),status=certificationMonitorStatus(summary,policy);
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO live_shadow_monitor_checkpoints(live_shadow_certification_id,checkpoint_type,checkpoint_key,checkpoint_label,graded_pairs,distinct_dates,runtime_failures,pair_integrity_failures,hit_delta,brier_delta,abs_calibration_gap,monitor_status,snapshot_json,trigger_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(cert.live_shadow_certification_id,type,key,label,summary.graded_pairs??0,summary.distinct_dates??0,summary.runtime_failures??0,integrity,summary.hit_delta??null,summary.brier_delta??null,summary.abs_v14_calibration_gap??null,status,JSON.stringify({build:'9.3',summary,promotion_enabled:false}),trigger).run();
  return Number(result.meta.changes??0)>0;
}
async function recordLiveShadowCertificationMonitoring(env:Env,scheduledTime:number,trigger='CRON'){
  const data:any=await collectLiveShadowCertification(env); if(!data.session||!data.summary)return;
  const policy=await env.DB.prepare(`SELECT * FROM promotion_policies WHERE promotion_policy_id=?`).bind(data.session.promotion_policy_id).first<Record<string,unknown>>(); if(!policy)return;
  const summary=data.summary,date=chicagoDateString(scheduledTime),cert=data.session;
  const dailyInserted=await insertCertificationMonitorCheckpoint(env,cert,summary,policy,'DAILY',`daily:${date}`,`Daily certification snapshot ${date}`,trigger);
  if(dailyInserted){
    await env.DB.prepare(`INSERT INTO live_shadow_certification_evidence(live_shadow_certification_id,evidence_uuid,evidence_date,paired_predictions,graded_pairs,missing_production_pairs,missing_candidate_pairs,runtime_failures,production_hit_rate,candidate_hit_rate,production_brier,candidate_brier,candidate_abs_calibration_gap,evidence_json,captured_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(cert.live_shadow_certification_id,crypto.randomUUID(),date,summary.paired_predictions??0,summary.graded_pairs??0,summary.missing_production_pairs??0,summary.missing_candidate_pairs??0,summary.runtime_failures??0,summary.v13?.hit_rate??null,summary.v14?.hit_rate??null,summary.v13?.brier??null,summary.v14?.brier??null,summary.abs_v14_calibration_gap??null,JSON.stringify({build:'9.3',trigger,status:certificationMonitorStatus(summary,policy),summary,promotion_enabled:false}),'cloudflare-cron@system.local').run();
  }
  for(const milestone of [50,100,150,200])if(Number(summary.graded_pairs??0)>=milestone)await insertCertificationMonitorCheckpoint(env,cert,summary,policy,'MILESTONE',`graded:${milestone}`,`${milestone} graded certification pairs`,trigger);
  const integrity=Number(summary.missing_production_pairs??0)+Number(summary.missing_candidate_pairs??0);
  const alerts=[Number(summary.runtime_failures??0)>0?{type:'RUNTIME_FAILURE',value:Number(summary.runtime_failures),message:`Certification window has ${summary.runtime_failures} runtime failure(s).`}:null,integrity>0?{type:'PAIR_INTEGRITY',value:integrity,message:`Certification window has ${integrity} pair-integrity failure(s).`}:null].filter(Boolean) as any[];
  for(const a of alerts)await env.DB.prepare(`INSERT OR IGNORE INTO live_shadow_monitor_alerts(live_shadow_certification_id,alert_key,alert_type,severity,observed_value,message,details_json) VALUES(?,?,?,?,?,?,?)`).bind(cert.live_shadow_certification_id,`${a.type}:${a.value}`,a.type,'BLOCKING',a.value,a.message,JSON.stringify({build:'9.3',trigger,summary})).run();
}
async function collectCertificationMonitoring(env:Env,certData:any,policy:any){
  const cert=certData?.session,summary=certData?.summary;if(!cert||!summary)return {status:'NO_ACTIVE_CERTIFICATION',progress:null,checkpoints:[],trends:[],alerts:[]};
  const status=certificationMonitorStatus(summary,policy),minPairs=Number(policy?.min_live_graded_pairs??cert.min_live_graded_pairs??0),minDates=Number(policy?.min_live_distinct_dates??cert.min_live_distinct_dates??0);
  const checkpoints=(await env.DB.prepare(`SELECT live_shadow_monitor_checkpoint_id,checkpoint_type,checkpoint_key,checkpoint_label,graded_pairs,distinct_dates,runtime_failures,pair_integrity_failures,hit_delta,brier_delta,abs_calibration_gap,monitor_status,captured_at,trigger_source FROM live_shadow_monitor_checkpoints WHERE live_shadow_certification_id=? ORDER BY captured_at DESC,live_shadow_monitor_checkpoint_id DESC LIMIT 60`).bind(cert.live_shadow_certification_id).all<CertificationMonitorCheckpoint>()).results??[];
  const evidence=(await env.DB.prepare(`SELECT live_shadow_certification_evidence_id,evidence_date,captured_at,paired_predictions,graded_pairs,runtime_failures,production_hit_rate,candidate_hit_rate,production_brier,candidate_brier,candidate_abs_calibration_gap,captured_by FROM live_shadow_certification_evidence WHERE live_shadow_certification_id=? ORDER BY captured_at ASC,live_shadow_certification_evidence_id ASC LIMIT 120`).bind(cert.live_shadow_certification_id).all<Record<string,unknown>>()).results??[];
  const alerts=(await env.DB.prepare(`SELECT live_shadow_monitor_alert_id,alert_type,severity,observed_value,message,created_at FROM live_shadow_monitor_alerts WHERE live_shadow_certification_id=? ORDER BY created_at DESC,live_shadow_monitor_alert_id DESC LIMIT 20`).bind(cert.live_shadow_certification_id).all<Record<string,unknown>>()).results??[];
  return {status,progress:{graded_pairs:Number(summary.graded_pairs??0),min_graded_pairs:minPairs,pairs_remaining:Math.max(0,minPairs-Number(summary.graded_pairs??0)),distinct_dates:Number(summary.distinct_dates??0),min_distinct_dates:minDates,dates_remaining:Math.max(0,minDates-Number(summary.distinct_dates??0)),pair_progress:minPairs?Math.min(1,Number(summary.graded_pairs??0)/minPairs):0,date_progress:minDates?Math.min(1,Number(summary.distinct_dates??0)/minDates):0,next_milestone:[50,100,150,200].find(x=>Number(summary.graded_pairs??0)<x)??null},checkpoints,trends:evidence,alerts,promotion_enabled:false};
}
async function getLiveShadowCertification(env:Env):Promise<Response>{return json({release:'3.8',build:'9.3',certification_version:'live-shadow-certification-v1.3',...(await collectLiveShadowCertification(env)),promotion_enabled:false,note:'Build 9.2 is observation-only and cannot promote, demote, or change model roles.'});}
async function captureLiveShadowCertificationEvidence(env:Env,identity:AccessIdentity):Promise<Response>{
 const d:any=await collectLiveShadowCertification(env);if(!d.session||!d.summary)return json({error:'No active live shadow certification session.'},{status:409});
 const s=d.summary,date=new Date().toISOString().slice(0,10);const ins=await env.DB.prepare(`INSERT INTO live_shadow_certification_evidence(live_shadow_certification_id,evidence_uuid,evidence_date,paired_predictions,graded_pairs,missing_production_pairs,missing_candidate_pairs,runtime_failures,production_hit_rate,candidate_hit_rate,production_brier,candidate_brier,candidate_abs_calibration_gap,evidence_json,captured_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(d.session.live_shadow_certification_id,crypto.randomUUID(),date,s.paired_predictions,s.graded_pairs,s.missing_production_pairs,s.missing_candidate_pairs,s.runtime_failures,s.v13?.hit_rate??null,s.v14?.hit_rate??null,s.v13?.brier??null,s.v14?.brier??null,s.abs_v14_calibration_gap??null,JSON.stringify({build:'9.3',status:d.status,summary:s,daily:d.daily,promotion_enabled:false}),identity.email??identity.subject??'unknown').run();
 const evidenceId=Number(ins.meta.last_row_id),policy=await env.DB.prepare(`SELECT * FROM promotion_policies WHERE promotion_policy_id=?`).bind(d.session.promotion_policy_id).first<Record<string,unknown>>();
 if(policy)await insertCertificationMonitorCheckpoint(env,d.session,s,policy,'MANUAL',`manual:${evidenceId}`,`Manual evidence checkpoint ${evidenceId}`,'ADMIN');
 await audit(env,identity,'LIVE_SHADOW_CERTIFICATION_EVIDENCE_CAPTURED','MODEL_VERSION',Number(d.session.candidate_model_version_id),{live_shadow_certification_id:d.session.live_shadow_certification_id,evidence_id:evidenceId,promotion_enabled:false});return json({ok:true,evidence_id:evidenceId,certification_status:d.status,promotion_enabled:false});
}

async function collectPromotionReadinessV92(env:Env){
  const readiness:any=await collectPromotionReadiness(env);
  let certification:any;
  try { certification=await collectLiveShadowCertification(env); }
  catch(error){
    console.error('promotion readiness certification collection failed',error);
    certification={session:null,status:'QUERY_ERROR',daily:[],failures:[],summary:null,error:error instanceof Error?error.message:String(error)};
    return {readiness:{...readiness,status:'OBSERVATION',technical_ready:false},certification};
  }
  if(readiness.live&&certification.summary&&readiness.policy){const cs=certification.summary;readiness.live={paired_predictions:cs.paired_predictions,graded_pairs:cs.graded_pairs,distinct_dates:cs.distinct_dates,v13:cs.v13,v14:cs.v14,hit_delta:cs.hit_delta,brier_delta:cs.brier_delta,abs_v14_calibration_gap:cs.abs_v14_calibration_gap,runtime_failures:cs.runtime_failures,pre_certification_runtime_failures:cs.pre_certification_runtime_failures,missing_production_pairs:cs.missing_production_pairs,missing_candidate_pairs:cs.missing_candidate_pairs,source_excluded_predictions:cs.source_excluded_predictions,certification_started_at:certification.session?.started_at??null};for(const g of readiness.gates||[]){if(g.key==='runtime_failures'){g.label='Certification-window runtime failures';g.value=cs.runtime_failures;g.pass=!readiness.policy.require_zero_runtime_failures||cs.runtime_failures===0;}else if(g.key==='live_sample'){g.value=cs.graded_pairs;g.pass=cs.graded_pairs>=readiness.policy.min_live_graded_pairs;}else if(g.key==='live_dates'){g.value=cs.distinct_dates;g.pass=cs.distinct_dates>=readiness.policy.min_live_distinct_dates;}else if(g.key==='live_hit_delta'){g.value=cs.hit_delta;g.pass=cs.hit_delta!=null&&cs.hit_delta>=readiness.policy.min_live_hit_delta;g.evaluable=cs.sample_ready;}else if(g.key==='live_brier_delta'){g.value=cs.brier_delta;g.pass=cs.brier_delta!=null&&cs.brier_delta<=readiness.policy.max_live_brier_delta;g.evaluable=cs.sample_ready;}else if(g.key==='live_calibration_gap'){g.value=cs.abs_v14_calibration_gap;g.pass=cs.abs_v14_calibration_gap!=null&&cs.abs_v14_calibration_gap<=readiness.policy.max_abs_live_calibration_gap;g.evaluable=cs.sample_ready;}}const integrityGate={key:'pair_integrity',label:'Certification pair integrity',value:cs.missing_production_pairs+cs.missing_candidate_pairs,threshold:0,pass:cs.missing_production_pairs===0&&cs.missing_candidate_pairs===0,evaluable:true};if(!(readiness.gates||[]).some((x:any)=>x.key==='pair_integrity'))readiness.gates.splice(3,0,integrityGate);const evaluated=(readiness.gates||[]).filter((g:any)=>g.evaluable!==false);readiness.technical_ready=evaluated.length===readiness.gates.length&&evaluated.every((g:any)=>g.pass);readiness.status=readiness.technical_ready?'TECHNICALLY_READY':'OBSERVATION';}
  return {readiness,certification};
}

async function getPromotionReadiness(env:Env):Promise<Response>{
  const {readiness,certification}=await collectPromotionReadinessV92(env);
  const monitoring=await collectCertificationMonitoring(env,certification,readiness.policy);
  return json({release:'3.8',build:'9.3',governance_version:'promotion-gate-v1',...readiness,certification,monitoring,promotion_enabled:false,note:'Build 9.3 adds automatic post-grading monitoring, immutable daily/milestone checkpoints, trend history, and blocking operational alerts. Promotion remains disabled.'});
}

async function capturePromotionReadiness(env:Env,identity:AccessIdentity):Promise<Response>{
  const {readiness:data}:any=await collectPromotionReadinessV92(env); if(!data.policy||!data.production||!data.candidate)return json({error:'Promotion readiness cannot be captured until the active policy and both models exist.'},{status:409});
  const gateStatus=data.technical_ready?'TECHNICALLY_READY':'OBSERVATION';
  const ins=await env.DB.prepare(`INSERT INTO promotion_readiness_snapshots(snapshot_uuid,promotion_policy_id,production_model_version_id,candidate_model_version_id,gate_status,historical_paired_rows,historical_distinct_dates,live_paired_predictions,live_graded_pairs,live_distinct_dates,production_live_hit_rate,candidate_live_hit_rate,live_hit_delta,production_live_brier,candidate_live_brier,live_brier_delta,candidate_abs_calibration_gap,candidate_runtime_failures,gates_json,evidence_json,captured_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),data.policy.promotion_policy_id,data.production.model_version_id,data.candidate.model_version_id,gateStatus,data.historical?.paired_rows??0,data.historical?.distinct_dates??0,data.live?.paired_predictions??0,data.live?.graded_pairs??0,data.live?.distinct_dates??0,data.live?.v13?.hit_rate??null,data.live?.v14?.hit_rate??null,data.live?.hit_delta??null,data.live?.v13?.brier??null,data.live?.v14?.brier??null,data.live?.brier_delta??null,data.live?.abs_v14_calibration_gap??null,data.live?.runtime_failures??0,JSON.stringify(data.gates),JSON.stringify({governance_version:'promotion-gate-v1',historical:data.historical,live:data.live,technical_ready:data.technical_ready,promotion_enabled:false}),identity.email??identity.subject??'unknown').run();
  await audit(env,identity,'PROMOTION_READINESS_SNAPSHOT_CAPTURED','MODEL_VERSION',Number(data.candidate.model_version_id),{promotion_readiness_snapshot_id:Number(ins.meta.last_row_id),gate_status:gateStatus,promotion_enabled:false});
  return json({ok:true,promotion_readiness_snapshot_id:Number(ins.meta.last_row_id),gate_status:gateStatus,promotion_enabled:false});
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      const hostname = url.hostname.toLowerCase();
      const isPublicHostname = hostname === "mlb.kalupa.net";
      const isAdminHostname = hostname === "admin.mlb.kalupa.net";
      const privateAssetPaths = new Set([
        "/board-editor.html",
        "/board-editor.js",
        "/board-editor.css",
        "/plays.html",
        "/plays.js",
        "/plays.css",
        "/model-control.html",
        "/model-control.js",
        "/model-control.css",
        "/promotion-readiness.html",
        "/promotion-readiness.js",
        "/promotion-readiness.css",
        "/schedule-sync.html",
        "/schedule-sync.js",
        "/schedule-sync.css",
        "/team-split-sync.html",
        "/team-split-sync.js",
        "/team-split-sync.css",
        "/sync-health.html",
        "/sync-health.js",
        "/sync-health.css",
        "/pitcher-features.html",
        "/pitcher-features.js",
        "/pitcher-features.css",
        "/team-features.html",
        "/team-features.js",
        "/team-features.css",
        "/prop-feature-snapshots.html",
        "/prop-feature-snapshots.js",
        "/prop-feature-snapshots.css",
        "/backtest-dataset.html",
        "/backtest-archive-intake.html",
        "/backtest-archive-intake.js",
        "/backtest-archive-intake.css",
        "/backtest-archive-reconstruction.html",
        "/backtest-archive-reconstruction.js",
        "/backtest-archive-reconstruction.css",
        "/backtest-dataset.js",
        "/backtest-reconstruction.html",
        "/backtest-reconstruction.js",
        "/backtest-certification.html",
        "/backtest-independent-reconstruction.html",
        "/backtest-independent-reconstruction.js",
        "/backtest-independent-reconstruction.css",
        "/backtest-opponent-reconstruction.html",
        "/backtest-opponent-reconstruction.js",
        "/backtest-opponent-reconstruction.css",
        "/backtest-certification.js",
        "/backtest-walk-forward.html",
        "/backtest-walk-forward.js",
        "/backtest-walk-forward.css",
        "/backtest-performance.html",
        "/backtest-performance.js",
        "/backtest-performance.css",
        "/backtest-segments.html",
        "/backtest-segments.js",
        "/backtest-segments.css",
        "/model-comparison.html",
        "/model-comparison.js",
        "/model-comparison.css",
        "/feature-diagnostics.html",
        "/feature-diagnostics.js",
        "/feature-diagnostics.css",
        "/statcast-backfill.html",
        "/statcast-backfill.js",
        "/statcast-backfill.css",
        "/statcast-challenger.html",
        "/statcast-challenger.js",
        "/statcast-challenger.css",
        "/context-sync.html",
        "/context-sync.js",
        "/context-sync.css",
        "/context-backfill.html",
        "/context-backfill.js",
        "/context-backfill.css",
        "/context-features.html",
        "/context-features.js",
        "/context-features.css",
        "/context-challenger.html",
        "/context-challenger.js",
        "/context-challenger.css",
        "/learned-challenger.html",
        "/learned-challenger.js",
        "/learned-challenger.css",
        "/backtest-dataset.css",
        "/backtest-reconstruction.css",
        "/backtest-certification.css",
      ]);

      // Private pages must always run on the Access-protected admin hostname.
      // This also repairs old bookmarks and the workers.dev URL by redirecting
      // before the page can make API requests with an audience-mismatched JWT.
      if (!isAdminHostname && privateAssetPaths.has(url.pathname)) {
        const adminUrl = new URL(url.pathname + url.search, "https://admin.mlb.kalupa.net");
        return Response.redirect(adminUrl.toString(), 302);
      }

      const publicReadOnlyPaths = new Set([
        "/api/dashboard",
        "/api/pitcher-history",
      ]);

      const isPublicReadOnlyRequest =
        request.method === "GET" &&
        publicReadOnlyPaths.has(url.pathname);

      const isPrivatePlaysApi =
        url.pathname === "/api/plays" ||
        url.pathname === "/api/play-slips" ||
        url.pathname === "/api/play-slips/settle" ||
        /^\/api\/play-slips\/\d+$/.test(url.pathname) ||
        /^\/api\/play-legs\/\d+\/analysis$/.test(url.pathname) ||
        url.pathname === "/api/bankroll-transactions";

      if (
        isPublicHostname &&
        url.pathname.startsWith("/api/") &&
        !isPublicReadOnlyRequest &&
        !isPrivatePlaysApi
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

      if (url.pathname === "/api/plays" && request.method === "GET") {
        return getPlaysPage(env, url);
      }
      if (url.pathname === "/api/play-slips" && request.method === "POST") {
        return createPlaySlip(request, env, identity!);
      }
      if (url.pathname === "/api/play-slips/settle" && request.method === "POST") {
        return json({ ok: true, ...(await settleTrackedPlays(env)) });
      }
      const playSlipMatch = url.pathname.match(/^\/api\/play-slips\/(\d+)$/);
      if (playSlipMatch && request.method === "DELETE") {
        return deletePlaySlip(env, identity!, Number(playSlipMatch[1]));
      }
      const playAnalysisMatch = url.pathname.match(/^\/api\/play-legs\/(\d+)\/analysis$/);
      if (playAnalysisMatch && request.method === "PATCH") {
        return updatePlayAnalysis(request, env, identity!, Number(playAnalysisMatch[1]));
      }
      if (url.pathname === "/api/bankroll-transactions" && request.method === "POST") {
        return addBankrollTransaction(request, env, identity!);
      }

      if (url.pathname === "/api/models/control" && request.method === "GET") {
        return getModelControl(env);
      }
      const modelControlMatch = url.pathname.match(/^\/api\/models\/(\d+)\/control$/);
      if (modelControlMatch && request.method === "PATCH") {
        return updateModelControl(request, env, identity!, Number(modelControlMatch[1]));
      }

      if (url.pathname === "/api/models/runtime" && request.method === "GET") {
        return getModelRuntime(env);
      }
      const modelRuntimeMatch = url.pathname.match(/^\/api\/models\/(\d+)\/runtime$/);
      if (modelRuntimeMatch && request.method === "PATCH") {
        return updateModelRuntime(request, env, identity!, Number(modelRuntimeMatch[1]));
      }

      if (url.pathname === "/api/models/promotion/readiness" && request.method === "GET") {
        return getPromotionReadiness(env);
      }
      if (url.pathname === "/api/models/promotion/certification" && request.method === "GET") { return getLiveShadowCertification(env); }
      if (url.pathname === "/api/models/promotion/certification-evidence" && request.method === "POST") { return captureLiveShadowCertificationEvidence(env, identity!); }
      if (url.pathname === "/api/models/promotion/readiness-snapshot" && request.method === "POST") {
        return capturePromotionReadiness(env, identity!);
      }

      if (url.pathname === "/api/data-sources/health" && request.method === "GET") {
        return getIngestionHealth(env);
      }

      if (url.pathname === "/api/data-sources/mlb-schedule" && request.method === "GET") {
        return getScheduleSyncStatus(env, url);
      }
      if (url.pathname === "/api/data-sources/mlb-schedule/sync" && request.method === "POST") {
        return runScheduleSync(request, env);
      }
      if (url.pathname === "/api/data-sources/pitcher-game-logs" && request.method === "GET") {
        return getPitcherLogSyncStatus(env, url);
      }
      if (url.pathname === "/api/data-sources/pitcher-game-logs/sync" && request.method === "POST") {
        return runPitcherLogSync(request, env);
      }
      if (url.pathname === "/api/data-sources/team-strikeout-splits" && request.method === "GET") {
        return getTeamSplitSyncStatus(env, url);
      }
      if (url.pathname === "/api/data-sources/team-strikeout-splits/sync" && request.method === "POST") {
        return runTeamSplitSync(request, env);
      }
      if (url.pathname === "/api/data-sources/lineups" && request.method === "GET") {
        return getLineupSyncStatus(env, url);
      }
      if (url.pathname === "/api/data-sources/lineups/sync" && request.method === "POST") {
        return runLineupSync(request, env);
      }
      if (url.pathname === "/api/features/lineup-k" && request.method === "GET") {
        return getLineupKFeatureStatus(env, url);
      }
      if (url.pathname === "/api/features/lineup-k/sync" && request.method === "POST") {
        return runLineupKFeatureSync(request, env);
      }
      if (url.pathname === "/api/features/lineup-k/hand-sync" && request.method === "POST") {
        return runLineupKHandProfileSync(request, env);
      }
      if (url.pathname === "/api/features/lineup-k/coverage" && request.method === "GET") {
        return getLineupProfileCoverage(env, url);
      }
      if (url.pathname === "/api/features/lineup-k/coverage-backfill" && request.method === "POST") {
        return runLineupProfileBackfill(request, env);
      }
      if (url.pathname === "/api/features/pitcher-daily" && request.method === "GET") {
        return getPitcherDailyFeatureStatus(env, url);
      }
      if (url.pathname === "/api/features/pitcher-daily/sync" && request.method === "POST") {
        return runPitcherDailyFeatureSync(request, env);
      }
      if (url.pathname === "/api/features/team-daily" && request.method === "GET") {
        return getTeamDailyFeatureStatus(env, url);
      }
      if (url.pathname === "/api/features/team-daily/sync" && request.method === "POST") {
        return runTeamDailyFeatureSync(request, env);
      }
      if (url.pathname === "/api/features/prop-snapshots" && request.method === "GET") {
        return getPropFeatureSnapshotStatus(env, url);
      }
      if (url.pathname === "/api/backtest-archive-reconstruction/run" && request.method === "POST") {
        return runArchiveHistoricalReconstruction(request, env);
      }
      if (url.pathname === "/api/backtest-archive-reconstruction" && request.method === "GET") {
        return getArchiveHistoricalReconstructionStatus(env);
      }
      if (url.pathname === "/api/backtest-archive-intake" && request.method === "GET") {
        return getHistoricalArchiveIntakeStatus(env);
      }
      if (url.pathname === "/api/backtest-reconstruction" && request.method === "GET") {
        return getHistoricalFeatureReconstructionStatus(env);
      }
      if (url.pathname === "/api/backtest-reconstruction/run" && request.method === "POST") {
        return runHistoricalFeatureReconstruction(request, env);
      }
      if (url.pathname === "/api/backtest-independent-reconstruction" && request.method === "GET") {
        return getIndependentHistoricalReconstructionStatus(env);
      }
      if (url.pathname === "/api/backtest-independent-reconstruction/run" && request.method === "POST") {
        return runIndependentHistoricalReconstruction(request, env);
      }
      if (url.pathname === "/api/backtest-opponent-reconstruction" && request.method === "GET") {
        return getHistoricalOpponentReconstructionStatus(env);
      }
      if (url.pathname === "/api/backtest-opponent-reconstruction/run" && request.method === "POST") {
        return runHistoricalOpponentReconstruction(env);
      }
      if (url.pathname === "/api/backtest-certification" && request.method === "GET") {
        return getBackfillCertificationStatus(env);
      }
      if (url.pathname === "/api/backtest-certification/run" && request.method === "POST") {
        return runBackfillCertification(env);
      }
      if (url.pathname === "/api/backtest-certification/archive/run" && request.method === "POST") {
        return runArchiveBackfillCertification(env);
      }
      if (url.pathname === "/api/backtest-dataset" && request.method === "GET") {
        return getHistoricalDatasetStatus(env, url);
      }
      if (url.pathname === "/api/backtest-dataset/build" && request.method === "POST") {
        return buildHistoricalDataset(request, env, "ADMIN");
      }
      if (url.pathname === "/api/backtests/walk-forward" && request.method === "GET") {
        return getWalkForwardBacktestStatus(env, url);
      }
      if (url.pathname === "/api/backtests/walk-forward/run" && request.method === "POST") {
        return runWalkForwardBacktest(request, env);
      }
      if (url.pathname === "/api/backtests/segments" && request.method === "GET") {
        return getBacktestSegmentStatus(env, url);
      }
      if (url.pathname === "/api/models/comparison" && request.method === "GET") {
        return getModelComparison(env, url);
      }
      if (url.pathname === "/api/backtests/feature-diagnostics" && request.method === "GET") {
        return getFeatureDiagnostics(env, url);
      }
      if (url.pathname === "/api/backtests/lineup-challenger" && request.method === "GET") {
        return getLineupChallengerReplay(env, url);
      }
      if (url.pathname === "/api/backtests/lineup-challenger/reconstruct-date" && request.method === "POST") {
        return reconstructLineupReplayDate(request, env);
      }
      if (url.pathname === "/api/backtests/lineup-diagnostics" && request.method === "GET") {
        return getLineupSignalDiagnostics(env, url);
      }
      if (url.pathname === "/api/statcast/foundation" && request.method === "GET") {
        return getStatcastFoundationStatus(env);
      }
      if (url.pathname === "/api/statcast/sync-date" && request.method === "POST") {
        return syncStatcastDate(request, env);
      }
      if (url.pathname === "/api/statcast/daily-features" && request.method === "GET") {
        return getStatcastDailyFeatureStatus(env, url);
      }
      if (url.pathname === "/api/statcast/daily-features/build" && request.method === "POST") {
        return buildStatcastDailyFeatures(request, env);
      }
      if (url.pathname === "/api/statcast/backfill" && request.method === "GET") return getStatcastBackfillStatus(env);
      if (url.pathname === "/api/statcast/backfill/certify" && request.method === "POST") return certifyStatcastBackfill(env);
      if (url.pathname === "/api/context/game" && request.method === "GET") return getGameContextStatus(env, url);
      if (url.pathname === "/api/context/game/sync" && request.method === "POST") return syncGameContextDate(request, env);
      if (url.pathname === "/api/context/backfill" && request.method === "GET") return getContextBackfillStatus(env);
      if (url.pathname === "/api/context/backfill/run" && request.method === "POST") return runContextBackfillBatch(request, env);
      if (url.pathname === "/api/context/features" && request.method === "GET") return getHistoricalContextFeatureStatus(env);
      if (url.pathname === "/api/context/features/build" && request.method === "POST") return buildHistoricalContextFeatures(request, env);
      if (url.pathname === "/api/context/challenger" && request.method === "GET") return getContextChallengerReplay(env);
      if (url.pathname === "/api/context/challenger/run-date" && request.method === "POST") return runContextReplayDate(request, env);
      if (url.pathname === "/api/statcast/challenger" && request.method === "GET") return getStatcastChallengerReplay(env);
      if (url.pathname === "/api/statcast/challenger/run-date" && request.method === "POST") return runStatcastReplayDate(request, env);
      if (url.pathname === "/api/backtests/learned-challenger" && request.method === "GET") {
        return getLearnedChallengerReplay(env, url);
      }
      if (url.pathname === "/api/backtests/performance" && request.method === "GET") {
        return getBacktestPerformanceStatus(env, url);
      }
      if (url.pathname === "/api/backtests/performance/run" && request.method === "POST") {
        return runBacktestPerformanceMetrics(request, env);
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
      autoSyncMlbSchedule(env, controller.scheduledTime),
      autoSyncMlbPitcherLogs(env, controller.scheduledTime),
      autoSyncTeamStrikeoutSplits(env, controller.scheduledTime),
      autoSyncPitcherDailyFeatures(env, controller.scheduledTime),
      autoSyncTeamDailyFeatures(env, controller.scheduledTime),
      autoRefreshPregameBoards(env, controller.scheduledTime),
      autoGradePreviousBoard(env, controller.scheduledTime)
        .then(() => settleTrackedPlays(env))
        .then(() => undefined),
    ]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;


