/* global marked, katex */
const $ = (sel) => document.querySelector(sel);

window.__errs = [];
window.addEventListener('error', (e) => { window.__errs.push(String(e.message || e)); showErr('JS error: ' + (e.message || e)); });
window.addEventListener('unhandledrejection', (e) => { const r = (e.reason && e.reason.message) || e.reason; window.__errs.push(String(r)); showErr('unhandled: ' + r); });

function showErr(msg) {
  let b = $('#err-banner');
  if (!b) { b = el('div', 'err-banner'); b.id = 'err-banner'; document.body.prepend(b); }
  b.textContent = 'ERROR: ' + msg;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
// ponytail: Electron renderer clipboard can deny async writeText; fallback to execCommand
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('no secure clipboard');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
      throw new Error('execCommand failed');
    } catch (e2) {
      // last resort — let user copy manually, don't throw unhandled
      try { window.prompt('Copy manually (Ctrl+C, Enter):', text); } catch(_){}
      return false;
    }
  }
}
const fmt = (bytes) => {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  return gb >= 1 ? gb.toFixed(2) + ' GB' : (bytes / 1e6).toFixed(0) + ' MB';
};

const SAMPLERS = ['lcm', 'euler a', 'euler', 'heun', 'dpm2', 'ddim', 'dpm++ 2m', 'dpm++ 2m sde', 'dpm++ 2m sde gpu', 'res 2s', 'euler_cfg_pp'];
const SCHEDULERS = ['simple', 'discrete', 'karras', 'exponential', 'sgm_uniform', 'ays', 'kl_optimal'];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

let config = null;
let dirs = [];
let localModels = [];
let conversations = [];
let activeConv = null;
let chatStreaming = false;
let abortChat = null;
let pendingImages = [];
let evSource = null;
let remotes = [];
let imageHistory = [];
const vramBuf = [];
const tempBuf = [];
let gpuPollTimer = null;

// ---------------- theme ----------------
function applyTheme(theme) {
  const t = theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('#theme-toggle button').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
  document.querySelectorAll('#settings-theme-toggle button').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
}
function initTheme() {
  const t = (config && config.ui && config.ui.theme) || 'auto';
  applyTheme(t);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => { if ((config.ui && config.ui.theme || 'auto') === 'auto') applyTheme('auto'); });
}

// ---------------- settings ----------------
function applyFont() {
  const fam = (config.ui && config.ui.fontFamily) || 'inter';
  const size = (config.ui && config.ui.fontSize) || 14;
  const fonts = { inter: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif", system: 'system-ui, -apple-system, "Segoe UI", sans-serif', mono: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", monospace' };
  document.documentElement.style.setProperty('--font-sans', fonts[fam] || fonts.inter);
  document.documentElement.style.setProperty('--font-size', size + 'px');
}
function renderThinkingSelect() {
  const s = $('#chat-thinking');
  const adv = !!(config.ui && config.ui.advancedThinking);
  const cur = s.value || 'on';
  s.innerHTML = '<option value="off">Off</option><option value="on">On</option>'
    + (adv ? '<option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option>' : '');
  s.value = cur;
  $('#chat-budget-wrap').hidden = !adv;
}
function refreshMoeHint(m) {
  // ponytail: MoE row is always visible (toggle-like). Only the chat hint is conditional.
  const hint = $('#chat-moe-hint');
  if (hint) hint.hidden = !(m && m.moe);
  const row = document.querySelector('.moe-row');
  if (row) row.style.opacity = (m && m.moe) ? '1' : '0.95';
}
function syncMoeUI() {
  const n = +(config.engines.text.nCpuMoe || 0);
  const en = $('#chat-moe-enable');
  const inp = $('#chat-moe');
  if (en) en.checked = n > 0;
  if (inp) { inp.value = n; inp.disabled = !!(en && !en.checked); }
}
function switchSettingsPane(name) {
  document.querySelectorAll('.settings-tab').forEach(t=> t.classList.toggle('active', t.dataset.pane===name));
  document.querySelectorAll('.settings-pane').forEach(p=> p.classList.toggle('active', p.dataset.pane===name));
}
function saveEngineFlag(patch) {
  config.engines.text = { ...(config.engines.text || {}), ...patch };
  api('/api/config/save', { method: 'POST', body: { engines: { text: patch } } });
}
function fillDraftSelect() {
  const s = $('#set-draft-model');
  if (!s) return;
  const cur = s.value || (config.engines.text && config.engines.text.draftModel) || '';
  const txt = (localModels || []).filter(m => m.type === 'text');
  s.innerHTML = '<option value="">(none — no separate draft)</option>';
  for (const m of txt) s.append(new Option(`${m.name} (${fmt(m.size)})`, m.path));
  s.value = cur;
}
async function runBench() {
  const out = $('#bench-out');
  const model = $('#chat-model').value;
  if (!model) { out.textContent = 'no model selected'; return; }
  out.textContent = 'bench: starting — small + large prompt (needs engine running)...\n';
  const tests = [
    { name: 'small prefill (23 tok)', prompt: 'Explain quantum computing.' },
    { name: 'large prefill (~500 tok)', prompt: ('You are a helpful assistant. '.repeat(30) + 'Summarize the history of computing in detail. ') }
  ];
  for (const t of tests) {
    const start = performance.now();
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelPath: model, messages: [{ role: 'user', content: t.prompt }], opts: { maxTokens: 128, temp: 0.7, thinkingMode: 'off' } }) });
      if (!res.ok) { out.textContent += t.name + ': HTTP ' + res.status + '\n'; continue; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf=''; let n=0;
      const t0 = performance.now();
      while (true) { const {done,value} = await reader.read(); if(done)break; buf+=dec.decode(value,{stream:true}); let i; while((i=buf.indexOf('\n\n'))>=0){ const evt=buf.slice(0,i); buf=buf.slice(i+2); if(!evt.startsWith('data:'))continue; try{ const ev=JSON.parse(evt.slice(5)); if(ev.content) n+= ev.content.length/4; }catch{} } }
      const dt = (performance.now()-t0)/1000;
      out.textContent += t.name + ': ~' + (n/dt).toFixed(1) + ' tok/s gen, total ' + dt.toFixed(2)+'s\n';
    } catch(e){ out.textContent += t.name + ': error ' + e.message + '\n'; }
  }
  out.textContent += 'done. For full numbers see engine log (prompt eval / eval). Tweak batch/ubatch/threads then Restart engine.\n';
}
function drawGpuChart(canvas, buf, color, label) {
  const c = canvas;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const x = (i / 59) * (w - 10); const y = h - 8 - (buf[i] / 100) * (h - 12);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = color; ctx.font = '9px ui-monospace, monospace'; ctx.textBaseline = 'top';
  ctx.fillText(label, 4, 3);
}
function gpuPoll() {
  api('/api/sys/gpu').then((g) => {
    if (!g) { $('#gpu-vram').hidden = $('#gpu-temp').hidden = true; return; }
    $('#gpu-vram').hidden = $('#gpu-temp').hidden = false;
    const vramPct = g.vramTotal ? Math.min(100, (g.vramUsed / g.vramTotal) * 100) : 0;
    vramBuf.push(vramPct); if (vramBuf.length > 60) vramBuf.shift();
    drawGpuChart($('#gpu-vram'), vramBuf, '#5b8cff', (g.vramUsed / 1073741824).toFixed(1) + ' / ' + (g.vramTotal / 1073741824).toFixed(1) + ' GiB');
    if (g.tempC != null) {
      tempBuf.push(g.tempC); if (tempBuf.length > 60) tempBuf.shift();
      drawGpuChart($('#gpu-temp'), tempBuf, '#fbbf24', g.tempC.toFixed(0) + '°C');
      $('#gpu-temp').hidden = false;
    }
  }).catch(() => { /* ignore transient */ });
}
function startGpuPoll() {
  if (gpuPollTimer) return;
  gpuPoll();
  gpuPollTimer = setInterval(gpuPoll, 2000);
}
function updateHarnessBar() {
  const pill = $('#harness-pill');
  if (!pill) return;
  const enabled = !(config.harness && config.harness.enabled === false);
  const keep = !(config.harness && config.harness.keepAlive === false);
  const lan = !!(config.server && config.server.enabled);
  pill.textContent = `harness: 9090/v1 ${enabled?'●':'○'} ${keep?'keep':'no-keep'} ${lan?'LAN':''}`.trim();
  pill.classList.toggle('running', enabled);
  const url = lan ? `http://${location.hostname}:9090/v1` : `http://127.0.0.1:9090/v1`;
  $('#srv-url').textContent = url + (enabled?' (open)':' (harness on)');
}

// ---------------- init ----------------
async function init() {
  bindUI();
  connectEvents();
  try { config = await api('/api/config'); } catch (e) { showErr('config: ' + e.message); return; }
  initTheme();
  applyFont();
  renderThinkingSelect();
  $('#set-font-family').value = (config.ui && config.ui.fontFamily) || 'inter';
  $('#set-font-size').value = (config.ui && config.ui.fontSize) || 14;
  $('#set-font-size-val').textContent = $('#set-font-size').value + 'px';
  $('#set-adv-thinking').checked = !!(config.ui && config.ui.advancedThinking);
  // sync settings theme toggle
  document.querySelectorAll('#settings-theme-toggle button').forEach(b=> b.classList.toggle('active', b.dataset.theme === ((config.ui && config.ui.theme) || 'auto')));
  if (config.engines && config.engines.text) {
    const t = config.engines.text;
    syncMoeUI();
    $('#chat-nommap').checked = !!t.noMmap;
    $('#chat-mlock').checked = !!t.mlock;
    $('#chat-dio').checked = !!t.directIo;
    $('#chat-kv').value = t.cacheTypeK || 'f16';
    $('#set-threads').value = t.threads ?? 4;
    $('#set-threads-batch').value = t.threadsBatch ?? 4;
    $('#set-batch').value = t.batchSize ?? 2048;
    $('#set-ubatch').value = t.ubatchSize ?? 512;
    $('#set-flash').value = t.flashAttn || 'on';
    $('#set-parallel').value = t.parallel ?? 4;
    $('#set-contbatch').checked = t.contBatching !== false;
    $('#set-ngl').value = t.ngl ?? 99;
    $('#set-top-p').value = t.topP ?? 0.95;
    $('#set-top-k').value = t.topK ?? 40;
    $('#set-min-p').value = t.minP ?? 0.05;
    $('#set-repeat-penalty').value = t.repeatPenalty ?? 1.1;
    const ea = t.extraArgs;
    $('#set-extra-args').value = Array.isArray(ea) ? ea.join(' ') : (ea || '');
    $('#set-self-mtp').checked = !!t.selfMtp;
    $('#set-draft-max').value = t.draftMax ?? 3;
    $('#set-draft-min').value = t.draftMin ?? 1;
    $('#set-draft-pmin').value = t.draftPMin ?? 0.0;
    fillDraftSelect();
    $('#set-draft-model').value = t.draftModel || '';
  }
  startGpuPoll();
  if (config.server) {
    $('#srv-enable').checked = !!config.server.enabled;
    if (config.server.apiKey) $('#srv-key').value = config.server.apiKey;
    if ($('#srv-enable-system')) $('#srv-enable-system').checked = !!config.server.enabled;
    if ($('#srv-key-system') && config.server.apiKey) $('#srv-key-system').value = config.server.apiKey;
  }
  if (config.harness) {
    $('#harness-keep').checked = config.harness.keepAlive !== false;
    if ($('#harness-keep-system')) $('#harness-keep-system').checked = config.harness.keepAlive !== false;
  }
  updateHarnessBar();
  dirs = [...(config.modelDirs || [])];
  renderDirList();
  if (config.audio) {
    $('#audio-outdir').value = config.audio.outputDir || '';
    const a2 = $('#audio-outdir-system'); if (a2) a2.value = config.audio.outputDir || '';
    $('#trans-autocopy').checked = !!config.audio.copyTranscript;
    const ta2 = $('#trans-autocopy-system'); if (ta2) ta2.checked = !!config.audio.copyTranscript;
  }
  // sys prompt restore for active conv handled in renderChat
  remotes = config.remotes || [];
  renderRemotes();
  renderProviderSelect();
  loadAudioVoices();
  try {
    for (const s of SAMPLERS) $('#img-sampler').append(new Option(s, s));
    for (const s of SCHEDULERS) $('#img-scheduler').append(new Option(s, s));
    for (const s of SAMPLERS) $('#vid-sampler').append(new Option(s, s));
    for (const s of SCHEDULERS) $('#vid-scheduler').append(new Option(s, s));
    $('#img-sampler').value = 'lcm';
    $('#img-scheduler').value = 'simple';
    $('#vid-sampler').value = 'lcm';
    $('#vid-scheduler').value = 'simple';
  } catch (e) { showErr('samplers: ' + e.message); }
  try { await loadConversations(); } catch (e) { showErr('conversations: ' + e.message); }
  try { await refreshLocal(); } catch (e) { showErr('models: ' + e.message); }
  refreshEngineStatus();
  if (activeConv) { try { renderChat(); } catch (e) { showErr('render: ' + e.message); } }
  window.__initDone = true;
}

function bindUI() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('.sub-tab').forEach((t) =>
    t.addEventListener('click', () => switchSubTab(t.dataset.sub)));
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chat-input').addEventListener('paste', (e) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) addImage(item.getAsFile());
    }
  });
  $('#chat-input').closest('.chat-inputbar').addEventListener('dragover', (e) => e.preventDefault());
  $('#chat-input').closest('.chat-inputbar').addEventListener('drop', (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) addImage(f);
  });
  $('#chat-attach-btn').addEventListener('click', () => $('#chat-attach').click());
  $('#chat-attach').addEventListener('change', (e) => {
    for (const f of e.target.files) addImage(f);
    e.target.value = '';
  });
  $('#chat-stop').addEventListener('click', () => { if (abortChat) abortChat(); });
  $('#chat-clear').addEventListener('click', () => { if (activeConv) { activeConv.messages = []; persistConv(); renderChat(); } });
  $('#chat-model').addEventListener('change', (e) => {
    const m = modelById(e.target.value);
    refreshMoeHint(m);
    if (activeConv) { activeConv.model = e.target.value; persistConv(); }
  });
  $('#chat-thinking').addEventListener('change', () => { if (activeConv) { activeConv.thinkingMode = $('#chat-thinking').value; persistConv(); } });
  $('#chat-budget').addEventListener('input', () => { if (activeConv) { activeConv.thinkingBudget = +$('#chat-budget').value || 0; persistConv(); } });
  // MoE — toggle + number (always visible)
  $('#chat-moe-enable')?.addEventListener('change', () => {
    const en = $('#chat-moe-enable').checked;
    const inp = $('#chat-moe');
    if (inp) inp.disabled = !en;
    saveEngineFlag({ nCpuMoe: en ? (+inp.value || 0) : 0 });
  });
  $('#chat-moe').addEventListener('input', () => {
    const en = $('#chat-moe-enable');
    if (en && !en.checked) { $('#chat-moe-enable').checked = true; $('#chat-moe').disabled = false; }
    saveEngineFlag({ nCpuMoe: +$('#chat-moe').value || 0 });
  });
  $('#chat-nommap').addEventListener('change', () => saveEngineFlag({ noMmap: $('#chat-nommap').checked }));
  $('#chat-mlock').addEventListener('change', () => saveEngineFlag({ mlock: $('#chat-mlock').checked }));
  $('#chat-dio').addEventListener('change', () => saveEngineFlag({ directIo: $('#chat-dio').checked }));
  $('#chat-kv').addEventListener('change', () => saveEngineFlag({ cacheTypeK: $('#chat-kv').value }));
  // settings tabs
  document.querySelectorAll('.settings-tab').forEach(b=> b.addEventListener('click', ()=> switchSettingsPane(b.dataset.pane)));
  // perf — ponytail: one-liner per knob, save + needs restart
  $('#set-threads').addEventListener('change', () => saveEngineFlag({ threads: +$('#set-threads').value || 4 }));
  $('#set-threads-batch').addEventListener('change', () => saveEngineFlag({ threadsBatch: +$('#set-threads-batch').value || 4 }));
  $('#set-batch').addEventListener('change', () => saveEngineFlag({ batchSize: +$('#set-batch').value || 2048 }));
  $('#set-ubatch').addEventListener('change', () => saveEngineFlag({ ubatchSize: +$('#set-ubatch').value || 512 }));
  $('#set-flash').addEventListener('change', () => saveEngineFlag({ flashAttn: $('#set-flash').value }));
  $('#set-parallel').addEventListener('change', () => saveEngineFlag({ parallel: +$('#set-parallel').value || 4 }));
  $('#set-contbatch').addEventListener('change', () => saveEngineFlag({ contBatching: $('#set-contbatch').checked }));
  $('#set-ngl').addEventListener('change', () => saveEngineFlag({ ngl: +$('#set-ngl').value || 99 }));
  $('#set-top-p').addEventListener('change', () => saveEngineFlag({ topP: parseFloat($('#set-top-p').value) }));
  $('#set-top-k').addEventListener('change', () => saveEngineFlag({ topK: +$('#set-top-k').value || 0 }));
  $('#set-min-p').addEventListener('change', () => saveEngineFlag({ minP: parseFloat($('#set-min-p').value) }));
  $('#set-repeat-penalty').addEventListener('change', () => saveEngineFlag({ repeatPenalty: parseFloat($('#set-repeat-penalty').value) }));
  $('#set-extra-args').addEventListener('change', () => {
    const v = $('#set-extra-args').value.trim();
    const arr = v ? v.split(/\s+/) : [];
    saveEngineFlag({ extraArgs: arr });
  });
  $('#set-self-mtp').addEventListener('change', () => saveEngineFlag({ selfMtp: $('#set-self-mtp').checked }));
  $('#set-draft-model').addEventListener('change', () => saveEngineFlag({ draftModel: $('#set-draft-model').value }));
  $('#set-draft-max').addEventListener('change', () => saveEngineFlag({ draftMax: +$('#set-draft-max').value || 3 }));
  $('#set-draft-min').addEventListener('change', () => saveEngineFlag({ draftMin: +$('#set-draft-min').value || 1 }));
  $('#set-draft-pmin').addEventListener('change', () => saveEngineFlag({ draftPMin: parseFloat($('#set-draft-pmin').value) || 0 }));
  $('#bench-run').addEventListener('click', runBench);
  $('#set-font-family').addEventListener('change', async (e) => {
    applyFont();
    config.ui = { ...(config.ui || {}), fontFamily: e.target.value };
    await api('/api/config/save', { method: 'POST', body: { ui: config.ui } });
  });
  $('#set-font-size').addEventListener('input', async (e) => {
    const v = +e.target.value;
    $('#set-font-size-val').textContent = v + 'px';
    applyFont();
    config.ui = { ...(config.ui || {}), fontSize: v };
    await api('/api/config/save', { method: 'POST', body: { ui: config.ui } });
  });
  $('#set-adv-thinking').addEventListener('change', async (e) => {
    config.ui = { ...(config.ui || {}), advancedThinking: e.target.checked };
    await api('/api/config/save', { method: 'POST', body: { ui: config.ui } });
    renderThinkingSelect();
  });
  // settings theme toggle mirrors sidebar
  document.querySelectorAll('#settings-theme-toggle button').forEach(b=> b.addEventListener('click', async ()=>{
    const t = b.dataset.theme;
    applyTheme(t);
    document.querySelectorAll('#settings-theme-toggle button').forEach(x=> x.classList.toggle('active', x.dataset.theme===t));
    config.ui = config.ui || {}; config.ui.theme = t;
    await api('/api/config/save', { method: 'POST', body: { ui: config.ui } });
  }));
  // system pane mirrors
  $('#harness-keep-system')?.addEventListener('change', async (e)=>{
    const keep = e.target.checked;
    $('#harness-keep').checked = keep;
    config.harness = { ...(config.harness||{}), keepAlive: keep, enabled: true };
    await api('/api/harness/set', { method:'POST', body:{ keepAlive: keep, enabled: true } });
    config = await api('/api/config'); updateHarnessBar();
  });
  $('#srv-enable-system')?.addEventListener('change', (e)=>{
    $('#srv-enable').checked = e.target.checked;
  });
  $('#srv-key-system')?.addEventListener('input', (e)=>{
    $('#srv-key').value = e.target.value;
  });
  $('#srv-apply-system')?.addEventListener('click', async ()=>{
    $('#srv-enable').checked = $('#srv-enable-system').checked;
    $('#srv-key').value = $('#srv-key-system').value;
    await applyServer();
    $('#srv-url-system').textContent = $('#srv-url').textContent;
  });
  $('#audio-outdir-system')?.addEventListener('change', async (e)=>{
    const v = e.target.value.trim();
    $('#audio-outdir').value = v;
    if (!v) return;
    config = await api('/api/config/save', { method: 'POST', body: { audio: { ...(config.audio || {}), outputDir: v } } });
  });
  $('#trans-autocopy-system')?.addEventListener('change', async (e)=>{
    $('#trans-autocopy').checked = e.target.checked;
    config = await api('/api/config/save', { method: 'POST', body: { audio: { ...(config.audio || {}), copyTranscript: e.target.checked } } });
  });
  $('#settings-reset')?.addEventListener('click', async ()=>{
    if (!confirm('Reset Performance & Sampling to defaults?')) return;
    const patch = { threads:4, threadsBatch:4, batchSize:2048, ubatchSize:512, flashAttn:'on', parallel:1, contBatching:true, ngl:99, cacheTypeK:'f16', noMmap:false, mlock:false, directIo:false, nCpuMoe:0, topP:0.95, topK:40, minP:0.05, repeatPenalty:1.1, extraArgs:[] };
    config.engines.text = { ...(config.engines.text||{}), ...patch };
    await api('/api/config/save', { method:'POST', body:{ engines:{ text: patch } } });
    location.reload();
  });
  document.querySelector('.moe-hint button[data-open-tab]')?.addEventListener('click', () => { switchTab('settings'); switchSettingsPane('performance'); });
  $('#chat-provider').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'local') {
      config.engines.text.provider = 'local';
      config.engines.text.activeRemoteId = '';
    } else {
      config.engines.text.provider = 'remote';
      config.engines.text.activeRemoteId = v;
    }
    await api('/api/remotes/set-active', { method: 'POST', body: { id: v === 'local' ? '' : v, provider: v === 'local' ? 'local' : 'remote' } });
    config = await api('/api/config');
    refreshEngineStatus();
  });
  $('#app-quit').addEventListener('click', async () => { try { await api('/api/quit', { method: 'POST' }); } catch (e) { location.reload(); } });
  $('#chat-start-engine').addEventListener('click', async () => {
    const prov = $('#chat-provider').value;
    if (prov !== 'local') { appendLog('system', 'remote provider — no local engine to start'); return; }
    const m = modelById($('#chat-model').value);
    if (m) { await startEngine('text', m, { ctx: +$('#chat-ctx').value || 8192, nCpuMoe: +$('#chat-moe').value || 0, noMmap: $('#chat-nommap').checked, mlock: $('#chat-mlock').checked, directIo: $('#chat-dio').checked, cacheTypeK: $('#chat-kv').value }); refreshEngineStatus(); }
  });

  // sys prompt
  $('#sys-preset').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') { $('#sys-prompt').focus(); return; }
    if (v === '') $('#sys-prompt').value = '';
    else $('#sys-prompt').value = v;
    if (activeConv) { activeConv.systemPrompt = $('#sys-prompt').value.trim(); persistConv(); }
  });
  $('#sys-prompt').addEventListener('input', () => {
    if (activeConv) { activeConv.systemPrompt = $('#sys-prompt').value.trim(); persistConv(); }
    // sync preset select
    const v = $('#sys-prompt').value.trim();
    const opts = [...$('#sys-preset').options].map(o=>o.value);
    if (!opts.includes(v)) $('#sys-preset').value = v ? 'custom' : '';
  });

  // theme + collapse
  document.querySelectorAll('#theme-toggle button').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.theme;
    applyTheme(t);
    config.ui = config.ui || {}; config.ui.theme = t;
    await api('/api/config/save', { method: 'POST', body: { ui: config.ui } });
  }));
  $('#sidebar-collapse').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
    $('#sidebar-collapse').textContent = $('#sidebar').classList.contains('collapsed') ? '◧ Expand' : '◧ Collapse';
  });
  $('#conv-search').addEventListener('input', (e) => renderConvList(e.target.value));

  $('#conv-new').addEventListener('click', newConversation);

  $('#img-generate').addEventListener('click', generateImage);
  $('#img-start-engine').addEventListener('click', async () => {
    const m = modelById($('#img-model').value);
    if (m) { await startEngine('image', m); refreshEngineStatus(); }
  });
  $('#img-save').addEventListener('click', saveMedia);
  $('#img2-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      $('#img2-src').src = r.result;
      $('#img2-src').hidden = false;
      window.__img2b64 = String(r.result).split(',')[1];
    };
    r.readAsDataURL(f);
  });

  $('#vid-generate').addEventListener('click', generateVideo);
  $('#vid-start-engine').addEventListener('click', async () => {
    const m = modelById($('#vid-model').value);
    if (m) { await startEngine('video', m, { frames: +$('#vid-frames').value || 8, fps: +$('#vid-fps').value || 8 }); refreshEngineStatus(); }
  });
  $('#vid-save').addEventListener('click', saveMedia);

  $('#hf-search').addEventListener('click', hfSearch);
  $('#hf-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') hfSearch(); });
  $('#lib-dirs-save').addEventListener('click', async () => {
    config = await api('/api/config/save', { method: 'POST', body: { modelDirs: dirs } });
    renderDlDirSelect();
    refreshLocal();
  });
  $('#lib-dirs-browse').addEventListener('click', async () => {
    const r = await api('/api/pick-dir', { method: 'POST' });
    if (!r.dir) return;
    if (!dirs.includes(r.dir)) dirs.push(r.dir);
    renderDirList();
  });
  $('#lib-dl-dir').addEventListener('change', async (e) => {
    config = await api('/api/config/save', { method: 'POST', body: { downloadDir: e.target.value } });
  });
  // remotes
  $('#remote-add').addEventListener('click', async () => {
    const name = $('#remote-name').value.trim();
    const baseUrl = $('#remote-url').value.trim();
    const apiKey = $('#remote-key').value.trim();
    if (!name || !baseUrl) { $('#remote-status').textContent = 'name + URL required'; return; }
    $('#remote-status').textContent = 'adding…';
    try {
      remotes = await api('/api/remotes/add', { method: 'POST', body: { name, baseUrl, apiKey } });
      config.remotes = remotes;
      $('#remote-name').value=''; $('#remote-url').value=''; $('#remote-key').value='';
      $('#remote-status').textContent = 'added';
      renderRemotes(); renderProviderSelect();
    } catch (e) { $('#remote-status').textContent = 'error: '+e.message; }
  });
  $('#remote-test').addEventListener('click', async () => {
    const baseUrl = $('#remote-url').value.trim();
    const apiKey = $('#remote-key').value.trim();
    if (!baseUrl) { $('#remote-status').textContent = 'enter URL to test'; return; }
    $('#remote-status').textContent = 'testing…';
    try {
      const r = await api('/api/remotes/test', { method: 'POST', body: { baseUrl, apiKey } });
      const n = r.models && r.models.length ? r.models.length : JSON.stringify(r).slice(0,120);
      $('#remote-status').textContent = 'ok: '+(typeof n==='number'? n+' models' : n);
    } catch (e) { $('#remote-status').textContent = 'fail: '+e.message; }
  });
  $('#audio-start-engine').addEventListener('click', async () => {
    setPill('st-audio', 'starting…');
    try {
      const status = await api('/api/engine/start', { method: 'POST', body: { type: 'audio' } });
      setPill('st-audio', status.running ? ttsPillLabel() : 'idle');
    } catch (e) { setPill('st-audio', 'failed'); showErr('audio start: ' + e.message); }
    loadAudioVoices();
  });
  $('#audio-gen').addEventListener('click', generateTTS);
  document.querySelectorAll('.eject').forEach((b) => b.addEventListener('click', () => ejectEngine(b.dataset.engine)));
  $('#tts-model').addEventListener('change', () => { switchAudioBackend(); setPill('st-audio', ttsPillLabel()); });
  $('#audio-save').addEventListener('click', saveAudio);
  $('#clone-go').addEventListener('click', cloneVoice);
  $('#clone-file').addEventListener('change', () => { $('#clone-status').textContent = $('#clone-file').files[0] ? $('#clone-file').files[0].name + ' (' + fmt($('#clone-file').files[0].size) + ')' : ''; });
  $('#trans-go').addEventListener('click', transcribe);
  $('#trans-live').addEventListener('click', toggleLive);
  $('#trans-copy').addEventListener('click', () => { copyText($('#trans-text').value).catch(()=>{}); });
  $('#trans-save').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent($('#trans-text').value);
    a.download = 'transcript-' + Date.now() + '.txt';
    a.click();
  });
  $('#trans-autocopy').addEventListener('change', async (e) => {
    config = await api('/api/config/save', { method: 'POST', body: { audio: { ...(config.audio || {}), copyTranscript: e.target.checked } } });
  });
  $('#audio-outdir').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    config = await api('/api/config/save', { method: 'POST', body: { audio: { ...(config.audio || {}), outputDir: v } } });
  });

  $('#srv-apply').addEventListener('click', applyServer);
  $('#harness-keep').addEventListener('change', async (e)=>{
    const keep = e.target.checked;
    const sys = $('#harness-keep-system'); if (sys) sys.checked = keep;
    config.harness = { ...(config.harness||{}), keepAlive: keep, enabled: true };
    await api('/api/harness/set', { method:'POST', body:{ keepAlive: keep, enabled: true } });
    config = await api('/api/config');
    updateHarnessBar();
  });
  // keep sidebar ↔ system pane in sync
  $('#srv-enable')?.addEventListener('change', (e)=>{ const s=$('#srv-enable-system'); if(s) s.checked = e.target.checked; });
  $('#srv-key')?.addEventListener('input', (e)=>{ const s=$('#srv-key-system'); if(s) s.value = e.target.value; });
  $('#harness-copy').addEventListener('click', async ()=>{
    const key = $('#srv-key').value.trim();
    const model = $('#chat-model').value ? $('#chat-model').options[$('#chat-model').selectedIndex].text : 'local-model';
    const host = (config.server && config.server.enabled) ? location.hostname : '127.0.0.1';
    const snippet = JSON.stringify({ providers:{ polaris:{ baseUrl:`http://${host}:9090/v1`, apiKey: key || undefined, model } } }, null, 2);
    const ok = await copyText(snippet);
    $('#srv-url').textContent = ok ? 'copied opencode.json ✓' : 'copy failed — see prompt';
    setTimeout(updateHarnessBar, 1500);
  });
  $('#harness-copy-curl').addEventListener('click', async ()=>{
    const key = $('#srv-key').value.trim();
    const host = (config.server && config.server.enabled) ? location.hostname : '127.0.0.1';
    const auth = key ? ` -H "Authorization: Bearer ${key}"` : '';
    const curl = `curl http://${host}:9090/v1/chat/completions${auth} -H "Content-Type: application/json" -d '{"model":"${$('#chat-model').value? $('#chat-model').options[$('#chat-model').selectedIndex].text : 'model'}","messages":[{"role":"user","content":"hi"}]}'`;
    const ok = await copyText(curl);
    $('#srv-url').textContent = ok ? 'copied curl ✓' : 'copy failed — see prompt';
    setTimeout(updateHarnessBar, 1500);
  });
  $('#log-toggle').addEventListener('click', () => {
    const bar = $('.logbar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#engine-log').scrollTop = $('#engine-log').scrollHeight;
  });

  // palette
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape' && !$('#palette-overlay').hidden) closePalette();
  });
  $('#palette-overlay').addEventListener('click', (e) => { if (e.target.id === 'palette-overlay') closePalette(); });
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const a = $('#palette-list .palette-item.active'); if (a) { a.click(); } }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); navPalette(e.key === 'ArrowDown' ? 1 : -1); }
  });

  setInterval(refreshEngineStatus, 5000);
}

function connectEvents() {
  if (evSource) evSource.close();
  evSource = new EventSource('/api/events');
  evSource.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'engine:log') appendLog(m.typeName, m.line);
    if (m.type === 'dl:progress') dlProgress(m);
    if (m.type === 'dl:done') { dlProgress(m); refreshLocal(); }
    if (m.type === 'dl:error') dlError(m);
  };
}

const cssId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
function appendLog(type, line) {
  const log = $('#engine-log');
  const t = line.trim();
  if (!t) return;
  if (log.childNodes.length > 500) log.firstChild.remove();
  log.append((type !== 'system' ? '[' + type + '] ' : '') + t + '\n');
  log.scrollTop = log.scrollHeight;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

function switchSubTab(name) {
  document.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === name));
  const map = { tts: 'tts-tab', clone: 'clone-tab', transcribe: 'transcribe-tab', img2: 'img2img-tab', img2img: 'img2-tab' };
  for (const id of Object.values(map)) {
    const n = $('#' + id);
    if (n) n.hidden = id !== map[name];
  }
}

// ---------------- remotes ----------------
function renderRemotes() {
  const box = $('#remote-list');
  if (!box) return;
  box.innerHTML = '';
  if (!remotes.length) { box.append(el('div','muted','no remotes — add one below')); return; }
  for (const r of remotes) {
    const row = el('div','remote-item' + (config.engines.text.activeRemoteId===r.id ? ' active' : ''));
    row.append(el('span','r-name', r.name));
    row.append(el('span','r-url', r.baseUrl));
    const use = el('button','btn ghost sm', config.engines.text.activeRemoteId===r.id ? 'Active' : 'Use');
    use.addEventListener('click', async () => {
      await api('/api/remotes/set-active', { method:'POST', body:{ id: r.id, provider:'remote' } });
      config = await api('/api/config');
      renderRemotes(); renderProviderSelect(); refreshEngineStatus();
    });
    row.append(use);
    const del = el('button','btn ghost sm','✕');
    del.addEventListener('click', async () => {
      if (!confirm('Remove '+r.name+'?')) return;
      remotes = await api('/api/remotes/remove', { method:'POST', body:{ id: r.id } });
      config.remotes = remotes;
      renderRemotes(); renderProviderSelect(); refreshEngineStatus();
    });
    row.append(del);
    box.append(row);
  }
}
function renderProviderSelect() {
  const s = $('#chat-provider');
  const cur = s.value;
  s.innerHTML = '<option value="local">Local</option>';
  for (const r of remotes) s.append(new Option(r.name+' (remote)', r.id));
  // restore
  const want = config.engines.text.provider === 'remote' ? config.engines.text.activeRemoteId : 'local';
  s.value = want || 'local';
  if (cur && [...s.options].some(o=>o.value===cur)) s.value = cur;
}

// ---------------- conversations ----------------
async function loadConversations() {
  conversations = await api('/api/conversations');
  if (!conversations.length) {
    activeConv = newConversation(false);
  } else {
    activeConv = conversations[0];
  }
  renderConvList();
}

function newConversation(persist = true) {
  activeConv = { id: 'c' + Date.now().toString(36), title: 'New chat', model: $('#chat-model').value || '', thinkingMode: 'on', thinkingBudget: 0, systemPrompt: '', messages: [] };
  if (persist) {
    conversations.unshift(activeConv);
    persistConv();
    renderConvList();
    renderChat();
  }
  return activeConv;
}

function persistConv() {
  api('/api/conversations/save', { method: 'POST', body: activeConv });
}

function exportConv(c, format) {
  if (format === 'json') {
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(c, null, 2));
    a.download = (c.title.replace(/[^a-z0-9_-]/gi,'_')||'chat')+'.json';
    a.click();
  } else {
    let md = '# '+c.title+'\n\n';
    if (c.systemPrompt) md += '> System: '+c.systemPrompt+'\n\n';
    for (const m of c.messages) {
      const txt = typeof m.content==='string' ? m.content : (Array.isArray(m.content) ? m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n') : '');
      md += '## '+(m.role==='user'?'User':'Assistant')+'\n'+txt+'\n\n';
    }
    const a = document.createElement('a');
    a.href = 'data:text/markdown;charset=utf-8,'+encodeURIComponent(md);
    a.download = (c.title.replace(/[^a-z0-9_-]/gi,'_')||'chat')+'.md';
    a.click();
  }
}

function renderConvList(filter='') {
  const box = $('#conv-list');
  const q = filter.toLowerCase().trim();
  box.innerHTML = '';
  const list = q ? conversations.filter(c=> c.title.toLowerCase().includes(q) || c.messages.some(m=> {
    const t = typeof m.content==='string'? m.content : (Array.isArray(m.content)? m.content.filter(p=>p.type==='text').map(p=>p.text).join(' ') : '');
    return t.toLowerCase().includes(q);
  })) : conversations;
  for (const c of list) {
    const row = el('div', 'conv-row' + (c.id === activeConv.id ? ' active' : ''), null);
    const label = el('span', 'conv-title', c.title);
    row.append(label);
    const ex = el('button','conv-export','⤓');
    ex.title='Export';
    ex.addEventListener('click', (e)=>{ e.stopPropagation(); exportConv(c, 'md'); });
    const exJ = el('button','conv-export','{}');
    exJ.title='Export JSON';
    exJ.addEventListener('click', (e)=>{ e.stopPropagation(); exportConv(c,'json'); });
    row.append(exJ); row.append(ex);
    const del = el('button', 'conv-del', '×');
    del.title='Delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      conversations = conversations.filter((x) => x.id !== c.id);
      api('/api/conversations/delete', { method: 'POST', body: { id: c.id } });
      if (activeConv.id === c.id) newConversation(false);
      renderConvList($('#conv-search').value);
    });
    row.append(del);
    row.addEventListener('click', () => { activeConv = c; renderConvList($('#conv-search').value); renderChat(); });
    label.addEventListener('dblclick', () => {
      const inp = document.createElement('input');
      inp.value = c.title;
      inp.className = 'conv-rename';
      label.replaceWith(inp);
      inp.focus();
      inp.addEventListener('blur', () => { c.title = inp.value.trim() || c.title; persistConv(); renderConvList($('#conv-search').value); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    box.append(row);
  }
  if (!list.length && q) box.append(el('div','muted','no matches'));
}

function renderChat() {
  $('#chat-messages').innerHTML = '';
  $('#chat-model').value = activeConv.model;
  refreshMoeHint(modelById(activeConv.model));
  if (activeConv.thinkingMode) $('#chat-thinking').value = activeConv.thinkingMode;
  else $('#chat-thinking').value = activeConv.thinking ? 'on' : 'off';
  $('#chat-budget').value = activeConv.thinkingBudget || 0;
  $('#sys-prompt').value = activeConv.systemPrompt || '';
  $('#sys-preset').value = (()=>{ const v=(activeConv.systemPrompt||'').trim(); const opts=[...$('#sys-preset').options].map(o=>o.value); return opts.includes(v)? v : (v?'custom':''); })();
  for (const m of activeConv.messages) renderMsg(m.role, m.content);
  scrollChat();
}

// ---------------- models ----------------
function modelById(path) { return localModels.find((m) => m.path === path); }

async function refreshLocal() {
  localModels = await api('/api/models');
  const byType = { text: [], image: [], video: [], aux: [], audio: [] };
  for (const m of localModels) byType[m.type].push(m);
  fillSelect('#chat-model', byType.text, 'no text models in library');
  refreshMoeHint(modelById($('#chat-model').value) || null);
  fillDraftSelect();
  fillSelect('#img-model', byType.image, 'no image models — SD1.5 gguf expected');
  fillSelect('#vid-model', byType.video.length ? byType.video : byType.image, byType.video.length ? '' : 'using image models (AnimateDiff mode)');
  if ($('#audio-model')) fillSelect('#audio-model', byType.audio.filter((m) => /whisper|ggml-/.test(m.name)), 'no audio models — download a whisper gguf from HF');
  if ($('#tts-model')) fillTTSModels(byType.audio);
  renderLocalList();
}

const Q3_LANGS = ['English', 'Mandarin Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'];

function fillTTSModels(audioModels) {
  const s = $('#tts-model');
  const cur = s.value;
  s.innerHTML = '';
  s.append(new Option('Kokoro-82M (built-in)', 'kokoro'));
  for (const m of audioModels) {
    if (!/qwen-talker/.test(m.name)) continue;
    const label = 'Qwen3-TTS ' + m.name.replace('qwen-talker-', '').replace(/\.gguf$/, '').replace(/-/g, ' ');
    s.append(new Option(label, m.path));
  }
  if (cur) s.value = cur;
  switchAudioBackend();
}

function switchAudioBackend() {
  const q3 = $('#tts-model').value !== 'kokoro';
  $('#tts-lang-row').hidden = !q3;
  $('#tts-prompt-row').hidden = !q3;
  $('#clone-text-row').hidden = !q3;
  if (q3 && !$('#tts-lang').options.length) {
    for (const l of Q3_LANGS) $('#tts-lang').append(new Option(l, l));
  }
  loadAudioVoices();
}

function fillSelect(sel, models, placeholder) {
  const s = $(sel);
  const cur = s.value;
  s.innerHTML = '';
  if (!models.length) {
    s.append(new Option(placeholder || 'no models', ''));
  } else {
    for (const m of models) s.append(new Option(m.name, m.path));
  }
  if (cur) s.value = cur;
}

function renderDirList() {
  const box = $('#lib-dirs');
  box.innerHTML = '';
  for (const d of dirs) {
    const row = el('div', 'dir-row');
    row.append(el('span', 'dir-path', d));
    const rm = el('button', 'btn ghost sm', '✕');
    rm.addEventListener('click', () => { dirs = dirs.filter((x) => x !== d); renderDirList(); });
    row.append(rm);
    box.append(row);
  }
  renderDlDirSelect();
}

function renderDlDirSelect() {
  const s = $('#lib-dl-dir');
  const cur = config.downloadDir && dirs.includes(config.downloadDir) ? config.downloadDir : (dirs[0] || '');
  s.innerHTML = '';
  if (!dirs.length) s.append(new Option('no dirs — add one', ''));
  for (const d of dirs) s.append(new Option(d, d));
  s.value = cur;
}

function renderLocalList() {
  const box = $('#lib-local');
  box.innerHTML = '';
  if (!localModels.length) { box.append(el('div', 'muted', 'no models found in ' + config.modelDirs.join(', '))); return; }
  // need engine status for active highlight
  api('/api/engines').then(st=>{
    const active = (st.text && st.text.model) || '';
    for (const m of localModels) {
      const row = el('div', 'model-row' + (m.name===active ? ' active-model' : ''));
      row.append(el('span', 'mtype t-' + m.type, m.type));
      row.append(el('span', 'mname', m.name));
      row.append(el('span', 'msize', fmt(m.size)));
      // VRAM badge
      if (m.type==='text' && m.size) {
        const need = (m.size/1e9)*1.05+1.5;
        const badge = el('span', 'mbadge '+(need<7.5?'ok':'warn'), need<7.5?'fits 8GB':'too big');
        badge.title = '~'+need.toFixed(1)+' GB VRAM';
        row.append(badge);
      }
      if (m.name===active) row.append(el('span','mbadge','● loaded'));
      if (m.moe) row.append(el('span','mbadge remote','MoE'));
      const del = el('button', 'btn ghost', 'Delete');
      del.addEventListener('click', async () => {
        if (!confirm('Delete ' + m.name + '?')) return;
        await api('/api/models/delete', { method: 'POST', body: { path: m.path } });
        refreshLocal();
      });
      row.append(del);
      box.append(row);
    }
  }).catch(()=>{
    for (const m of localModels) {
      const row = el('div', 'model-row');
      row.append(el('span', 'mtype t-' + m.type, m.type));
      row.append(el('span', 'mname', m.name));
      row.append(el('span', 'msize', fmt(m.size)));
      const del = el('button', 'btn ghost', 'Delete');
      del.addEventListener('click', async () => {
        if (!confirm('Delete ' + m.name + '?')) return;
        await api('/api/models/delete', { method: 'POST', body: { path: m.path } });
        refreshLocal();
      });
      row.append(del);
      box.append(row);
    }
  });
}

async function startEngine(type, model, opts) {
  setPill('st-' + type, 'starting…');
  try {
    const status = await api('/api/engine/start', { method: 'POST', body: { type, modelPath: model.path, opts } });
    setPill('st-' + type, status.running ? status.model + ' ✓' : 'idle');
    refreshEngineStatus();
    return status;
  } catch (e) {
    setPill('st-' + type, 'failed');
    appendLog('system', 'START ERROR: ' + e.message);
    return null;
  }
}

function setPill(id, text, running) {
  const p = $('#' + id);
  p.textContent = text;
  p.classList.toggle('running', !!running);
  const ej = document.querySelector('.eject[data-engine="' + id.slice(3) + '"]');
  if (ej) ej.hidden = !running;
}

async function ejectEngine(type) {
  setPill('st-' + type, 'ejecting…');
  try {
    await api('/api/engine/stop', { method: 'POST', body: { type } });
  } catch (e) { setPill('st-' + type, 'failed'); showErr('eject ' + type + ': ' + e.message); return; }
  refreshEngineStatus();
}

function ttsPillLabel() {
  const sel = $('#tts-model');
  const q3 = sel && sel.value !== 'kokoro';
  return (q3 ? (sel.selectedOptions[0] ? sel.selectedOptions[0].text : 'Qwen3-TTS') : 'Kokoro + XTTS-v2') + ' ✓';
}

async function refreshEngineStatus() {
  const st = await api('/api/engines');
  for (const [type, s] of Object.entries(st)) {
    setPill('st-' + type, s.running ? (type === 'audio' ? ttsPillLabel() : (s.model || 'running') + ' ✓') : 'idle', s.running);
  }
  if (config && config.engines) {
    const want = (config.engines.text.provider||'local')==='remote' ? config.engines.text.activeRemoteId : 'local';
    if ($('#chat-provider').value !== want) $('#chat-provider').value = want || 'local';
  }
  try { updateHarnessBar(); } catch(e){}
}

// ---------------- palette ----------------
const PALETTE_ITEMS = [
  { label:'Chat', action:()=>switchTab('chat'), kbd:'1' },
  { label:'Images — txt2img', action:()=>{switchTab('images'); switchSubTab('txt2img');}, kbd:'2' },
  { label:'Images — img2img', action:()=>{switchTab('images'); switchSubTab('img2img');}, kbd:'' },
  { label:'Video', action:()=>switchTab('video'), kbd:'3' },
  { label:'Audio — TTS', action:()=>{switchTab('audio'); switchSubTab('tts');}, kbd:'4' },
  { label:'Audio — Clone', action:()=>{switchTab('audio'); switchSubTab('clone');}, kbd:'' },
  { label:'Library', action:()=>switchTab('library'), kbd:'5' },
  { label:'New chat', action:()=>newConversation(), kbd:'N' },
  { label:'Toggle theme Auto/Light/Dark', action:()=>{
      const cur = config.ui && config.ui.theme || 'auto';
      const next = cur==='auto' ? 'light' : cur==='light' ? 'dark' : 'auto';
      applyTheme(next); config.ui= {...(config.ui||{}), theme: next}; api('/api/config/save',{method:'POST', body:{ui: config.ui}});
    }, kbd:'T' },
  { label:'Clear chat', action:()=>{ if(activeConv){ activeConv.messages=[]; persistConv(); renderChat(); }}, kbd:'' },
  { label:'Toggle engine log', action:()=>$('#log-toggle').click(), kbd:'L' },
];
function openPalette() {
  $('#palette-overlay').hidden = false;
  $('#palette-input').value='';
  $('#palette-input').focus();
  renderPalette('');
}
function closePalette(){ $('#palette-overlay').hidden = true; }
function navPalette(dir){
  const items = [...$('#palette-list').children];
  const cur = items.findIndex(x=>x.classList.contains('active'));
  let nxt = cur + dir;
  if (nxt<0) nxt = items.length-1;
  if (nxt>=items.length) nxt=0;
  items.forEach((x,i)=>x.classList.toggle('active', i===nxt));
}
function renderPalette(q){
  const box = $('#palette-list');
  box.innerHTML='';
  const qq = q.toLowerCase().trim();
  // include models as palette items via filter
  let items = [...PALETTE_ITEMS];
  if (localModels.length) {
    for (const m of localModels.slice(0,8)) items.push({ label:'Load model: '+m.name, action:()=>{
      $('#chat-model').value=m.path; refreshMoeHint(m); if(activeConv){activeConv.model=m.path; persistConv();}
      switchTab('chat');
    }, kbd:'' });
  }
  const filtered = qq ? items.filter(x=> x.label.toLowerCase().includes(qq)) : items;
  for (const it of filtered.slice(0,12)) {
    const row = el('div','palette-item');
    row.append(el('span',null,it.label));
    if (it.kbd) row.append(el('span','pi-kbd', it.kbd));
    row.addEventListener('click', ()=>{ closePalette(); it.action(); });
    box.append(row);
  }
  if (box.firstChild) box.firstChild.classList.add('active');
  if (!filtered.length) box.append(el('div','muted','no match'));
}

// ---------------- chat ----------------
function shrinkImage(dataUrl, maxSide = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (s >= 1) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function addImage(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = async () => {
    const small = await shrinkImage(r.result);
    if (!small) return;
    pendingImages.push(small);
    renderThumbs();
  };
  r.readAsDataURL(file);
}

function renderThumbs() {
  const box = $('#chat-thumbs');
  box.hidden = !pendingImages.length;
  box.innerHTML = '';
  pendingImages.forEach((src, i) => {
    const t = el('div', 'thumb', null);
    t.append(Object.assign(document.createElement('img'), { src }));
    const x = el('button', null, '×');
    x.addEventListener('click', () => { pendingImages.splice(i, 1); renderThumbs(); });
    t.append(x);
    box.append(t);
  });
  if (!pendingImages.length) $('#chat-input').focus();
}

function contentParts(text) {
  if (!pendingImages.length) return text;
  const parts = pendingImages.map((u) => ({ type: 'image_url', image_url: { url: u } }));
  if (text) parts.push({ type: 'text', text });
  return parts;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return String(content || '');
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if ((!text && !pendingImages.length) || chatStreaming) return;
  const provider = $('#chat-provider').value;
  const isRemote = provider !== 'local';
  let modelPath = $('#chat-model').value;
  if (!isRemote && !modelPath) { appendLog('system', 'no model selected'); return; }
  if (isRemote) modelPath = modelPath || 'remote'; // not used but required by API

  const userContent = contentParts(text);
  input.value = '';
  pendingImages = [];
  renderThumbs();
  activeConv.messages.push({ role: 'user', content: userContent });
  if (activeConv.title === 'New chat') activeConv.title = (text || 'image').slice(0, 40);
  persistConv();
  renderConvList($('#conv-search').value);
  renderMsg('user', userContent);

  const ctx = Number($('#chat-ctx').value) || 8192;
  const temp = Number($('#chat-temp').value) || 0.7;
  const thinkingMode = $('#chat-thinking').value;
  const thinkingBudget = +$('#chat-budget').value || 0;
  activeConv.thinkingMode = thinkingMode; activeConv.thinkingBudget = thinkingBudget;
  const sys = ($('#sys-prompt').value || '').trim();
  let messages = activeConv.messages.slice(-8).map(m=> ({ role: m.role, content: m.content }));
  if (sys) messages = [{ role:'system', content: sys }, ...messages];

  chatStreaming = true;
  $('#chat-send').disabled = true;
  $('#chat-stop').disabled = false;

  // reasoning as collapsible details
  const thinkingWrap = el('div', 'msg reasoning', null);
  const det = document.createElement('details');
  det.open = true;
  const summ = document.createElement('summary');
  summ.textContent = 'thinking…';
  const body = el('div','reasoning-body','');
  det.append(summ, body);
  thinkingWrap.append(det);
  thinkingWrap.hidden = true;
  const bubble = el('div', 'msg assistant md', '');
  $('#chat-messages').append(thinkingWrap);
  $('#chat-messages').append(bubble);
  scrollChat();

  let content = '';
  let reasoning = '';
  const ac = new AbortController();
  abortChat = () => ac.abort();

  try {
    const opts = { ctx, temp, thinkingMode, thinkingBudget, maxTokens: Number($('#chat-max').value) || 8192, provider: isRemote ? 'remote':'local', remoteId: isRemote ? provider : '' };
    // pass turbo kv etc for remote? not needed
    if (!isRemote) { opts.cacheTypeK = $('#chat-kv').value; }
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath, messages, opts }),
      signal: ac.signal
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!evt.startsWith('data:')) continue;
        const ev = JSON.parse(evt.slice(5));
        if (ev.content) { content += ev.content; bubble.innerHTML = md(content); addCopyButtons(bubble); }
        if (ev.reasoning) { reasoning += ev.reasoning; thinkingWrap.hidden = false; body.textContent = reasoning; summ.textContent = 'thinking ('+reasoning.length+' chars)'; }
        if (ev.error) { bubble.innerHTML = ''; bubble.textContent = 'error: ' + ev.error; bubble.classList.add('error'); }
        scrollChat();
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') { bubble.textContent = 'error: ' + e.message; bubble.classList.add('error'); }
  } finally {
    chatStreaming = false;
    abortChat = null;
    $('#chat-send').disabled = false;
    $('#chat-stop').disabled = true;
    if (!reasoning) thinkingWrap.hidden = true;
    else det.open = false;
    if (content) {
      activeConv.messages.push({ role: 'assistant', content });
      persistConv();
    }
    scrollChat();
  }
}

function addCopyButtons(container){
  container.querySelectorAll('pre').forEach(pre=>{
    if (pre.querySelector('.copy-btn')) return;
    const btn = el('button','copy-btn','Copy');
    btn.addEventListener('click', async ()=>{
      const code = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent.replace('Copy','');
      const ok = await copyText(code);
      btn.textContent= ok ? 'Copied!' : 'Press Ctrl+C'; setTimeout(()=>btn.textContent='Copy',1200);
    });
    pre.style.position='relative';
    pre.append(btn);
  });
}

function renderMsg(role, content) {
  const m = el('div', 'msg ' + role);
  if (role === 'assistant') {
    m.classList.add('md');
    m.innerHTML = md(contentText(content));
    addCopyButtons(m);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'image_url') {
        const img = document.createElement('img');
        img.src = p.image_url.url;
        img.className = 'attached-img';
        m.append(img);
      } else if (p.type === 'text') {
        m.append(document.createTextNode(p.text));
      }
    }
  } else {
    m.textContent = contentText(content);
  }
  $('#chat-messages').append(m);
  scrollChat();
}

function scrollChat() { $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }

// katex-aware markdown
function md(s) {
  let t = String(s);
  // escape  manually? marked does it; we just inject katex html then let marked parse
  // protect code blocks temporarily
  const codeBlocks = [];
  t = t.replace(/```[\s\S]*?```/g, (m)=>{ codeBlocks.push(m); return '§CODE'+(codeBlocks.length-1)+'§'; });
  // inline code `...` protect $\$ inside
  const inlineCodes = [];
  t = t.replace(/`[^`]*`/g, (m)=>{ inlineCodes.push(m); return '§INLINE'+(inlineCodes.length-1)+'§'; });

  // display math $$...$$ and \[...\]
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr)=>{
    try { return katex.renderToString(expr.trim(), { displayMode:true, throwOnError:false }); } catch(e){ return _; }
  });
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr)=>{
    try { return katex.renderToString(expr.trim(), { displayMode:true, throwOnError:false }); } catch(e){ return _; }
  });
  // inline math $...$ and \(...\)
  // avoid $$ already handled; require single $ not followed by another
  t = t.replace(/(^|[^$\\])\$([^$\n]+?)\$(?=[^$])/g, (m, pre, expr)=>{
    try { return pre + katex.renderToString(expr.trim(), { displayMode:false, throwOnError:false }); } catch(e){ return m; }
  });
  t = t.replace(/\\\((.+?)\\\)/g, (_, expr)=>{
    try { return katex.renderToString(expr.trim(), { displayMode:false, throwOnError:false }); } catch(e){ return _; }
  });

  // restore inline/code
  t = t.replace(/§INLINE(\d+)§/g, (_, i)=> inlineCodes[Number(i)]);
  t = t.replace(/§CODE(\d+)§/g, (_, i)=> codeBlocks[Number(i)]);

  // now let marked parse; avoid double-escaping by not pre-escaping &<> — marked handles it, but katex html should pass through
  // simple: if string contains katex html, we must not escape it; so escape only outside katex spans
  // ponytail: just let marked parse with raw html allowed, escape text via marked's own escaping
  try {
    // temporarily remove katex html
    const katexBlocks=[];
    t = t.replace(/<span class="katex[\s\S]*?<\/span>/g, (m)=>{ katexBlocks.push(m); return '§KATEX'+(katexBlocks.length-1)+'§'; });
    // also display blocks contain <span class="katex-display">
    let html = marked.parse(t);
    html = html.replace(/§KATEX(\d+)§/g, (_, i)=> katexBlocks[Number(i)]);
    html = html.replace(/§CODE(\d+)§/g, (_, i)=> codeBlocks[Number(i)]); // fallback
    return html;
  } catch(e){
    return marked.parse(String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  }
}

// ---------------- server exposure / harness ----------------
async function applyServer() {
  const enabled = $('#srv-enable').checked;
  const apiKey = $('#srv-key').value.trim();
  const btn = $('#srv-apply');
  btn.disabled = true;
  btn.textContent = 'restarting…';
  try {
    const r = await api('/api/server/set', { method: 'POST', body: { enabled, apiKey, modelPath: $('#chat-model').value } });
    config = await api('/api/config');
    updateHarnessBar();
    $('#srv-url').textContent = r.error ? 'ERROR: ' + r.error : (r.url ? 'base URL: ' + r.url : (r.localUrl||''));
    if (r.error) appendLog('system', 'server: ' + r.error);
    refreshEngineStatus();
  } catch (e) {
    $('#srv-url').textContent = 'ERROR: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

// ---------------- images ----------------
function imgOpts(initImage) {
  return {
    width: +$('#img-w').value, height: +$('#img-h').value,
    steps: +$('#img-steps').value, seed: +$('#img-seed').value,
    cfgScale: +$('#img-cfg').value, batch: +$('#img-batch').value,
    samplerName: $('#img-sampler').value, scheduler: $('#img-scheduler').value,
    negativePrompt: $('#img-neg').value,
    clipSkip: +$('#img-clipskip').value, upscale: $('#img-upscale').checked,
    initImage
  };
}

async function generateImage() {
  const modelPath = $('#img-model').value;
  if (!modelPath) { $('#img-status').textContent = 'no image model selected'; return; }
  const sub = document.querySelector('.sub-tab.active').dataset.sub;
  const opts = imgOpts(sub === 'img2img' ? window.__img2b64 : null);
  if (sub === 'img2img' && !opts.initImage) { $('#img-status').textContent = 'upload an image first'; return; }
  $('#img-status').textContent = 'starting engine…';
  const engine = await api('/api/engines');
  if (!engine.image.running) {
    const m = modelById(modelPath);
    const st = await startEngine('image', m);
    if (!st) return;
  }
  $('#img-status').textContent = 'generating…';
  const t0 = Date.now();
  try {
    const r = await api('/api/images/' + (sub === 'img2img' ? 'img2img' : 'generate'), { method: 'POST', body: { prompt: $('#img-prompt').value, opts } });
    const box = $('#img-result');
    box.innerHTML = '';
    for (const img of r.images) {
      const elImg = document.createElement('img');
      elImg.src = 'data:image/png;base64,' + img;
      box.append(elImg);
    }
    $('#img-save').hidden = false;
    window.__lastMedia = { data: r.images[0], ext: 'png' };
    pushHistory(r.images[0], 'png');
    const info = JSON.parse(r.info || '{}');
    $('#img-meta').textContent = [opts.samplerName, opts.scheduler, info.seed !== undefined ? 'seed ' + info.seed : '', ((Date.now() - t0) / 1000).toFixed(1) + 's'].join(' · ');
    $('#img-status').textContent = 'done';
  } catch (e) {
    $('#img-status').textContent = 'ERROR: ' + e.message;
  }
}
function pushHistory(b64, ext){
  const strip = $('#img-history');
  if(!strip) return;
  imageHistory.unshift({ b64, ext });
  if (imageHistory.length>8) imageHistory.pop();
  strip.hidden = false;
  strip.innerHTML='';
  imageHistory.forEach((h,i)=>{
    const im = document.createElement('img');
    im.src = 'data:image/png;base64,'+h.b64;
    if (i===0) im.classList.add('active');
    im.addEventListener('click', ()=>{
      $('#img-result').innerHTML='';
      const big = document.createElement('img');
      big.src = 'data:image/png;base64,'+h.b64;
      $('#img-result').append(big);
      window.__lastMedia = { data: h.b64, ext: h.ext };
      strip.querySelectorAll('img').forEach(x=>x.classList.remove('active'));
      im.classList.add('active');
    });
    strip.append(im);
  });
}

// ---------------- video ----------------
async function generateVideo() {
  const modelPath = $('#vid-model').value;
  if (!modelPath) { $('#vid-status').textContent = 'no model selected'; return; }
  $('#vid-status').textContent = 'starting engine…';
  const engine = await api('/api/engines');
  if (!engine.video.running) {
    const m = modelById(modelPath);
    const st = await startEngine('video', m, { frames: +$('#vid-frames').value, fps: +$('#vid-fps').value });
    if (!st) return;
  }
  $('#vid-status').textContent = 'generating video (this takes a while)…';
  const t0 = Date.now();
  const opts = {
    width: +$('#vid-w').value, height: +$('#vid-h').value,
    frames: +$('#vid-frames').value, fps: +$('#vid-fps').value,
    steps: +$('#vid-steps').value, seed: +$('#vid-seed').value,
    cfgScale: +$('#vid-cfg').value,
    samplerName: $('#vid-sampler').value, scheduler: $('#vid-scheduler').value
  };
  try {
    const r = await api('/api/video/generate', { method: 'POST', body: { prompt: $('#vid-prompt').value, opts } });
    const box = $('#vid-result');
    box.innerHTML = '';
    const vid = document.createElement('video');
    vid.controls = true;
    vid.autoplay = true;
    vid.loop = true;
    vid.src = 'data:video/webm;base64,' + r.b64_json;
    box.append(vid);
    $('#vid-save').hidden = false;
    window.__lastMedia = { data: r.b64_json, ext: 'webm' };
    $('#vid-meta').textContent = [opts.samplerName, opts.scheduler, 'seed ' + opts.seed, ((Date.now() - t0) / 1000).toFixed(1) + 's'].join(' · ');
    $('#vid-status').textContent = 'done';
  } catch (e) {
    $('#vid-status').textContent = 'ERROR: ' + e.message;
  }
}

function saveMedia() {
  const m = window.__lastMedia;
  if (!m) return;
  const a = document.createElement('a');
  a.href = 'data:' + (m.ext === 'png' ? 'image/png' : 'video/webm') + ';base64,' + m.data;
  a.download = 'polaris-' + Date.now() + '.' + m.ext;
  a.click();
}

// ---------------- audio ----------------
let audioVoices = [];

async function loadAudioVoices() {
  try {
    const d = await api('/api/audio/voices');
    audioVoices = d.voices || [];
    const s = $('#audio-voice');
    const cur = s.value;
    const q3 = $('#tts-model') && $('#tts-model').value !== 'kokoro';
    s.innerHTML = '';
    if (q3) {
      s.append(new Option('default voice', 'default'));
      for (const v of audioVoices.filter((v) => v.group === 'Cloned')) s.append(new Option(v.label, v.id));
    } else {
      let group = null;
      for (const v of audioVoices) {
        if (v.group !== group) {
          group = v.group;
          s.append(document.createElement('optgroup'));
          s.lastChild.label = group;
        }
        s.lastChild.append(new Option(v.label + ' — ' + v.id, v.id));
      }
    }
    if (cur) s.value = cur;
    renderCloneList();
  } catch (e) { /* audio engine not running yet */ }
}

function renderCloneList() {
  const box = $('#clone-list');
  box.innerHTML = '';
  for (const v of audioVoices.filter((v) => v.group === 'Cloned')) {
    const row = el('div', 'model-row');
    row.append(el('span', 'mname', v.label));
    const del = el('button', 'btn ghost', 'Delete');
    del.addEventListener('click', async () => {
      await api('/api/audio/delete-clone', { method: 'POST', body: { name: v.id } });
      loadAudioVoices();
    });
    row.append(del);
    box.append(row);
  }
  if (!box.children.length) box.append(el('div', 'muted', 'no cloned voices yet'));
}

async function generateTTS() {
  const text = $('#audio-text').value.trim();
  if (!text) return;
  const st = $('#audio-status');
  st.textContent = 'synthesizing…';
  try {
    const r = await api('/api/audio/tts', { method: 'POST', body: { text, voice: $('#audio-voice').value, speed: +$('#audio-speed').value, format: $('#audio-format').value, model: $('#tts-model').value, lang: $('#tts-lang').value || 'English', instr: $('#tts-voice-prompt').value.trim() } });
    if (r.error) throw new Error(r.error);
    window.__lastAudio = { data: r.audioB64, ext: $('#audio-format').value };
    const box = $('#audio-preview');
    box.innerHTML = '';
    const au = document.createElement('audio');
    au.controls = true;
    au.src = 'data:audio/' + $('#audio-format').value + ';base64,' + r.audioB64;
    box.append(au);
    $('#audio-meta').textContent = r.file.split('/').pop() + ' · ' + r.duration + 's';
    $('#audio-save').hidden = false;
    st.textContent = '';
  } catch (e) { st.textContent = 'error: ' + e.message; }
}

function saveAudio() {
  const m = window.__lastAudio;
  if (!m) return;
  const a = document.createElement('a');
  a.href = 'data:audio/' + m.ext + ';base64,' + m.data;
  a.download = 'polaris-tts-' + Date.now() + '.' + m.ext;
  a.click();
}

async function cloneVoice() {
  const f = $('#clone-file').files[0];
  const name = $('#clone-name').value.trim();
  const st = $('#clone-status');
  const q3 = $('#tts-model').value !== 'kokoro';
  if (!f) { st.textContent = 'pick a reference clip first'; return; }
  if (!name) { st.textContent = 'give the voice a name'; return; }
  const transcript = $('#clone-text').value.trim();
  if (q3 && !transcript) { st.textContent = 'Qwen3 clone needs the transcript of the clip'; return; }
  st.textContent = q3 ? 'cloning… (local, ~3s clip is enough)' : 'cloning… (first run downloads XTTS-v2, ~2 GB)';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    const r = await api('/api/audio/clone', { method: 'POST', body: { audioB64: b64, name, transcript } });
    if (r.error) throw new Error(r.error);
    st.textContent = 'cloned as "' + r.voice + '"';
    $('#clone-name').value = '';
    loadAudioVoices();
  } catch (e) { st.textContent = 'error: ' + e.message; }
}

async function transcribe() {
  const f = $('#trans-file').files[0];
  const st = $('#trans-status');
  if (!f) { st.textContent = 'pick an audio file'; return; }
  if (!$('#audio-model').value) { st.textContent = 'pick a whisper model in the Library first'; return; }
  st.textContent = 'transcribing…';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    const r = await api('/api/audio/transcribe', { method: 'POST', body: { audioB64: b64, model: $('#audio-model').value, language: $('#trans-lang').value } });
    if (r.error) throw new Error(r.error);
    $('#trans-text').value = r.text;
    st.textContent = r.text ? 'done' : 'no speech detected';
    if ($('#trans-autocopy').checked && r.text) copyText(r.text).catch(()=>{});
  } catch (e) { st.textContent = 'error: ' + e.message; }
}

// ---------------- live mic ----------------
let liveCtx = null;
let liveSrc = null;
let liveWorklet = null;
let liveStream = null;
let liveBusy = false;
let liveChunks = 0;

function pcmToWav(f32, rate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * 2, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }
  return buf;
}

async function toggleLive() {
  const btn = $('#trans-live');
  const st = $('#trans-live-status');
  if (liveWorklet) {
    liveSrc.disconnect();
    await liveCtx.close();
    liveStream.getTracks().forEach((t) => t.stop());
    liveCtx = liveSrc = liveWorklet = liveStream = null;
    btn.textContent = 'Start live mic';
    st.textContent = 'stopped (' + liveChunks + ' chunks)';
    return;
  }
  if (!$('#audio-model').value) { st.textContent = 'pick a whisper model in the Library first'; return; }
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    st.textContent = 'mic error: ' + e.message;
    return;
  }
  liveChunks = 0;
  liveBusy = false;
  try {
    liveCtx = new AudioContext();
    await liveCtx.audioWorklet.addModule('mic-worklet.js');
    liveSrc = liveCtx.createMediaStreamSource(liveStream);
    liveWorklet = new AudioWorkletNode(liveCtx, 'polaris-mic');
    liveSrc.connect(liveWorklet);
    liveWorklet.port.onmessage = async (e) => {
      if (liveBusy) return;
      liveBusy = true;
      liveChunks++;
      try {
        const wav = pcmToWav(new Float32Array(e.data), liveCtx.sampleRate);
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(new Blob([wav], { type: 'audio/wav' }));
        });
        const r = await api('/api/audio/transcribe', { method: 'POST', body: { audioB64: b64, model: $('#audio-model').value, language: $('#trans-lang').value } });
        const t = (r.text || '').trim();
        if (t) {
          $('#trans-text').value += ($('#trans-text').value ? ' ' : '') + t;
          if ($('#trans-autocopy').checked) copyText(t).catch(()=>{});
        }
        st.textContent = 'listening… (' + liveChunks + ' chunks)';
      } catch (err) { st.textContent = 'error: ' + err.message; }
      finally { liveBusy = false; }
    };
  } catch (e) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
    st.textContent = 'worklet error: ' + e.message;
    return;
  }
  btn.textContent = 'Stop live mic';
  st.textContent = 'listening…';
}

// ---------------- HF ----------------
async function hfSearch() {
  const q = $('#hf-q').value.trim();
  if (!q) return;
  const box = $('#hf-results');
  box.innerHTML = '';
  box.append(el('div', 'muted', 'searching…'));
  let models;
  try { models = await api('/api/hf/search?q=' + encodeURIComponent(q)); }
  catch (e) { box.innerHTML = ''; box.append(el('div', 'msg error', 'search failed: ' + e.message)); return; }
  box.innerHTML = '';
  for (const m of models.slice(0, 15)) {
    const row = el('div', 'model-row');
    const info = el('div', null);
    const title = el('div', 'mname', m.id);
    const meta = el('div', 'msize', (m.downloads / 1e3).toFixed(0) + 'k downloads · ' + (m.pipelineTag || '?'));
    info.append(title, meta);
    row.append(info);
    const browse = el('button', 'btn ghost', 'Files');
    browse.addEventListener('click', () => hfFiles(m.id, row));
    row.append(browse);
    box.append(row);
  }
}

async function hfFiles(repoId, row) {
  if (row.dataset.files) return;
  if (row.dataset.loading) return;
  row.dataset.loading = '1';
  const prev = row.nextElementSibling;
  if (prev && prev.classList.contains('lib-list')) prev.remove();
  const filesBox = el('div', 'lib-list', null);
  filesBox.style.maxHeight = '200px';
  filesBox.style.flex = '0 0 auto';
  row.after(filesBox);
  let list;
  try { list = await api('/api/hf/files?repo=' + encodeURIComponent(repoId), { signal: AbortSignal.timeout(20000) }); }
  catch (e) { filesBox.append(el('div', 'msg error', 'listing failed: ' + e.message)); delete row.dataset.loading; return; }
  delete row.dataset.loading;
  row.dataset.files = '1';
  const shown = list.files.slice(0, 12);
  if (!shown.length) { filesBox.append(el('div', 'muted', 'no runnable files (.gguf / .safetensors)')); }
  for (const f of shown) {
    const fr = el('div', 'model-row');
    fr.append(el('span', 'mname', f.file));
    fr.append(el('span', 'msize', f.size ? fmt(f.size) : '?'));
    const infoBtn = el('button', 'btn ghost', '?');
    infoBtn.addEventListener('click', () => fileInfo(f, infoBtn));
    fr.append(infoBtn);
    const dl = el('button', 'btn', '↓');
    dl.addEventListener('click', () => startDownload(repoId, f.file, dl));
    fr.append(dl);
    filesBox.append(fr);
  }
  if (list.files.length > shown.length) filesBox.append(el('div', 'muted', '+' + (list.files.length - shown.length) + ' more files'));
}

function fileInfo(f, btn) {
  const row = btn.parentElement;
  const box = row.parentElement;
  const cur = box.querySelector('.file-info');
  if (cur) {
    const same = cur._row === row;
    cur.remove();
    if (same) return;
  }
  const quant = (f.file.match(/(IQ\d[\w_]+|Q\d{1,2}_[\w]+|BF16|FP16|F16|F32)/i) || [])[1] || 'n/a';
  const info = el('div', 'file-info');
  info._row = row;
  info.append(el('div', 'file-info-title', f.file));
  info.append(el('div', 'file-info-line', 'quant · ' + quant));
  if (f.size) {
    const need = (f.size / 1e9) * 1.05 + 1.5;
    info.append(el('div', 'file-info-line', 'size · ' + fmt(f.size)));
    info.append(el('div', 'file-info-line', 'VRAM · needs ~' + need.toFixed(1) + ' GB → ' + (need < 7.5 ? 'fits RX 580 8 GB' : 'too big for 8 GB')));
  } else {
    info.append(el('div', 'file-info-line', 'size · unknown'));
  }
  row.after(info);
}

async function startDownload(repoId, file, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  const destDir = config.downloadDir || config.modelDirs[0] || '';
  if (!destDir) {
    btn.disabled = false; btn.textContent = '↓';
    alert('no model directory set — add one in the Library tab');
    return;
  }
  let id;
  try { ({ id } = await api('/api/hf/download', { method: 'POST', body: { repo: repoId, file, destDir } })); }
  catch (e) { btn.disabled = false; btn.textContent = '↓'; alert('download failed: ' + e.message); return; }
  btn.textContent = 'queued';
  const row = el('div', 'dl-row');
  row.dataset.id = cssId(id);
  row.append(el('span', 'dl-name', file));
  const bar = el('div', 'bar');
  bar.append(el('div'));
  row.append(bar);
  row.append(el('span', 'dl-pct', '0%'));
  const canc = el('button','dl-cancel','Cancel');
  canc.addEventListener('click', async ()=>{
    canc.disabled=true; canc.textContent='…';
    try { await api('/api/hf/abort', { method:'POST', body:{ id } }); } catch(e){}
    row.querySelector('.dl-pct').textContent='cancelled';
  });
  row.append(canc);
  $('#lib-downloads').append(row);
}

function dlProgress({ id, bytes, total }) {
  const row = document.querySelector(`.dl-row[data-id="${cssId(id)}"]`);
  if (!row) return;
  const pct = total ? Math.min(100, (bytes / total) * 100) : 0;
  row.querySelector('.bar > div').style.width = pct + '%';
  row.querySelector('.dl-pct').textContent = fmt(bytes) + ' / ' + fmt(total) + ' (' + pct.toFixed(0) + '%)';
  if (pct >= 100) { const c=row.querySelector('.dl-cancel'); if(c) c.textContent='Done'; }
}

function dlError({ id, error }) {
  const row = document.querySelector(`.dl-row[data-id="${cssId(id)}"]`);
  if (row) row.querySelector('.dl-pct').textContent = 'ERROR: ' + error;
}

init();
