const state = {
  pitchers: [],
  history: [],
  selectedPitcherId: "",
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

function outcomeClass(value) {
  return `outcome-${String(value || "").toLowerCase().replaceAll(" ", "-")}`;
}

function rowOutcome(row) {
  if (row.recommendation_result) return row.recommendation_result;
  if (!row.result_status || row.result_status === "PENDING") return "UNRESOLVED";
  if (!row.preferred_side) return "NO_DIRECTION";
  return "UNRESOLVED";
}

function renderPitcherOptions() {
  const search = $("#pitcher-search").value.trim().toLowerCase();
  const select = $("#pitcher-select");
  const selected = state.selectedPitcherId;

  const pitchers = state.pitchers.filter((pitcher) =>
    !search || pitcher.canonical_name.toLowerCase().includes(search)
  );

  select.innerHTML = [
    `<option value="">Select a pitcher</option>`,
    ...pitchers.map((pitcher) => `
      <option value="${pitcher.pitcher_id}">
        ${escapeHtml(pitcher.canonical_name)} (${pitcher.prop_count})
      </option>
    `),
  ].join("");

  if (pitchers.some((pitcher) => String(pitcher.pitcher_id) === selected)) {
    select.value = selected;
  }
}

function filteredHistory() {
  const result = $("#result-filter").value;
  const source = $("#source-filter").value;

  return state.history.filter((row) => {
    const resultMatches = !result || rowOutcome(row) === result;
    const sourceMatches = !source || row.prop_source === source;
    return resultMatches && sourceMatches;
  });
}

function renderHistory() {
  const body = $("#history-body");
  const rows = filteredHistory();

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="loading">No matching history.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => {
    const recommendationResult = rowOutcome(row);
    const sourceLabel = row.prop_source === "historical_chat_import_v2"
      ? "Historical import"
      : row.prop_source || "—";

    return `
      <tr>
        <td>${escapeHtml(row.board_date)}</td>
        <td>${escapeHtml(row.opponent ?? "—")}</td>
        <td class="num">${number(row.strikeout_line, 1)}</td>
        <td>${escapeHtml(row.preferred_side ?? "—")}</td>
        <td>${escapeHtml(row.model_decision ?? row.final_decision ?? "—")}</td>
        <td class="num">${number(row.actual_strikeouts, 0)}</td>
        <td class="${outcomeClass(row.result)}">${escapeHtml(row.result ?? row.result_status ?? "UNRESOLVED")}</td>
        <td class="${outcomeClass(recommendationResult)}">${escapeHtml(recommendationResult)}</td>
        <td>${escapeHtml(row.prop_type ?? "—")}</td>
        <td><span class="source-chip">${escapeHtml(sourceLabel)}</span></td>
        <td class="reason">${escapeHtml(row.final_reason ?? "")}</td>
      </tr>
    `;
  }).join("");
}

function renderSummary(data) {
  const summary = data.summary;
  const pitcher = data.pitcher;

  $("#pitcher-heading").textContent = pitcher.canonical_name;
  $("#pitcher-meta").textContent = [
    pitcher.current_team || null,
    pitcher.throws_hand ? `${pitcher.throws_hand}HP` : null,
    pitcher.mlb_id ? `MLB ID ${pitcher.mlb_id}` : null,
  ].filter(Boolean).join(" • ") || "Historical K-prop record";

  $("#summary-props").textContent = summary.prop_count;
  $("#summary-verified").textContent = summary.verified_count;
  $("#summary-record").textContent = `${summary.wins}-${summary.losses}-${summary.pushes}`;
  $("#summary-win-rate").textContent = summary.win_rate === null
    ? "—"
    : `${(Number(summary.win_rate) * 100).toFixed(1)}%`;
  $("#summary-unresolved").textContent = summary.unresolved_count;
}

async function loadPitchers() {
  const response = await fetch("/api/pitcher-history", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Pitcher list failed (${response.status})`);

  const data = await response.json();
  state.pitchers = data.pitchers ?? [];
  renderPitcherOptions();

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("pitcher_id");
  if (requested && state.pitchers.some((pitcher) => String(pitcher.pitcher_id) === requested)) {
    state.selectedPitcherId = requested;
    $("#pitcher-select").value = requested;
    await loadHistory(requested);
  }
}

async function loadHistory(pitcherId) {
  if (!pitcherId) return;

  const error = $("#history-error");
  error.classList.add("hidden");

  const response = await fetch(`/api/pitcher-history?pitcher_id=${encodeURIComponent(pitcherId)}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `History request failed (${response.status})`);
  }

  const data = await response.json();
  state.selectedPitcherId = String(pitcherId);
  state.history = data.history ?? [];
  renderSummary(data);
  renderHistory();

  const url = new URL(window.location.href);
  url.searchParams.set("pitcher_id", state.selectedPitcherId);
  history.replaceState({}, "", url);
}

$("#pitcher-search").addEventListener("input", renderPitcherOptions);
$("#pitcher-select").addEventListener("change", async (event) => {
  try {
    await loadHistory(event.target.value);
  } catch (error) {
    $("#history-error").textContent = error.message;
    $("#history-error").classList.remove("hidden");
  }
});
$("#result-filter").addEventListener("change", renderHistory);
$("#source-filter").addEventListener("change", renderHistory);
$("#refresh-history").addEventListener("click", async () => {
  if (!state.selectedPitcherId) return;
  try {
    await loadHistory(state.selectedPitcherId);
  } catch (error) {
    $("#history-error").textContent = error.message;
    $("#history-error").classList.remove("hidden");
  }
});

loadPitchers().catch((error) => {
  $("#history-error").textContent = error.message;
  $("#history-error").classList.remove("hidden");
  $("#pitcher-select").innerHTML = `<option value="">Unable to load pitchers</option>`;
});
