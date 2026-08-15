const $=id=>document.getElementById(id);
const pct=v=>v==null?'—':`${(Number(v)*100).toFixed(1)}%`;
const dec=v=>v==null?'—':Number(v).toFixed(3);
const signed=v=>v==null?'—':`${Number(v)>=0?'+':''}${(Number(v)*100).toFixed(1)}%`;
const num=v=>v==null?'—':Number(v).toFixed(1);
function metricRow(name,s){return `<tr><td>${name}</td><td>${s?.rows??0}</td><td>${s?.wins??0}-${s?.losses??0}</td><td>${pct(s?.hit_rate)}</td><td>${pct(s?.avg_probability)}</td><td>${signed(s?.calibration_gap)}</td><td>${dec(s?.brier)}</td><td>${num(s?.max_drawdown)}u</td><td>${s?.longest_losing_streak??0}</td></tr>`;}
async function load(){
  const r=await fetch('/api/models/comparison');if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const d=await r.json(),h=d.historical||{},s=h.summary||{},v13=s.v13||{},v14=s.v14||{},v14p=s.v14_play||{},ap=s.adaptive_play||{};
  $('historical-grid').innerHTML=`<article><span>Paired test rows</span><strong>${s.paired_rows??0}</strong></article><article><span>v13 hit</span><strong>${pct(v13.hit_rate)}</strong></article><article><span>5.1 PLAY hit</span><strong>${pct(v14p.hit_rate)}</strong></article><article><span>5.3 adaptive PLAY hit</span><strong>${pct(ap.hit_rate)}</strong></article><article><span>Adaptive PLAY rate</span><strong>${pct(s.adaptive_play_rate)}</strong></article><article><span>Adaptive Brier improvement</span><strong>${s.adaptive_brier_improvement==null?'—':dec(s.adaptive_brier_improvement)}</strong></article>`;
  $('overall').innerHTML=metricRow('v13 — all',v13)+metricRow('v14 5.1 calibrated — all',v14)+metricRow('v14 5.1 — PLAY only',v14p)+metricRow('v14 5.3 adaptive — PLAY only',ap);
  $('sides').innerHTML=(h.by_side||[]).map(x=>`<tr><td>${x.side}</td><td>${x.v13.rows}</td><td>${pct(x.v13.hit_rate)}</td><td>${x.v14_play.rows}</td><td>${pct(x.v14_play.hit_rate)}</td><td>${x.adaptive_play.rows}</td><td>${pct(x.adaptive_play.hit_rate)}</td><td>${dec(x.adaptive_play.brier)}</td></tr>`).join('')||'<tr><td colspan="8">No historical comparison rows.</td></tr>';
  $('edges').innerHTML=(h.by_edge||[]).map(x=>`<tr><td>${x.edge}</td><td>${x.v13.rows}</td><td>${pct(x.v13.hit_rate)}</td><td>${x.v14_play.rows}</td><td>${pct(x.v14_play.hit_rate)}</td><td>${x.adaptive_play.rows}</td><td>${pct(x.adaptive_play.hit_rate)}</td><td>${dec(x.adaptive_play.brier)}</td></tr>`).join('')||'<tr><td colspan="8">No historical comparison rows.</td></tr>';
  $('months').innerHTML=(h.by_month||[]).map(x=>`<tr><td>${x.month}</td><td>${x.adaptive_play.rows}</td><td>${x.adaptive_play.wins}-${x.adaptive_play.losses}</td><td>${pct(x.adaptive_play.hit_rate)}</td><td>${dec(x.adaptive_play.brier)}</td><td>${num(x.adaptive_play.max_drawdown)}u</td><td>${x.adaptive_play.longest_losing_streak}</td></tr>`).join('')||'<tr><td colspan="7">No monthly rows.</td></tr>';
  const l=d.live||{};
  $('live-grid').innerHTML=`<article><span>Paired predictions</span><strong>${l.paired_predictions??0}</strong></article><article><span>Graded pairs</span><strong>${l.graded_pairs??0}</strong></article><article><span>v13 live hit</span><strong>${pct(l.v13?.hit_rate)}</strong></article><article><span>v14 live hit</span><strong>${pct(l.v14?.hit_rate)}</strong></article><article><span>v13 live Brier</span><strong>${dec(l.v13?.brier)}</strong></article><article><span>v14 live Brier</span><strong>${dec(l.v14?.brier)}</strong></article>`;
  $('live-rows').innerHTML=(l.rows||[]).map(x=>{const a=Number(x.v13_probability??0),b=Number(x.v14_probability??0);return `<tr><td>${String(x.board_date??'').slice(0,10)}</td><td>${x.pitcher??'—'}</td><td>${x.strikeout_line??'—'}</td><td>${x.v13_side??'—'} · ${x.v13_decision??'—'}</td><td>${pct(a)}</td><td>${x.v14_side??'—'} · ${x.v14_decision??'—'}</td><td>${pct(b)}</td><td>${signed(b-a)}</td><td>${x.result??'—'}</td></tr>`}).join('')||'<tr><td colspan="9">No live v13/v14 shadow pairs yet. Process a board normally to create them.</td></tr>';
  $('message').textContent=`Historical replay: ${s.replay_version??'—'} · ${s.anti_lookahead??'—'}. Build ${d.build??'—'} keeps v13 production unchanged.`;
}
$('refresh').onclick=()=>load().catch(e=>$('message').textContent=String(e));
load().catch(e=>$('message').textContent=String(e));
