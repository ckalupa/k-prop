const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => value ? new Date(value).toLocaleString() : '—';
const badge = value => `<span class="status-${String(value||'').toLowerCase()}">${esc(value || 'UNKNOWN')}</span>`;

async function api(path, options={}) {
  const response = await fetch(path, {headers:{'content-type':'application/json'}, ...options});
  const body = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body;
}

function render(data) {
  const s=data.source_status||{};
  $('status-grid').innerHTML = [
    ['Source health', badge(s.status)],
    ['Last success', esc(fmt(s.last_success_at))],
    ['Complete through', esc(s.last_complete_through_at || '—')],
    ['Stored games', esc(s.record_count ?? data.games.length)],
    ['Consecutive failures', esc(s.consecutive_failures ?? 0)]
  ].map(([label,value])=>`<article class="status-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
  $('runs').innerHTML=(data.recent_runs||[]).map(r=>`<tr><td>${esc(r.sync_run_id)}</td><td>${badge(r.status)}</td><td>${esc(r.trigger_source)}</td><td>${esc(fmt(r.started_at))}</td><td>${esc(r.rows_read)}</td><td>${esc(r.rows_inserted)}</td><td>${esc(r.rows_updated)}</td><td>${esc(r.rows_rejected)}</td></tr>`).join('') || '<tr><td colspan="8">No runs yet.</td></tr>';
  $('games').innerHTML=(data.games||[]).map(g=>`<tr><td>${esc(g.official_date||g.game_date)}</td><td>${esc(g.away_team)} @ ${esc(g.home_team)}</td><td>${esc(fmt(g.scheduled_start))}</td><td>${badge(g.status_detailed||g.game_status)}</td><td>${esc(g.away_probable_pitcher_name||'TBD')} / ${esc(g.home_probable_pitcher_name||'TBD')}</td><td>${g.away_score==null?'—':esc(g.away_score)}–${g.home_score==null?'—':esc(g.home_score)}</td><td>${esc(fmt(g.last_synced_at))}</td></tr>`).join('') || '<tr><td colspan="7">No games stored for this view.</td></tr>';
}

async function load() {
  $('message').textContent='Loading…';
  try { const date=$('game-date').value; render(await api(`/api/data-sources/mlb-schedule${date?`?date=${encodeURIComponent(date)}`:''}`)); $('message').textContent=''; }
  catch(e){ $('message').textContent=e.message; }
}
$('refresh').addEventListener('click',load);
$('game-date').addEventListener('change',load);
$('run-sync').addEventListener('click',async()=>{ const b=$('run-sync'); b.disabled=true; $('message').textContent='Sync running…'; try{const result=await api('/api/data-sources/mlb-schedule/sync',{method:'POST',body:'{}'}); $('message').textContent=`Sync ${result.status}: ${result.games_read} read, ${result.inserted} inserted, ${result.updated} updated.`; await load();}catch(e){$('message').textContent=e.message;}finally{b.disabled=false;}});
load();
