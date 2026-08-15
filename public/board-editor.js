
const state = {
  identity: null,
  pitchers: [],
  teams: [],
  boards: [],
  board: null,
  props: [],
  importRows: [],
  calibration: null,
  automation: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = String(value);
  element.textContent = label;
  return element;
}

function message(text, kind = "") {
  const box = $("#board-message");
  box.textContent = text;
  box.className = `editor-message ${kind}`;
}

function syncButtons() {
  const editable = state.board?.status === "DRAFT";
  const refreshable = ["DRAFT", "ACTIVE"].includes(state.board?.status);

  $("#save-board").disabled = !editable;
  $("#process-board").disabled = !refreshable || !state.props.length;
  $("#grade-results").disabled = !state.board || !state.props.length || state.board.status === "DRAFT";
  $("#pregame-checks").disabled = !state.board || !state.props.length;
  $("#activate-board").disabled = !editable;
  $("#add-prop").disabled = !editable;
  $("#preview-import").disabled = !editable;

  if (!editable) {
    $("#run-import").disabled = true;
  }
}

function renderBootstrap() {
  $("#identity").textContent = state.identity?.email || "Authenticated";

  const pitcher = $("#pitcher-select");
  pitcher.innerHTML = "";
  for (const row of state.pitchers) {
    pitcher.append(option(row.pitcher_id, `${row.canonical_name}${row.throws_hand ? ` (${row.throws_hand})` : ""}`));
  }

  const opponent = $("#opponent-select");
  opponent.innerHTML = "";
  opponent.append(option("", "Unknown / not set"));
  for (const row of state.teams) {
    opponent.append(option(row.team_id, `${row.abbreviation} — ${row.full_name || ""}`));
  }

  const boardSelect = $("#board-select");
  boardSelect.innerHTML = "";
  boardSelect.append(option("", "Select a board"));
  for (const row of state.boards) {
    boardSelect.append(option(
      row.board_id,
      `${row.board_date} — ${row.board_name || "Untitled"} [${row.status}] (${row.prop_count})`,
    ));
  }
}


function formatNumber(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function decisionClass(value) {
  return `decision-${String(value ?? "unprocessed").toLowerCase().replace(/\s+/g, "-")}`;
}

function resultClass(value) {
  return `result-${String(value ?? "pending").toLowerCase()}`;
}


const CLASSIFICATION_OPTIONS = [
  "", "PASS", "WATCH", "SHEET LEAN", "STRONG LEAN", "CORE CANDIDATE", "FINAL CARD",
];

const POSTGAME_REASON_OPTIONS = [
  "", "NORMAL_VARIANCE_REVIEW", "LINE_ACCURATE", "LOW_PITCH_COUNT",
  "LOW_BATTERS_FACED", "ROLE_CHANGE", "POOR_COMMAND", "BLOWUP_OUTING",
  "INJURY", "WEATHER_DELAY", "UNEXPECTED_LINEUP", "MODEL_MISS", "OTHER",
];

function selectOptions(values, selected) {
  return values.map(value =>
    `<option value="${escapeHtml(value)}" ${String(value) === String(selected ?? "") ? "selected" : ""}>${escapeHtml(value || "—")}</option>`
  ).join("");
}

function checked(value) {
  return Number(value) === 1 ? "checked" : "";
}

function recommendationScoreCell(row) {
  if (row.recommendation_score == null) return "—";
  const score = Math.round(Number(row.recommendation_score));
  const band = row.recommendation_band || "UNRANKED";
  return `<div class="v11-score ${decisionClass(band)}"><strong>${score}</strong><span>${escapeHtml(band)}</span></div>`;
}

function recommendationBreakdownCell(row) {
  if (row.recommendation_score == null) return "—";
  const item = (name, value, max) => `<span><small>${escapeHtml(name)}</small><strong>${formatNumber(value, 1)} / ${max}</strong></span>`;
  const sameOpponent = Number(row.same_opponent_start_count || 0);
  const calibrationSample = Number(row.calibration_sample_size || 0);
  const history = `<div class="v12-history">
    <span><small>Base projection</small><strong>${formatNumber(row.base_projected_strikeouts, 2)}</strong></span>
    <span><small>Matchup projection</small><strong>${formatNumber(row.matchup_projected_strikeouts, 2)}</strong></span>
    <span><small>Same opponent</small><strong>${sameOpponent >= 2 ? `${sameOpponent} starts · ${Number(row.same_opponent_adjustment || 0) >= 0 ? "+" : ""}${formatNumber(row.same_opponent_adjustment, 2)} K` : `${sameOpponent} start(s) · no nudge`}</strong></span>
    <span><small>Calibration</small><strong>${calibrationSample ? `${Number(row.calibration_adjustment || 0) >= 0 ? "+" : ""}${formatNumber(row.calibration_adjustment, 0)} score · n=${calibrationSample} · ${formatNumber(Number(row.calibration_hit_rate || 0) * 100, 1)}%` : "No qualifying sample"}</strong></span>
  </div>`;
  return `<details class="v11-breakdown"><summary>Scorecard</summary><div class="v11-components">
    ${item("Projection", row.score_projection, 30)}
    ${item("Recent", row.score_recent_form, 15)}
    ${item("Volume", row.score_volume, 15)}
    ${item("Matchup", row.score_matchup, 20)}
    ${item("Role", row.score_role, 10)}
    ${item("Complete", row.score_completeness, 10)}
  </div>${history}</details>`;
}

function lifecycleCell(row) {
  const initial = row.initial_classification || row.model_decision || "—";
  const finalValue = row.final_classification || initial;
  const completeness = row.completeness_score == null ? "—" : `${Number(row.completeness_score)}%`;
  const badge = (label, value) => `<span class="auto-status ${Number(value) === 1 ? "is-ready" : "is-pending"}">${escapeHtml(label)} ${Number(value) === 1 ? "✓" : "·"}</span>`;
  return `
    <div class="lifecycle-editor lifecycle-v10">
      <div class="auto-lifecycle-summary">
        <span><small>Initial · auto</small><strong>${escapeHtml(initial)}</strong></span>
        <span><small>Open · auto</small><strong>${row.opening_line ?? row.strikeout_line ?? "—"}</strong></span>
        <span><small>Rec · auto</small><strong>${row.recommended_line ?? row.strikeout_line ?? "—"}</strong></span>
        <span><small>Complete</small><strong>${escapeHtml(completeness)}</strong></span>
      </div>
      <label>Final override<select data-field="final_classification">${selectOptions(CLASSIFICATION_OPTIONS, finalValue)}</select></label>
      <div class="inline-checks">
        <label><input data-field="final_card" type="checkbox" ${checked(row.final_card)}> Final card</label>
        <label><input data-field="actually_played" type="checkbox" ${checked(row.actually_played)}> Played</label>
      </div>
      <label>Closing line <span class="subtle">optional</span><input data-field="closing_line" type="number" step="0.5" value="${row.closing_line ?? ""}"></label>
      <div class="automated-checks">
        ${badge("Starter", row.starter_confirmed)}
        ${badge("Lineup", row.lineup_confirmed)}
        ${badge("Weather", row.weather_checked)}
        ${badge("Umpire", row.umpire_checked)}
      </div>
      ${pregameStatus(row)}
      <span class="subtle">Checked: ${formatTimestamp(row.last_pregame_checked_at)}</span>
      <button data-action="save-lifecycle" type="button">Save final choices</button>
    </div>`;
}

function postgameCell(row) {
  if (!row.result || row.result === "PENDING") return "—";
  const chosen = row.postgame_reason_code || row.suggested_reason_code || "";
  return `
    <div class="postgame-editor">
      <span class="subtle">Suggested: ${escapeHtml(row.suggested_reason_code || "—")}</span>
      <select data-field="postgame_reason_code">${selectOptions(POSTGAME_REASON_OPTIONS, chosen)}</select>
      <input data-field="early_exit_reason" type="text" maxlength="500" placeholder="Optional note" value="${escapeHtml(row.early_exit_reason || "")}">
      <button data-action="save-postgame" type="button">Save review</button>
      <span class="subtle">${escapeHtml(row.postgame_review_status || "UNREVIEWED")}</span>
    </div>`;
}


function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString();
}

function renderAutomationStatus() {
  const panel = $("#automation-status");
  if (!state.board || !state.automation) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const summary = state.automation.summary || {};
  const runs = Array.isArray(state.automation.recent_runs) ? state.automation.recent_runs : [];
  const stale = Number(summary.stale_props || 0);
  const latest = runs[0];
  const statusClass = stale > 0 ? "has-warning" : Number(summary.ready_props || 0) > 0 ? "is-healthy" : "is-pending";

  panel.hidden = false;
  panel.className = `automation-status-panel ${statusClass}`;
  panel.innerHTML = `
    <div class="automation-status-heading">
      <div>
        <h3>Automation status</h3>
        <p>Pregame checks retry every five minutes from 30 to 5 minutes before first pitch.</p>
      </div>
      <span class="automation-health">${stale > 0 ? `${stale} stale` : latest?.status === "FAILED" ? "Last run failed" : "Monitoring"}</span>
    </div>
    <div class="automation-metrics">
      <div><span>Ready</span><strong>${Number(summary.ready_props || 0)}</strong></div>
      <div><span>Partial</span><strong>${Number(summary.partial_props || 0)}</strong></div>
      <div><span>Pending</span><strong>${Number(summary.pending_props || 0)}</strong></div>
      <div><span>Stale</span><strong>${stale}</strong></div>
    </div>
    <div class="automation-times">
      <span><strong>Last checked:</strong> ${formatTimestamp(summary.last_checked_at)}</span>
      <span><strong>Last successful MLB refresh:</strong> ${formatTimestamp(summary.last_successful_refresh_at)}</span>
      <span><strong>Latest run:</strong> ${latest ? `${escapeHtml(latest.trigger_source)} · ${escapeHtml(latest.status)} · ${formatTimestamp(latest.completed_at || latest.started_at)}` : "None yet"}</span>
    </div>
    ${runs.length ? `<details class="automation-history"><summary>Recent automation runs</summary><ul>${runs.map(run => `
      <li><strong>${escapeHtml(run.trigger_source)}</strong> ${escapeHtml(run.status)} — ${formatTimestamp(run.completed_at || run.started_at)} · ${Number(run.games_checked || 0)} game(s), ${Number(run.props_matched || 0)} prop(s), ${Number(run.stale_props || 0)} stale</li>
    `).join("")}</ul></details>` : ""}
  `;
}

function pregameStatus(row) {
  const status = row.pregame_check_status || "PENDING";
  const firstPitch = row.scheduled_first_pitch ? new Date(row.scheduled_first_pitch).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  return `<div class="pregame-row-status status-${escapeHtml(status.toLowerCase())}" title="${escapeHtml(row.pregame_check_message || "")}">
    <strong>${escapeHtml(status)}</strong><span>${escapeHtml(firstPitch)}</span>
  </div>`;
}

function renderBoard() {
  $("#board-date").value = state.board?.board_date || "";
  $("#board-name").value = state.board?.board_name || "";
  $("#board-select").value = state.board?.board_id ? String(state.board.board_id) : "";
  syncButtons();
  renderAutomationStatus();

  const body = $("#prop-body");
  if (!state.board) {
    body.innerHTML = `<tr><td colspan="25" class="loading">Select or create a draft board.</td></tr>`;
    return;
  }
  if (!state.props.length) {
    body.innerHTML = `<tr><td colspan="25" class="loading">No props on this board.</td></tr>`;
    return;
  }

  body.innerHTML = state.props.map((row) => `
    <tr data-prop-id="${row.prop_id}">
      <td class="sticky-col sticky-col-1">${escapeHtml(row.pitcher)}</td>
      <td class="sticky-col sticky-col-2">${escapeHtml(row.opponent || "—")}</td>
      <td>${Number(row.strikeout_line).toFixed(1)}</td>
      <td>${escapeHtml(row.available_side)}</td>
      <td>${escapeHtml(row.prop_type)}</td>
      <td>${row.opponent_k_rate == null ? "—" : `${formatNumber(Number(row.opponent_k_rate) * 100, 1)}%`}</td>
      <td>${row.handedness_edge == null ? "—" : `${Number(row.handedness_edge) >= 0 ? "+" : ""}${formatNumber(Number(row.handedness_edge) * 100, 1)} pts`}</td>
      <td class="compact-cell">${formatNumber(row.last_3_k_avg)} / ${formatNumber(row.last_5_k_avg)} / ${formatNumber(row.last_10_k_avg)}</td>
      <td class="compact-cell">${row.average_bf_last_5 == null ? "—" : `${formatNumber(row.average_bf_last_5)} BF`}<br><span class="subtle">${row.average_pitch_count_last_5 == null ? "—" : `${formatNumber(row.average_pitch_count_last_5, 0)} pitches`}</span></td>
      <td><span class="gate-pill gate-${String(row.recent_form_gate || "pending").toLowerCase()}">${escapeHtml(row.recent_form_gate || "—")}</span></td>
      <td><span class="gate-pill gate-${String(row.role_gate || "pending").toLowerCase()}">${escapeHtml(row.role_gate || "—")}</span><br><span class="subtle">${row.starter_rate_last_10 == null ? "—" : `${formatNumber(Number(row.starter_rate_last_10) * 100, 0)}% starts`}</span></td>
      <td>${formatNumber(row.projected_strikeouts)}</td>
      <td>${formatNumber(row.model_edge)}</td>
      <td>${escapeHtml(row.preferred_side || "—")}</td>
      <td>${row.confidence_score == null ? "—" : `${formatNumber(row.confidence_score, 0)} (${escapeHtml(row.confidence_band || "—")})`}</td>
      <td>${recommendationScoreCell(row)}</td>
      <td>${recommendationBreakdownCell(row)}</td>
      <td><span class="decision-pill ${decisionClass(row.model_decision)}">${escapeHtml(row.model_decision || "UNPROCESSED")}</span><br><span class="subtle">${escapeHtml(row.model_version_name || "—")}</span></td>
      <td>${lifecycleCell(row)}</td>
      <td>${row.actual_strikeouts == null ? "—" : escapeHtml(row.actual_strikeouts)}</td>
      <td class="compact-cell">${row.innings_pitched == null ? "—" : `${escapeHtml(row.innings_pitched)} IP`}<br><span class="subtle">${row.pitch_count == null ? "—" : `${escapeHtml(row.pitch_count)} pitches`} · ${row.batters_faced == null ? "—" : `${escapeHtml(row.batters_faced)} BF`}</span></td>
      <td><span class="result-pill ${resultClass(row.result)}">${escapeHtml(row.result || "PENDING")}</span></td>
      <td>${postgameCell(row)}</td>
      <td class="reason-cell"><details><summary>View reason</summary><div>${escapeHtml(row.final_reason || "—")}</div></details></td>
      <td>
        <div class="action-group">
          <button data-action="edit" type="button">Edit</button>
          <button data-action="delete" type="button">Delete</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadBootstrap() {
  const data = await api("/api/editor/bootstrap");
  state.identity = data.identity;
  state.pitchers = data.pitchers;
  state.teams = data.teams;
  state.boards = data.boards;
  renderBootstrap();
}

async function loadBoard(boardId) {
  if (!boardId) {
    state.board = null;
    state.props = [];
    state.automation = null;
    renderBoard();
    return;
  }
  const data = await api(`/api/boards/${boardId}`);
  state.board = data.board;
  state.props = data.props;
  state.automation = data.automation || null;
  renderBoard();
}

function formatPercent(value) {
  return value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
}

function calibrationTable(title, rows) {
  if (!rows?.length) return "";
  return `
    <div class="calibration-group">
      <h3>${escapeHtml(title)}</h3>
      <table class="calibration-table">
        <thead><tr><th>Bucket</th><th>W-L</th><th>Hit rate</th><th>Push/Void</th></tr></thead>
        <tbody>${rows.map(row => `
          <tr>
            <td>${escapeHtml(row.label)}</td>
            <td>${row.wins}-${row.losses} <span class="subtle">(${row.graded})</span></td>
            <td>${formatPercent(row.hit_rate)}</td>
            <td>${row.pushes}/${row.voids}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function renderCalibration() {
  const box = $("#calibration-summary");
  const data = state.calibration;
  if (!data) { box.textContent = "No calibration report loaded."; return; }
  const s = data.summary;
  const status = s.calibration_ready ? "READY" : `COLLECTING (${s.settled}/${s.minimum_sample})`;
  box.innerHTML = `
    <div class="calibration-metrics">
      <div><span>Active model</span><strong>${escapeHtml(data.model.version_name)}</strong></div>
      <div><span>Calibration status</span><strong>${status}</strong></div>
      <div><span>Settled record</span><strong>${s.wins}-${s.losses}</strong></div>
      <div><span>Hit rate</span><strong>${formatPercent(s.hit_rate)}</strong></div>
    </div>
    ${!s.calibration_ready ? `<p class="calibration-note">Confidence scores remain descriptive—not empirically calibrated—until at least ${s.minimum_sample} settled recommendations are available.</p>` : ""}
    <div class="calibration-grid">
      ${calibrationTable("Decision", data.by_decision)}
      ${calibrationTable("Confidence", data.by_confidence)}
      ${calibrationTable("Preferred side", data.by_side)}
      ${calibrationTable("Prop type", data.by_prop_type)}
      ${calibrationTable("Form gate", data.by_form)}
      ${calibrationTable("Role gate", data.by_role)}
    </div>`;
}

async function loadCalibration() {
  const button = $("#refresh-calibration");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    state.calibration = await api("/api/calibration");
    renderCalibration();
  } catch (error) {
    $("#calibration-summary").innerHTML = `<p class="editor-message error">${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Refresh Calibration";
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeName(value) {
  return normalizeText(value)
    .replace(/[.'’\-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  const previous = Array.from({ length: a.length + 1 }, (_, index) => index);

  for (let j = 1; j <= b.length; j += 1) {
    const current = [j];
    for (let i = 1; i <= a.length; i += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[i] = Math.min(
        current[i - 1] + 1,
        previous[i] + 1,
        previous[i - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[a.length];
}

function findPitcherByName(name) {
  const target = normalizeName(name);

  if (!target) {
    return { pitcher: null, matchType: null, ambiguous: false };
  }

  const exact = state.pitchers.find(
    (pitcher) => normalizeName(pitcher.canonical_name) === target,
  );
  if (exact) {
    return { pitcher: exact, matchType: "exact", ambiguous: false };
  }

  const targetParts = target.split(" ");
  const targetLastName = targetParts.at(-1);
  const targetFirst = targetParts[0] || "";
  const lastNameMatches = state.pitchers.filter((pitcher) => {
    const candidateParts = normalizeName(pitcher.canonical_name).split(" ");
    const sameLastName = candidateParts.at(-1) === targetLastName;
    const initialMatches = targetFirst.length === 1
      ? candidateParts[0]?.startsWith(targetFirst)
      : true;
    return sameLastName && initialMatches;
  });

  if (lastNameMatches.length === 1) {
    return {
      pitcher: lastNameMatches[0],
      matchType: targetFirst.length === 1 ? "initial-last-name" : "last-name",
      ambiguous: false,
    };
  }

  const fuzzyMatches = state.pitchers
    .map((pitcher) => {
      const candidate = normalizeName(pitcher.canonical_name);
      const distance = levenshteinDistance(target, candidate);
      const longestLength = Math.max(target.length, candidate.length);
      return {
        pitcher,
        distance,
        similarity: longestLength ? 1 - distance / longestLength : 0,
      };
    })
    .filter((match) => match.distance <= 2 && match.similarity >= 0.85)
    .sort((a, b) => b.similarity - a.similarity || a.distance - b.distance);

  if (!fuzzyMatches.length) {
    return { pitcher: null, matchType: null, ambiguous: false };
  }

  if (
    fuzzyMatches.length > 1 &&
    Math.abs(fuzzyMatches[0].similarity - fuzzyMatches[1].similarity) < 0.0001
  ) {
    return { pitcher: null, matchType: null, ambiguous: true };
  }

  return {
    pitcher: fuzzyMatches[0].pitcher,
    matchType: "fuzzy",
    ambiguous: false,
  };
}

const TEAM_ALIASES = {
  ari: "ARI", atl: "ATL", bal: "BAL", bos: "BOS", chc: "CHC", cubs: "CHC",
  chw: "CWS", cws: "CWS", cin: "CIN", cle: "CLE", col: "COL", det: "DET",
  hou: "HOU", kc: "KC", kcr: "KC", laa: "LAA", lad: "LAD", mia: "MIA",
  mil: "MIL", min: "MIN", nym: "NYM", nyy: "NYY", ath: "ATH", oak: "ATH",
  phi: "PHI", pit: "PIT", sd: "SD", sdp: "SD", sea: "SEA", sf: "SF",
  sfg: "SF", stl: "STL", tb: "TB", tbr: "TB", tex: "TEX", tor: "TOR",
  was: "WSH", wsh: "WSH",
};

function findTeamByAbbreviation(abbreviation) {
  const input = normalizeText(abbreviation);
  if (!input) return null;

  const target = TEAM_ALIASES[input] || input.toUpperCase();
  return state.teams.find(
    (team) => String(team.abbreviation).toUpperCase() === target,
  ) ?? null;
}

function propKey({ pitcher, opponent, strikeoutLine, availableSide, propType }) {
  if (!pitcher || !Number.isFinite(strikeoutLine)) return null;
  return [
    Number(pitcher.pitcher_id),
    Number(opponent?.team_id || 0),
    Number(strikeoutLine).toFixed(2),
    normalizeText(availableSide),
    normalizeText(propType),
  ].join("|");
}

function existingPropKeys() {
  return new Set(state.props.map((existing) => propKey({
    pitcher: { pitcher_id: existing.pitcher_id },
    opponent: existing.opponent_team_id
      ? { team_id: existing.opponent_team_id }
      : null,
    strikeoutLine: Number(existing.strikeout_line),
    availableSide: existing.available_side,
    propType: existing.prop_type,
  })).filter(Boolean));
}

function normalizeSide(value) {
  const normalized = normalizeText(value);

  if (normalized === "both") return "Both";

  if (
    normalized === "more only" ||
    normalized === "more-only" ||
    normalized === "more"
  ) {
    return "More only";
  }

  return null;
}

function normalizePropType(value) {
  const normalized = normalizeText(value);

  if (normalized === "standard") return "Standard";

  if (
    normalized === "green goblin" ||
    normalized === "green"
  ) {
    return "Green Goblin";
  }

  if (
    normalized === "red goblin" ||
    normalized === "red"
  ) {
    return "Red Goblin";
  }

  return null;
}

function parseImportRows(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const boardKeys = existingPropKeys();
  const importKeys = new Set();

  return lines
    .filter((line, index) => {
      if (index !== 0) return true;
      return !normalizeText(line).startsWith("pitcher,");
    })
    .map((line, index) => {
      const columns = line.split(",").map((value) => value.trim());
      const [
        pitcherName,
        opponentAbbreviation,
        lineValue,
        sideValue = "Both",
        typeValue = "Standard",
      ] = columns;

      const pitcherMatch = findPitcherByName(pitcherName);
      const pitcher = pitcherMatch.pitcher;
      const opponent = findTeamByAbbreviation(opponentAbbreviation);
      const strikeoutLine = Number(lineValue);
      const availableSide = normalizeSide(sideValue);
      const propType = normalizePropType(typeValue);
      const errors = [];

      if (columns.length < 3) errors.push("Expected at least 3 columns");
      if (!pitcherName) {
        errors.push("Pitcher is required");
      } else if (pitcherMatch.ambiguous) {
        errors.push("Pitcher match is ambiguous");
      } else if (!pitcher) {
        errors.push("Pitcher not found");
      }
      if (opponentAbbreviation && !opponent) errors.push("Opponent not found");
      if (!Number.isFinite(strikeoutLine) || strikeoutLine < 0.5 || strikeoutLine > 15.5) {
        errors.push("Invalid strikeout line");
      }
      if (!availableSide) errors.push("Invalid side");
      if (!propType) errors.push("Invalid prop type");

      const key = propKey({ pitcher, opponent, strikeoutLine, availableSide, propType });
      const duplicateOnBoard = Boolean(key && boardKeys.has(key));
      const duplicateInImport = Boolean(key && importKeys.has(key));
      if (key) importKeys.add(key);

      return {
        rowNumber: index + 1,
        pitcherName,
        pitcher,
        matchType: pitcherMatch.matchType,
        opponentAbbreviation,
        opponent,
        strikeoutLine,
        availableSide,
        propType,
        duplicate: duplicateOnBoard || duplicateInImport,
        duplicateReason: duplicateOnBoard ? "already on board" : duplicateInImport ? "repeated in import" : null,
        errors,
        imported: false,
      };
    });
}

function renderImportPreview() {
  const tbody = $("#import-preview-body");
  tbody.innerHTML = "";

  if (!state.importRows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="loading">No import rows found.</td>
      </tr>
    `;

    $("#run-import").disabled = true;
    return;
  }

  for (const row of state.importRows) {
    const tr = document.createElement("tr");

    let status = "Ready";

    if (row.errors.length) {
      status = row.errors.join("; ");
    } else if (row.imported) {
      status = "Imported";
    } else if (row.duplicate) {
      status = `Duplicate — ${row.duplicateReason}`;
      tr.classList.add("import-status-duplicate");
    } else if (row.matchType === "fuzzy") {
      status = `Ready — matched ${row.pitcher.canonical_name}`;
    } else if (row.matchType === "last-name") {
      status = `Ready — matched ${row.pitcher.canonical_name} by last name`;
    } else if (row.matchType === "initial-last-name") {
      status = `Ready — matched ${row.pitcher.canonical_name} by initial`;
    }

    tr.innerHTML = `
      <td>${row.rowNumber}</td>
      <td>${escapeHtml(row.pitcherName || "")}</td>
      <td>${escapeHtml(row.opponentAbbreviation || "")}</td>
      <td>${
        Number.isFinite(row.strikeoutLine)
          ? row.strikeoutLine.toFixed(1)
          : ""
      }</td>
      <td>${escapeHtml(row.availableSide || "")}</td>
      <td>${escapeHtml(row.propType || "")}</td>
      <td>${escapeHtml(status)}</td>
    `;

    tbody.appendChild(tr);
  }

  const skipDuplicates = $("#skip-duplicates").checked;
  const hasValidRows = state.importRows.some(
    (row) =>
      row.errors.length === 0 &&
      !row.imported &&
      !(skipDuplicates && row.duplicate),
  );

  $("#run-import").disabled =
    !state.board ||
    state.board.status !== "DRAFT" ||
    !hasValidRows;
}

$("#refresh-calibration").addEventListener("click", loadCalibration);

$("#board-select").addEventListener("change", async (event) => {
  try {
    await loadBoard(event.target.value);
    message("");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#create-board").addEventListener("click", async () => {
  try {
    const data = await api("/api/boards", {
      method: "POST",
      body: JSON.stringify({
        board_date: $("#board-date").value,
        board_name: $("#board-name").value,
      }),
    });
    await loadBootstrap();
    await loadBoard(data.board_id);
    message("Draft board created.", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#save-board").addEventListener("click", async () => {
  try {
    await api(`/api/boards/${state.board.board_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        board_date: $("#board-date").value,
        board_name: $("#board-name").value,
      }),
    });
    await loadBootstrap();
    await loadBoard(state.board.board_id);
    message("Board saved.", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#add-prop").addEventListener("click", async () => {
  try {
    await api(`/api/boards/${state.board.board_id}/props`, {
      method: "POST",
      body: JSON.stringify({
        pitcher_id: Number($("#pitcher-select").value),
        opponent_team_id: $("#opponent-select").value ? Number($("#opponent-select").value) : null,
        strikeout_line: Number($("#line-input").value),
        available_side: $("#side-select").value,
        prop_type: $("#type-select").value,
      }),
    });
    await loadBoard(state.board.board_id);
    message("Prop added.", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#preview-import").addEventListener("click", () => {
  const text = $("#bulk-import-text").value;

  state.importRows = parseImportRows(text);
  renderImportPreview();

  const validCount = state.importRows.filter(
    (row) => row.errors.length === 0
  ).length;

  const invalidCount = state.importRows.length - validCount;

  $("#import-message").textContent =
    `${validCount} valid row(s), ${invalidCount} row(s) with errors.`;
});

$("#skip-duplicates").addEventListener("change", () => {
  renderImportPreview();
});

$("#run-import").addEventListener("click", async () => {
  if (!state.board) {
    $("#import-message").textContent =
      "Select or create a draft board first.";
    return;
  }

  const skipDuplicates = $("#skip-duplicates").checked;
  const validRows = state.importRows.filter(
    (row) =>
      row.errors.length === 0 &&
      !row.imported &&
      !(skipDuplicates && row.duplicate),
  );

  if (!validRows.length) {
    $("#import-message").textContent =
      "There are no valid rows to import.";
    return;
  }

  $("#run-import").disabled = true;
  $("#preview-import").disabled = true;

  let importedCount = 0;
  let failedCount = 0;

  for (const row of validRows) {
    try {
      await api(`/api/boards/${state.board.board_id}/props`, {
        method: "POST",
        body: JSON.stringify({
          pitcher_id: Number(row.pitcher.pitcher_id),
          opponent_team_id: row.opponent
            ? Number(row.opponent.team_id)
            : null,
          strikeout_line: row.strikeoutLine,
          available_side: row.availableSide,
          prop_type: row.propType,
        }),
      });

      row.imported = true;
      importedCount += 1;
    } catch (error) {
      row.errors.push(error.message);
      failedCount += 1;
    }

    renderImportPreview();
  }

  await loadBoard(state.board.board_id);

  const skippedDuplicates = state.importRows.filter(
    (row) => row.duplicate && !row.imported,
  ).length;

  $("#import-message").textContent =
    `Imported ${importedCount} prop(s). ` +
    `${skippedDuplicates} duplicate(s) skipped. ` +
    `${failedCount} failed.`;

  $("#preview-import").disabled = false;
  renderImportPreview();
});



async function runRefreshBatches(
  boardId,
  endpoint,
  stageLabel,
  summary,
  totals,
  warnings,
  limit,
) {
  let offset = 0;
  let total = 0;

  do {
    const result = await api(
      `/api/boards/${boardId}/${endpoint}?offset=${offset}&limit=${limit}`,
      { method: "POST" },
    );

    total = Number(result.total || 0);
    const completed = Math.min(Number(result.completed || 0), total);
    const stageWarnings = Array.isArray(result.warning_details)
      ? result.warning_details
      : [];

    warnings.push(...stageWarnings);
    totals.idsResolved += Number(result.ids_resolved || 0);
    totals.pitchersRefreshed += Number(result.pitchers_refreshed || 0);
    totals.gameLogsLoaded += Number(result.game_logs_loaded || 0);
    totals.matchupSplitsLoaded += Number(result.matchup_splits_loaded || 0);

    summary.innerHTML = `
      <p class="process-running">${escapeHtml(stageLabel)} ${completed}/${total}…</p>
      <div class="process-metrics">
        <div><span>MLB IDs resolved</span><strong>${totals.idsResolved}</strong></div>
        <div><span>Pitchers refreshed</span><strong>${totals.pitchersRefreshed}</strong></div>
        <div><span>Game logs loaded</span><strong>${totals.gameLogsLoaded}</strong></div>
        <div><span>Matchup splits</span><strong>${totals.matchupSplitsLoaded}</strong></div>
      </div>
    `;

    offset = result.next_offset == null ? null : Number(result.next_offset);
  } while (offset !== null);
}

$("#process-board").addEventListener("click", async () => {
  if (!state.board || !["DRAFT", "ACTIVE"].includes(state.board.status)) {
    message("Select a draft or active board first.", "error");
    return;
  }

  const boardId = state.board.board_id;
  const button = $("#process-board");
  const summary = $("#process-summary");
  const totals = {
    idsResolved: 0,
    pitchersRefreshed: 0,
    gameLogsLoaded: 0,
    matchupSplitsLoaded: 0,
  };
  const warnings = [];

  button.disabled = true;
  button.textContent = "Refreshing data…";
  summary.hidden = false;
  summary.innerHTML = `<p class="process-running">Starting safe batched refresh…</p>`;

  try {
    // Pitcher refreshes make several outbound requests each, so keep these small.
    await runRefreshBatches(
      boardId,
      "refresh-pitchers",
      "Refreshing pitchers",
      summary,
      totals,
      warnings,
      2,
    );

    // Matchup refreshes can fan out further, so run one matchup per invocation.
    await runRefreshBatches(
      boardId,
      "refresh-matchups",
      "Refreshing matchups",
      summary,
      totals,
      warnings,
      1,
    );

    button.textContent = "Processing board…";
    summary.innerHTML =
      `<p class="process-running">Data refresh complete. Processing recommendations…</p>`;

    const processResult = await api(`/api/boards/${boardId}/process`, {
      method: "POST",
    });

    const processed = Number(processResult.processed || 0);
    const processWarnings = Array.isArray(processResult.warning_details)
      ? processResult.warning_details.map((row) => ({
          ...row,
          stage: row.stage || "PROCESS",
        }))
      : [];

    warnings.push(...processWarnings);

    await loadBootstrap();
    await loadBoard(boardId);

    const warningHtml = warnings.length
      ? `<details open>
          <summary>${warnings.length} warning(s)</summary>
          <ul>${warnings.map((row) =>
            `<li><strong>${escapeHtml(row.pitcher || `Prop ${row.prop_id || ""}`)}</strong> — ${escapeHtml(row.message || "Unknown warning")} <span class="warning-stage">${escapeHtml(row.stage || "")}</span></li>`
          ).join("")}</ul>
        </details>`
      : `<p class="process-success">No warnings.</p>`;

    summary.innerHTML = `
      <div class="process-metrics">
        <div><span>MLB IDs resolved</span><strong>${totals.idsResolved}</strong></div>
        <div><span>Pitchers refreshed</span><strong>${totals.pitchersRefreshed}</strong></div>
        <div><span>Game logs loaded</span><strong>${totals.gameLogsLoaded}</strong></div>
        <div><span>Matchup splits</span><strong>${totals.matchupSplitsLoaded}</strong></div>
        <div><span>Props processed</span><strong>${processed}</strong></div>
      </div>
      ${warningHtml}
    `;

    message(
      `Batched refresh complete. Processed ${processed} prop(s).`,
      warnings.length ? "" : "success",
    );

    if (warnings.length) console.warn("Refresh & Process warnings", warnings);
  } catch (error) {
    summary.innerHTML =
      `<p class="editor-message error">${escapeHtml(error.message)}</p>`;
    message(error.message, "error");
  } finally {
    button.textContent = "Refresh Data & Process";
    syncButtons();
  }
});

$("#pregame-checks").addEventListener("click", async () => {
  if (!state.board) return;
  const button = $("#pregame-checks");
  button.disabled = true;
  button.textContent = "Checking MLB…";
  try {
    const result = await api(`/api/boards/${state.board.board_id}/pregame-checks`, { method: "POST" });
    await loadBoard(state.board.board_id);
    message(
      `Pregame checks refreshed: ${Number(result.starter_confirmed || 0)} starter(s) confirmed across ${Number(result.games_checked || 0)} game(s).`,
      "success",
    );
  } catch (error) {
    message(error.message, "error");
  } finally {
    button.textContent = "Refresh Pregame Checks";
    syncButtons();
  }
});

$("#grade-results").addEventListener("click", async () => {
  if (!state.board || state.board.status === "DRAFT") {
    message("Select an active, archived, or closed board first.", "error");
    return;
  }

  const button = $("#grade-results");
  const summary = $("#grade-summary");
  button.disabled = true;
  button.textContent = "Grading…";
  summary.hidden = false;
  summary.innerHTML = `<p class="process-running">Refreshing official pitcher logs and grading completed results…</p>`;

  try {
    const boardId = state.board.board_id;
    const result = await api(`/api/boards/${boardId}/grade-results`, { method: "POST" });

    await loadBootstrap();
    await loadBoard(boardId);
    await loadCalibration();

    const warningRows = Array.isArray(result.warning_details) ? result.warning_details : [];
    const warningHtml = warningRows.length
      ? `<details open><summary>${warningRows.length} pending/warning item(s)</summary><ul>${warningRows.map((row) =>
          `<li><strong>${escapeHtml(row.pitcher || `Prop ${row.prop_id || ""}`)}</strong> — ${escapeHtml(row.message || "Unknown warning")}</li>`
        ).join("")}</ul></details>`
      : `<p class="process-success">All props were settled.</p>`;

    summary.innerHTML = `
      <div class="process-metrics">
        <div><span>Graded</span><strong>${Number(result.graded || 0)}</strong></div>
        <div><span>Overs</span><strong>${Number(result.overs || 0)}</strong></div>
        <div><span>Unders</span><strong>${Number(result.unders || 0)}</strong></div>
        <div><span>Pushes</span><strong>${Number(result.pushes || 0)}</strong></div>
        <div><span>Pending</span><strong>${Number(result.pending || 0)}</strong></div>
      </div>
      ${result.board_closed ? `<p class="process-success">Board closed automatically because every prop is settled.</p>` : ""}
      ${warningHtml}
    `;

    message(
      `Graded ${Number(result.graded || 0)} prop(s); ${Number(result.pending || 0)} remain pending.`,
      warningRows.length ? "" : "success",
    );
  } catch (error) {
    summary.innerHTML = `<p class="editor-message error">${escapeHtml(error.message)}</p>`;
    message(error.message, "error");
  } finally {
    button.textContent = "Grade Results";
    syncButtons();
  }
});

$("#activate-board").addEventListener("click", async () => {
  if (!confirm("Activate this board? The currently active board will be archived.")) return;
  try {
    await api(`/api/boards/${state.board.board_id}/activate`, { method: "POST" });
    await loadBootstrap();
    await loadBoard(state.board.board_id);
    message("Board activated.", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#prop-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const row = button.closest("tr");
  const propId = Number(row.dataset.propId);
  const prop = state.props.find((item) => Number(item.prop_id) === propId);
  if (!prop) return;

  try {
    if (button.dataset.action === "save-lifecycle") {
      const field = (name) => row.querySelector(`[data-field="${name}"]`);
      const closingLine = field("closing_line").value === "" ? null : Number(field("closing_line").value);
      await api(`/api/props/${propId}/lifecycle`, {
        method: "PATCH",
        body: JSON.stringify({
          final_classification: field("final_classification").value || null,
          final_card: field("final_card").checked,
          actually_played: field("actually_played").checked,
          closing_line: closingLine,
        }),
      });
      await loadBoard(state.board.board_id);
      message(`Lifecycle saved for ${prop.pitcher}.`, "success");
      return;
    }

    if (button.dataset.action === "save-postgame") {
      const reason = row.querySelector('[data-field="postgame_reason_code"]').value || null;
      const note = row.querySelector('[data-field="early_exit_reason"]').value || null;
      await api(`/api/props/${propId}/postgame-review`, {
        method: "PATCH",
        body: JSON.stringify({ postgame_reason_code: reason, early_exit_reason: note }),
      });
      await loadBoard(state.board.board_id);
      message(`Postgame review saved for ${prop.pitcher}.`, "success");
      return;
    }

    if (button.dataset.action === "delete") {
      if (!confirm(`Delete ${prop.pitcher} ${Number(prop.strikeout_line).toFixed(1)}?`)) return;
      await api(`/api/props/${propId}`, { method: "DELETE" });
      await loadBoard(state.board.board_id);
      message("Prop deleted.", "success");
      return;
    }

    const line = prompt("Strikeout line", Number(prop.strikeout_line).toFixed(1));
    if (line === null) return;
    const side = prompt("Available side: Both or More only", prop.available_side);
    if (side === null) return;
    const type = prompt("Prop type: Standard, Green Goblin, or Red Goblin", prop.prop_type);
    if (type === null) return;

    await api(`/api/props/${propId}`, {
      method: "PATCH",
      body: JSON.stringify({
        pitcher_id: prop.pitcher_id,
        opponent_team_id: prop.opponent_team_id,
        strikeout_line: Number(line),
        available_side: side,
        prop_type: type,
      }),
    });
    await loadBoard(state.board.board_id);
    message("Prop updated.", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

(async () => {
  try {
    await loadBootstrap();
    renderBoard();
  } catch (error) {
    message(error.message, "error");
  }
})();

// Load calibration after the editor initializes; failures stay isolated from board editing.
loadCalibration();
