const summaryGrid = document.querySelector('#summary-grid');
const modelsEl = document.querySelector('#models');
const messageEl = document.querySelector('#message');
const identityEl = document.querySelector('#identity');
const refreshButton = document.querySelector('#refresh');

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const dateText = (value) => value ? new Date(value.endsWith?.('Z') ? value : `${value}Z`).toLocaleString() : 'Never';

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type':'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function renderSummary(summary = {}) {
  const cards = [
    ['Production', summary.active_production_models ?? 0],
    ['Active challengers', summary.active_challengers ?? 0],
    ['Enabled challengers', summary.enabled_challengers ?? 0],
    ['Failed status', summary.models_with_failed_status ?? 0],
  ];
  summaryGrid.innerHTML = cards.map(([label,value]) => `<article class="summary-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join('');
}

function renderModels(models = []) {
  if (!models.length) {
    modelsEl.innerHTML = '<p>No model versions found.</p>';
    return;
  }
  modelsEl.innerHTML = models.map(model => {
    const production = model.model_role === 'PRODUCTION';
    return `<article class="model-card ${production ? 'production' : ''}" data-model-id="${model.model_version_id}">
      <div class="model-head">
        <div>
          <div class="model-title"><h3>${esc(model.version_name)}</h3><span class="badge">${esc(model.model_role)}</span><span class="badge">${esc(model.lifecycle_status)}</span></div>
          <p>${esc(model.code_identifier || 'No code identifier')}</p>
        </div>
        <span class="badge">${model.execution_enabled ? 'ENABLED' : 'DISABLED'}</span>
      </div>
      <div class="model-stats">
        <div class="stat"><span>Predictions</span><strong>${esc(model.prediction_count ?? 0)}</strong></div>
        <div class="stat"><span>Production / Shadow</span><strong>${esc(model.production_prediction_count ?? 0)} / ${esc(model.shadow_prediction_count ?? 0)}</strong></div>
        <div class="stat"><span>Failed predictions</span><strong>${esc(model.failed_prediction_count ?? 0)}</strong></div>
        <div class="stat"><span>Last run</span><strong>${esc(dateText(model.last_execution_at))}</strong></div>
        <div class="stat"><span>Runtime status</span><strong>${esc(model.last_execution_status || 'Never run')}</strong></div>
        <div class="stat"><span>Latest prediction</span><strong>${esc(dateText(model.latest_prediction_at))}</strong></div>
        <div class="stat"><span>Priority</span><strong>${esc(model.execution_priority)}</strong></div>
        <div class="stat"><span>Shadow source</span><strong>${esc(model.shadow_source_version_name || '—')}</strong></div>
      </div>
      ${model.last_execution_error ? `<p class="error">${esc(model.last_execution_error)}</p>` : ''}
      <form class="model-form">
        <label class="runtime-toggle"><input name="execution_enabled" type="checkbox" ${model.execution_enabled ? 'checked' : ''} ${production ? 'disabled' : ''}> Execute model</label>
        <label>Description<textarea name="description">${esc(model.description || '')}</textarea></label>
        <label>Release notes<textarea name="release_notes">${esc(model.release_notes || '')}</textarea></label>
        <label>Priority<input name="execution_priority" type="number" min="0" max="10000" step="1" value="${esc(model.execution_priority)}"></label>
        <button type="submit">Save</button>
      </form>
    </article>`;
  }).join('');

  modelsEl.querySelectorAll('.model-form').forEach(form => form.addEventListener('submit', saveModel));
}

async function saveModel(event) {
  event.preventDefault();
  const card = event.currentTarget.closest('[data-model-id]');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const id = Number(card.dataset.modelId);
  const data = new FormData(event.currentTarget);
  button.disabled = true;
  messageEl.textContent = `Saving model ${id}…`;
  try {
    await api(`/api/models/${id}/control`, {
      method:'PATCH',
      body:JSON.stringify({
        execution_enabled: event.currentTarget.elements.execution_enabled.disabled ? true : event.currentTarget.elements.execution_enabled.checked,
        description: data.get('description'),
        release_notes: data.get('release_notes'),
        execution_priority: Number(data.get('execution_priority')),
      }),
    });
    messageEl.textContent = 'Model control saved.';
    await load();
  } catch (error) {
    messageEl.textContent = error.message;
  } finally { button.disabled = false; }
}

async function load() {
  refreshButton.disabled = true;
  try {
    const [me, data] = await Promise.all([api('/api/me'), api('/api/models/control')]);
    identityEl.textContent = me.email || 'Authenticated';
    renderSummary(data.summary);
    renderModels(data.models);
  } catch (error) {
    messageEl.textContent = error.message;
    modelsEl.innerHTML = '';
  } finally { refreshButton.disabled = false; }
}

refreshButton.addEventListener('click', load);
load();
