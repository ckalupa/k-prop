const state = {
  rows: [],
  yesterdayRows: [],
  selectedBoardId: null,
};

const $ = (selector) => document.querySelector(selector);

function number(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

function percent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : "—";
}

function formatTimestamp(value) {
  if (!value) return "—";

  const raw = String(value).trim();
  const hasTimezone =
    /[zZ]$/.test(raw) ||
    /[+-]\d{2}:?\d{2}$/.test(raw);

  const normalized = hasTimezone
    ? raw
    : raw.includes("T")
      ? `${raw}Z`
      : `${raw.replace(" ", "T")}Z`;

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}


function shortModelName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";
  const match = raw.match(/^v\d+(?:\.\d+)?/i);
  return match ? match[0] : raw;
}

function badgeClass(value) {
  return String(value ?? "").toLowerCase().replaceAll(" ", "-");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filteredRows() {
  const search = $("#search").value.trim().toLowerCase();
  const decision = $("#decision-filter").value;

  return state.rows.filter((row) => {
    const searchable = `${row.pitcher ?? ""} ${row.pitcher_team ?? ""} ${row.opponent ?? ""}`.toLowerCase();
    const searchMatches = !search || searchable.includes(search);
    const decisionMatches = !decision || row.model_decision === decision;
    return searchMatches && decisionMatches;
  });
}

function dashboardConfirmationResearch(row) {
  const priorN = Number(row.market_residual_prior_n || 0);
  const priorAvg = Number(row.market_residual_prior_avg);
  const side = String(row.preferred_side || "").toUpperCase();

  if (priorN < 3 || !Number.isFinite(priorAvg) || (side !== "MORE" && side !== "LESS")) {
    return { score: 0, label: "—", residual: null, priorN };
  }

  const shrunk = priorAvg * priorN / (priorN + 5);
  const aligned = side === "MORE" ? shrunk : -shrunk;
  const strength = Math.abs(shrunk);

  if (aligned >= 0.50) {
    if (strength < 0.75) return { score: 1, label: "MODERATE", residual: shrunk, priorN };
    if (strength < 1.00) return { score: 2, label: "STRONG", residual: shrunk, priorN };
    if (strength < 1.25) return { score: 3, label: "ELITE", residual: shrunk, priorN };
    return { score: 1, label: "EXTREME", residual: shrunk, priorN };
  }

  if (aligned <= -0.50) {
    if (strength < 0.75) return { score: -1, label: "CONFLICT", residual: shrunk, priorN };
    return { score: -2, label: "STRONG CONFLICT", residual: shrunk, priorN };
  }

  return { score: 0, label: "NEUTRAL", residual: shrunk, priorN };
}

function dashboardConfirmationCell(row) {
  const c = dashboardConfirmationResearch(row);
  if (c.label === "—") {
    return `<span class="subtle" title="Research only; fewer than 3 prior graded props.">—</span>`;
  }

  const score = c.score > 0 ? `+${c.score}` : String(c.score);
  const residual = `${c.residual >= 0 ? "+" : ""}${Number(c.residual).toFixed(2)} K`;

  const shortLabel = {
    "MODERATE": "MOD",
    "STRONG": "STRONG",
    "ELITE": "ELITE",
    "EXTREME": "EXTREME",
    "CONFLICT": "CONFLICT",
    "STRONG CONFLICT": "STRONG CONFLICT",
    "NEUTRAL": "NEUTRAL",
  }[c.label] || c.label;

  return `<span class="confirm-signal confirm-score-${c.score}" title="Research only. Prior graded props only; shrunk market residual. ${residual}, n=${c.priorN}. Does not change v14 direction or probability."><strong>${escapeHtml(score)}</strong><small>${escapeHtml(shortLabel)}</small><small>${escapeHtml(residual)} · n=${c.priorN}</small></span>`;
}
function renderRows() {
  const rows = filteredRows();
  const body = $("#board-body");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="15" class="loading">No matching props.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => {
    const edge = Number(row.model_edge);
    const edgeClass = Number.isFinite(edge) ? (edge > 0 ? "positive" : edge < 0 ? "negative" : "") : "";

    return `
      <tr>
        <td>
          <strong>${escapeHtml(row.pitcher)}</strong>
          ${row.pitcher_team ? `<small class="pitcher-team">${escapeHtml(row.pitcher_team)}</small>` : ""}
        </td>
        <td>${escapeHtml(row.opponent ?? "—")}</td>
        <td class="num">${number(row.strikeout_line, 1)}</td>
        <td class="num">${number(row.projected_strikeouts, 2)}</td>
        <td class="num ${edgeClass}">${number(row.model_edge, 2)}</td>
        <td class="num">${percent(row.estimated_over_rate)}</td>
        <td>${escapeHtml(row.preferred_side ?? "—")}</td>
        <td class="num">${number(row.confidence_score, 1)} ${row.confidence_band ? `<small>${escapeHtml(row.confidence_band)}</small>` : ""}</td>
                <td>${dashboardConfirmationCell(row)}</td>
<td>${escapeHtml(row.decision_tier ?? "—")}</td>
        <td>${row.model_decision
          ? `<span class="badge ${badgeClass(row.model_decision)}">${escapeHtml(row.model_decision)}</span>`
          : `<span class="badge history-missing">Not stored</span>`}
        </td>
        <td class="num">${number(row.actual_strikeouts, 0)}</td>
        <td class="${outcomeClass(row.result)}">${escapeHtml(row.result ?? row.result_status ?? "—")}</td>
        <td class="${outcomeClass(recommendationOutcome(row))}">${escapeHtml(recommendationOutcome(row))}</td>
        <td class="reason">${escapeHtml(
          row.final_reason ??
          (row.result_status && row.result_status !== "PENDING"
            ? "Actual result is available; original recommendation was not stored."
            : "")
        )}</td>
      </tr>
    `;
  }).join("");
}


function recordText(wins, losses, pushes) {
  return `${Number(wins || 0)}-${Number(losses || 0)}-${Number(pushes || 0)}`;
}

function outcomeClass(value) {
  return `outcome-${String(value || "").toLowerCase().replaceAll(" ", "-")}`;
}

function recommendationOutcome(row) {
  const result = String(row.result ?? "").toUpperCase();
  const side = String(row.preferred_side ?? "").toLowerCase();

  if (!result || result === "PENDING") return "PENDING";
  if (result === "PUSH") return "PUSH";
  if (result === "VOID") return "VOID";
  if (!row.model_decision) return "NOT STORED";

  if (side === "more") return result === "OVER" ? "WIN" : "LOSS";
  if (side === "less") return result === "UNDER" ? "WIN" : "LOSS";
  return "UNKNOWN";
}


function hitRateText(row) {
  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);
  const graded = wins + losses;
  return graded > 0 ? `${((wins / graded) * 100).toFixed(1)}%` : "0.0%";
}

function renderCategoryPerformance(data) {
  const cumulative = Object.fromEntries(
    (data.category_records ?? []).map((row) => [String(row.category || "").toUpperCase(), row]),
  );
  const daily = Object.fromEntries(
    (data.daily_category_records ?? []).map((row) => [String(row.category || "").toUpperCase(), row]),
  );

  const boardDate = data.board?.board_date ?? "—";
  $("#category-through-date").textContent = `Through ${boardDate}`;

  const categories = [
    ["CORE", "core"],
    ["SECONDARY", "secondary"],
    ["LEAN", "lean"],
  ];

  for (const [category, id] of categories) {
    const totalRow = cumulative[category] ?? {};
    const dayRow = daily[category] ?? {};

    $(`#category-${id}-record`).textContent = recordText(
      totalRow.wins,
      totalRow.losses,
      totalRow.pushes,
    );
    $(`#category-${id}-daily`).textContent = `Today ${recordText(
      dayRow.wins,
      dayRow.losses,
      dayRow.pushes,
    )}`;
    $(`#category-${id}-rate`).textContent = hitRateText(totalRow);
  }
}

function renderYesterday(data) {
  const section = $("#yesterday-section");
  const yesterday = data.yesterday;

  if (!yesterday?.board) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  $("#yesterday-date").textContent = yesterday.board.board_date ?? "—";

  const summary = yesterday.summary ?? {};
  const yesterdayCategories = Object.fromEntries(
    (yesterday.category_records ?? []).map((row) => [String(row.category || "").toUpperCase(), row]),
  );

  $("#yesterday-core-record").textContent = recordText(
    yesterdayCategories.CORE?.wins,
    yesterdayCategories.CORE?.losses,
    yesterdayCategories.CORE?.pushes,
  );
  $("#yesterday-secondary-record").textContent = recordText(
    yesterdayCategories.SECONDARY?.wins,
    yesterdayCategories.SECONDARY?.losses,
    yesterdayCategories.SECONDARY?.pushes,
  );
  $("#yesterday-category-lean-record").textContent = recordText(
    yesterdayCategories.LEAN?.wins,
    yesterdayCategories.LEAN?.losses,
    yesterdayCategories.LEAN?.pushes,
  );

  $("#yesterday-more-record").textContent = recordText(
    summary.more_wins,
    summary.more_losses,
    summary.more_pushes,
  );
  $("#yesterday-play-record").textContent = recordText(
    summary.play_wins,
    summary.play_losses,
    summary.play_pushes,
  );
  $("#yesterday-lean-record").textContent = recordText(
    summary.lean_wins,
    summary.lean_losses,
    summary.lean_pushes,
  );

  const lifetime = Object.fromEntries(
    (data.lifetime_records ?? []).map((row) => [row.record_group, row]),
  );

  $("#lifetime-more-record").textContent = recordText(
    lifetime.MORE?.wins,
    lifetime.MORE?.losses,
    lifetime.MORE?.pushes,
  );
  $("#lifetime-play-record").textContent = recordText(
    lifetime.PLAY?.wins,
    lifetime.PLAY?.losses,
    lifetime.PLAY?.pushes,
  );
  $("#lifetime-lean-record").textContent = recordText(
    lifetime.LEAN?.wins,
    lifetime.LEAN?.losses,
    lifetime.LEAN?.pushes,
  );

  state.yesterdayRows = yesterday.rows ?? [];
  const body = $("#yesterday-results-body");

  if (!state.yesterdayRows.length) {
    body.innerHTML =
      `<tr><td colspan="8" class="loading">No completed PLAY or LEAN recommendations.</td></tr>`;
    return;
  }

  body.innerHTML = state.yesterdayRows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.pitcher)}</strong></td>
      <td>${escapeHtml(row.opponent ?? "—")}</td>
      <td class="num">${number(row.strikeout_line, 1)}</td>
      <td>${escapeHtml(row.preferred_side ?? "—")}</td>
      <td><span class="badge ${badgeClass(row.model_decision)}">${escapeHtml(row.model_decision ?? "—")}</span></td>
      <td class="num">${number(row.actual_strikeouts, 0)}</td>
      <td>${escapeHtml(row.result ?? "—")}</td>
      <td class="${outcomeClass(row.model_outcome)}">${escapeHtml(row.model_outcome ?? "—")}</td>
    </tr>
  `).join("");
}

async function loadDashboard(boardId = state.selectedBoardId) {
  $("#error-box").classList.add("hidden");
  $("#api-status").textContent = "Loading…";
  $("#api-status").className = "status";

  try {
    const dashboardUrl = boardId
      ? `/api/dashboard?board_id=${encodeURIComponent(boardId)}`
      : "/api/dashboard";
    const response = await fetch(dashboardUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const board = data.board ?? {};
    const summary = data.summary ?? {};
    const meta = data.dashboard_meta ?? {};

    const boardSelect = $("#dashboard-board-select");
    const workflowBoards = Array.isArray(data.workflow_boards)
      ? data.workflow_boards
      : [];

    const previousValue = state.selectedBoardId == null
      ? ""
      : String(state.selectedBoardId);

    boardSelect.innerHTML = workflowBoards.map((row) => {
      const label =
        `${row.board_date} — ${row.board_name} [${row.status}] ` +
        `(${Number(row.prop_count || 0)} props)`;
      return `<option value="${escapeHtml(row.board_id)}">${escapeHtml(label)}</option>`;
    }).join("");

    if (!workflowBoards.length) {
      boardSelect.innerHTML = `<option value="">No dashboards available</option>`;
    }

    if (previousValue && workflowBoards.some((row) => String(row.board_id) === previousValue)) {
      boardSelect.value = previousValue;
    } else if (board.board_id != null) {
      boardSelect.value = String(board.board_id);
      state.selectedBoardId = Number(board.board_id);
    }

    $("#board-name").textContent = board.board_name ?? "No board";
    $("#board-date").textContent = board.board_date ?? "—";
    $("#board-status").textContent = board.status ?? "—";
    const productionModel = data.active_production_model?.version_name ?? "";
    $("#active-model").textContent = shortModelName(productionModel);
    $("#active-model").title = productionModel || "Active production model unavailable";
    $("#grading-status").textContent = meta.grading_status ?? "—";
    $("#last-updated").textContent = formatTimestamp(meta.last_updated_at ?? meta.generated_at);

    $("#count-props").textContent = summary.props ?? 0;
    $("#count-plays").textContent = summary.plays ?? 0;
    $("#count-leans").textContent = summary.leans ?? 0;
    $("#count-watches").textContent = summary.watches ?? 0;
    $("#count-passes").textContent = summary.passes ?? 0;

    const historyNotice = $("#history-notice");
    const hasRecommendationHistory =
      meta.recommendation_history_available === true ||
      Number(summary.processed || 0) > 0;
    const hasSettledResults = Number(summary.settled || 0) > 0;

    if (!hasRecommendationHistory && hasSettledResults) {
      historyNotice.innerHTML =
        `<strong>Results available — original recommendation history was not stored.</strong>` +
        `<span> Actual strikeouts and market outcomes are shown below. PLAY/LEAN records cannot be reconstructed for this board.</span>`;
      historyNotice.classList.remove("hidden");
    } else if (!hasRecommendationHistory) {
      historyNotice.innerHTML =
        `<strong>No recommendation history is stored for this board.</strong>`;
      historyNotice.classList.remove("hidden");
    } else {
      historyNotice.classList.add("hidden");
      historyNotice.textContent = "";
    }

    state.rows = data.recommendations ?? [];
    renderRows();
    renderCategoryPerformance(data);
    renderYesterday(data);

    $("#api-status").textContent = "API connected";
    $("#api-status").className = "status ok";
  } catch (error) {
    console.error(error);
    $("#api-status").textContent = "API error";
    $("#api-status").className = "status bad";
    $("#error-box").textContent = error instanceof Error ? error.message : String(error);
    $("#error-box").classList.remove("hidden");
    $("#board-body").innerHTML = `<tr><td colspan="15" class="loading">Unable to load board.</td></tr>`;
  }
}

$("#search").addEventListener("input", renderRows);
$("#decision-filter").addEventListener("change", renderRows);

$("#dashboard-board-select").addEventListener("change", async (event) => {
  const value = Number(event.target.value);
  state.selectedBoardId = Number.isInteger(value) && value > 0 ? value : null;
  await loadDashboard(state.selectedBoardId);
});

$("#refresh-button").addEventListener("click", () => loadDashboard(state.selectedBoardId));

loadDashboard();
