const state = {
  rows: [],
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
    const searchable = `${row.pitcher ?? ""} ${row.opponent ?? ""}`.toLowerCase();
    const searchMatches = !search || searchable.includes(search);
    const decisionMatches = !decision || row.model_decision === decision;
    return searchMatches && decisionMatches;
  });
}

function renderRows() {
  const rows = filteredRows();
  const body = $("#board-body");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="loading">No matching props.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => {
    const edge = Number(row.model_edge);
    const edgeClass = Number.isFinite(edge) ? (edge > 0 ? "positive" : edge < 0 ? "negative" : "") : "";

    return `
      <tr>
        <td><strong>${escapeHtml(row.pitcher)}</strong></td>
        <td>${escapeHtml(row.opponent ?? "—")}</td>
        <td class="num">${number(row.strikeout_line, 1)}</td>
        <td class="num">${number(row.projected_strikeouts, 2)}</td>
        <td class="num ${edgeClass}">${number(row.model_edge, 2)}</td>
        <td class="num">${percent(row.estimated_over_rate)}</td>
        <td>${escapeHtml(row.preferred_side ?? "—")}</td>
        <td class="num">${number(row.confidence_score, 1)} ${row.confidence_band ? `<small>${escapeHtml(row.confidence_band)}</small>` : ""}</td>
        <td>${escapeHtml(row.decision_tier ?? "—")}</td>
        <td><span class="badge ${badgeClass(row.model_decision)}">${escapeHtml(row.model_decision ?? "—")}</span></td>
        <td class="reason">${escapeHtml(row.final_reason ?? "")}</td>
      </tr>
    `;
  }).join("");
}

async function loadDashboard() {
  $("#error-box").classList.add("hidden");
  $("#api-status").textContent = "Loading…";
  $("#api-status").className = "status";

  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const board = data.board ?? {};
    const summary = data.summary ?? {};

    $("#board-name").textContent = board.board_name ?? "No board";
    $("#board-date").textContent = board.board_date ?? "—";
    $("#board-status").textContent = board.status ?? "—";

    $("#count-props").textContent = summary.props ?? 0;
    $("#count-plays").textContent = summary.plays ?? 0;
    $("#count-leans").textContent = summary.leans ?? 0;
    $("#count-watches").textContent = summary.watches ?? 0;
    $("#count-passes").textContent = summary.passes ?? 0;

    state.rows = data.recommendations ?? [];
    renderRows();

    $("#api-status").textContent = "API connected";
    $("#api-status").className = "status ok";
  } catch (error) {
    console.error(error);
    $("#api-status").textContent = "API error";
    $("#api-status").className = "status bad";
    $("#error-box").textContent = error instanceof Error ? error.message : String(error);
    $("#error-box").classList.remove("hidden");
    $("#board-body").innerHTML = `<tr><td colspan="11" class="loading">Unable to load board.</td></tr>`;
  }
}

$("#search").addEventListener("input", renderRows);
$("#decision-filter").addEventListener("change", renderRows);
$("#refresh-button").addEventListener("click", loadDashboard);

loadDashboard();
