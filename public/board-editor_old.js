
const state = {
  identity: null,
  pitchers: [],
  teams: [],
  boards: [],
  board: null,
  props: [],
  importRows: [],
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

  $("#save-board").disabled = !editable;
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

function renderBoard() {
  $("#board-date").value = state.board?.board_date || "";
  $("#board-name").value = state.board?.board_name || "";
  $("#board-select").value = state.board?.board_id ? String(state.board.board_id) : "";
  syncButtons();

  const body = $("#prop-body");
  if (!state.board) {
    body.innerHTML = `<tr><td colspan="6" class="loading">Select or create a draft board.</td></tr>`;
    return;
  }
  if (!state.props.length) {
    body.innerHTML = `<tr><td colspan="6" class="loading">No props on this board.</td></tr>`;
    return;
  }

  body.innerHTML = state.props.map((row) => `
    <tr data-prop-id="${row.prop_id}">
      <td>${escapeHtml(row.pitcher)}</td>
      <td>${escapeHtml(row.opponent || "—")}</td>
      <td>${Number(row.strikeout_line).toFixed(1)}</td>
      <td>${escapeHtml(row.available_side)}</td>
      <td>${escapeHtml(row.prop_type)}</td>
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
    renderBoard();
    return;
  }
  const data = await api(`/api/boards/${boardId}`);
  state.board = data.board;
  state.props = data.props;
  renderBoard();
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function findPitcherByName(name) {
  const target = normalizeText(name);

  return state.pitchers.find(
    (pitcher) => normalizeText(pitcher.canonical_name) === target
  ) ?? null;
}

function findTeamByAbbreviation(abbreviation) {
  const target = normalizeText(abbreviation);

  return state.teams.find(
    (team) => normalizeText(team.abbreviation) === target
  ) ?? null;
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

      const pitcher = findPitcherByName(pitcherName);
      const opponent = findTeamByAbbreviation(opponentAbbreviation);
      const strikeoutLine = Number(lineValue);
      const availableSide = normalizeSide(sideValue);
      const propType = normalizePropType(typeValue);

      const errors = [];

      if (columns.length < 3) {
        errors.push("Expected at least 3 columns");
      }

      if (!pitcherName) {
        errors.push("Pitcher is required");
      } else if (!pitcher) {
        errors.push("Pitcher not found");
      }

      if (opponentAbbreviation && !opponent) {
        errors.push("Opponent not found");
      }

      if (
        !Number.isFinite(strikeoutLine) ||
        strikeoutLine < 0.5 ||
        strikeoutLine > 15.5
      ) {
        errors.push("Invalid strikeout line");
      }

      if (!availableSide) {
        errors.push("Invalid side");
      }

      if (!propType) {
        errors.push("Invalid prop type");
      }

      return {
        rowNumber: index + 1,
        pitcherName,
        pitcher,
        opponentAbbreviation,
        opponent,
        strikeoutLine,
        availableSide,
        propType,
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

  const hasValidRows = state.importRows.some(
    (row) => row.errors.length === 0 && !row.imported
  );

  $("#run-import").disabled =
    !state.board ||
    state.board.status !== "DRAFT" ||
    !hasValidRows;
}

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

$("#run-import").addEventListener("click", async () => {
  if (!state.board) {
    $("#import-message").textContent =
      "Select or create a draft board first.";
    return;
  }

  const validRows = state.importRows.filter(
    (row) => row.errors.length === 0 && !row.imported
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

  $("#import-message").textContent =
    `Imported ${importedCount} prop(s). ${failedCount} failed.`;

  $("#preview-import").disabled = false;
  renderImportPreview();
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
