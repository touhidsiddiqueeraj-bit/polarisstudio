/* global marked */
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
let evSource = null;

// ---------------- init ----------------
async function init() {
  bindUI();            // buttons first — no data hiccup may kill them
  connectEvents();
  try { config = await api('/api/config'); } catch (e) { showErr('config: ' + e.message); return; }
  if (config.server) {
    $('#srv-enable').checked = !!config.server.enabled;
    if (config.server.apiKey) $('#srv-key').value = config.server.apiKey;
  }
  dirs = [...(config.modelDirs || [])];
  renderDirList();
  if (config.audio) {
    $('#audio-outdir').value = config.audio.outputDir || '';
    $('#trans-autocopy').checked = !!config.audio.copyTranscript;
  }
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
  $('#chat-stop').addEventListener('click', () => { if (abortChat) abortChat(); });
  $('#chat-clear').addEventListener('click', () => { if (activeConv) { activeConv.messages = []; persistConv(); renderChat(); } });
  $('#chat-model').addEventListener('change', (e) => { if (activeConv) { activeConv.model = e.target.value; persistConv(); } });
  $('#chat-thinking').addEventListener('change', () => { if (activeConv) { activeConv.thinking = $('#chat-thinking').checked; persistConv(); } });
  $('#app-quit').addEventListener('click', async () => { try { await api('/api/quit', { method: 'POST' }); } catch (e) { location.reload(); } });
  $('#chat-start-engine').addEventListener('click', async () => {
    const m = modelById($('#chat-model').value);
    if (m) { await startEngine('text', m, { ctx: +$('#chat-ctx').value || 8192 }); refreshEngineStatus(); }
  });

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
  $('#audio-start-engine').addEventListener('click', async () => {
    setPill('st-audio', 'starting…');
    try {
      const status = await api('/api/engine/start', { method: 'POST', body: { type: 'audio' } });
      setPill('st-audio', status.running ? status.model + ' ✓' : 'idle');
    } catch (e) { setPill('st-audio', 'failed'); showErr('audio start: ' + e.message); }
    loadAudioVoices();
  });
  $('#audio-gen').addEventListener('click', generateTTS);
  $('#audio-save').addEventListener('click', saveAudio);
  $('#clone-go').addEventListener('click', cloneVoice);
  $('#clone-file').addEventListener('change', () => { $('#clone-status').textContent = $('#clone-file').files[0] ? $('#clone-file').files[0].name + ' (' + fmt($('#clone-file').files[0].size) + ')' : ''; });
  $('#trans-go').addEventListener('click', transcribe);
  $('#trans-copy').addEventListener('click', () => navigator.clipboard.writeText($('#trans-text').value));
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
  $('#log-toggle').addEventListener('click', () => {
    const bar = $('.logbar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#engine-log').scrollTop = $('#engine-log').scrollHeight;
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
  activeConv = { id: 'c' + Date.now().toString(36), title: 'New chat', model: $('#chat-model').value || '', thinking: true, messages: [] };
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

function renderConvList() {
  const box = $('#conv-list');
  box.innerHTML = '';
  for (const c of conversations) {
    const row = el('div', 'conv-row' + (c.id === activeConv.id ? ' active' : ''), null);
    const label = el('span', 'conv-title', c.title);
    row.append(label);
    const del = el('button', 'conv-del', '×');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      conversations = conversations.filter((x) => x.id !== c.id);
      api('/api/conversations/delete', { method: 'POST', body: { id: c.id } });
      if (activeConv.id === c.id) newConversation(false);
      renderConvList();
    });
    row.append(del);
    row.addEventListener('click', () => { activeConv = c; renderConvList(); renderChat(); });
    label.addEventListener('dblclick', () => {
      const inp = document.createElement('input');
      inp.value = c.title;
      inp.className = 'conv-rename';
      label.replaceWith(inp);
      inp.focus();
      inp.addEventListener('blur', () => { c.title = inp.value.trim() || c.title; persistConv(); renderConvList(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    box.append(row);
  }
}

function renderChat() {
  $('#chat-messages').innerHTML = '';
  $('#chat-model').value = activeConv.model;
  $('#chat-thinking').checked = !!activeConv.thinking;
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
  fillSelect('#img-model', byType.image, 'no image models — SD1.5 gguf expected');
  fillSelect('#vid-model', byType.video.length ? byType.video : byType.image, byType.video.length ? '' : 'using image models (AnimateDiff mode)');
  if ($('#audio-model')) fillSelect('#audio-model', byType.audio, 'no audio models — download a whisper gguf from HF');
  renderLocalList();
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
}

async function refreshEngineStatus() {
  const st = await api('/api/engines');
  for (const [type, s] of Object.entries(st)) {
    setPill('st-' + type, s.running ? (s.model || 'running') + ' ✓' : 'idle', s.running);
  }
}

// ---------------- chat ----------------
async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || chatStreaming) return;
  const modelPath = $('#chat-model').value;
  if (!modelPath) { appendLog('system', 'no model selected'); return; }

  input.value = '';
  activeConv.messages.push({ role: 'user', content: text });
  if (activeConv.title === 'New chat') activeConv.title = text.slice(0, 40);
  persistConv();
  renderConvList();
  renderMsg('user', text);

  const ctx = Number($('#chat-ctx').value) || 8192;
  const temp = Number($('#chat-temp').value) || 0.7;
  const thinking = $('#chat-thinking').checked;
  const messages = activeConv.messages.slice(-8);

  chatStreaming = true;
  $('#chat-send').disabled = true;
  $('#chat-stop').disabled = false;

  const thinkingEl = el('div', 'msg reasoning', '…');
  const bubble = el('div', 'msg assistant md', '');
  $('#chat-messages').append(thinkingEl);
  $('#chat-messages').append(bubble);
  scrollChat();

  let content = '';
  let reasoning = '';
  const ac = new AbortController();
  abortChat = () => ac.abort();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath, messages, opts: { ctx, temp, thinking, maxTokens: 2048 } }),
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
        if (ev.content) { content += ev.content; bubble.innerHTML = md(content); }
        if (ev.reasoning) { reasoning += ev.reasoning; thinkingEl.textContent = 'thinking: ' + reasoning; }
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
    if (content) {
      activeConv.messages.push({ role: 'assistant', content });
      persistConv();
    }
    scrollChat();
  }
}

function renderMsg(role, text) {
  const m = el('div', 'msg ' + role, text);
  if (role === 'assistant') m.classList.add('md');
  $('#chat-messages').append(m);
  scrollChat();
}

function scrollChat() { $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; }

const md = (s) => marked.parse(String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

// ---------------- server exposure ----------------
async function applyServer() {
  const enabled = $('#srv-enable').checked;
  const apiKey = $('#srv-key').value.trim();
  const btn = $('#srv-apply');
  btn.disabled = true;
  btn.textContent = 'restarting…';
  try {
    const r = await api('/api/server/set', { method: 'POST', body: { enabled, apiKey, modelPath: $('#chat-model').value } });
    $('#srv-url').textContent = r.error ? 'ERROR: ' + r.error : (r.url ? 'base URL: ' + r.url : '');
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
    const info = JSON.parse(r.info || '{}');
    $('#img-meta').textContent = [opts.samplerName, opts.scheduler, info.seed !== undefined ? 'seed ' + info.seed : '', ((Date.now() - t0) / 1000).toFixed(1) + 's'].join(' · ');
    $('#img-status').textContent = 'done';
  } catch (e) {
    $('#img-status').textContent = 'ERROR: ' + e.message;
  }
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
    s.innerHTML = '';
    let group = null;
    for (const v of audioVoices) {
      if (v.group !== group) {
        group = v.group;
        s.append(document.createElement('optgroup'));
        s.lastChild.label = group;
      }
      s.lastChild.append(new Option(v.label + ' — ' + v.id, v.id));
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
    const r = await api('/api/audio/tts', { method: 'POST', body: { text, voice: $('#audio-voice').value, speed: +$('#audio-speed').value, format: $('#audio-format').value } });
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
  if (!f) { st.textContent = 'pick a reference clip first'; return; }
  if (!name) { st.textContent = 'give the voice a name'; return; }
  st.textContent = 'cloning… (first run downloads XTTS-v2, ~2 GB)';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    const r = await api('/api/audio/clone', { method: 'POST', body: { audioB64: b64, name } });
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
    if ($('#trans-autocopy').checked && r.text) navigator.clipboard.writeText(r.text);
  } catch (e) { st.textContent = 'error: ' + e.message; }
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
  filesBox.style.flex = '0 0 auto'; // flex parent crushes shrinkable items to 0 height when oversubscribed — box must keep its height and let the parent scroll
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
  $('#lib-downloads').append(row);
}

function dlProgress({ id, bytes, total }) {
  const row = document.querySelector(`.dl-row[data-id="${cssId(id)}"]`);
  if (!row) return;
  const pct = total ? Math.min(100, (bytes / total) * 100) : 0;
  row.querySelector('.bar > div').style.width = pct + '%';
  row.querySelector('.dl-pct').textContent = fmt(bytes) + ' / ' + fmt(total) + ' (' + pct.toFixed(0) + '%)';
}

function dlError({ id, error }) {
  const row = document.querySelector(`.dl-row[data-id="${cssId(id)}"]`);
  if (row) row.querySelector('.dl-pct').textContent = 'ERROR: ' + error;
}

init();
