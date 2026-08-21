const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('./lib/config');
const models = require('./lib/models');
const hf = require('./lib/hf');
const { Engine, getJson, postJson } = require('./lib/engines');

const UI_PORT = 9090;
const CONVERSATIONS_PATH = path.join(config.DATA_DIR, 'conversations.json');

let win = null;
const sseClients = new Set();

// engine instances: text / image / video / audio (companion python server)
const engines = {};
for (const type of ['text', 'image', 'video', 'audio']) {
  const cfg = { ...config.get().engines[type] };
  if (type === 'audio') {
    cfg.script = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'audio_server.py') : path.join(__dirname, 'audio_server.py');
    cfg.spawnEnv = {
      AUDIO_OUT_DIR: config.get().audio.outputDir || path.join(os.homedir(), 'PolarisAudio'),
      AUDIO_VOICES_DIR: path.join(config.DATA_DIR, 'voices'),
      Q3TTS_BIN: config.get().engines.audio.qwen3Binary || '',
      Q3_CODEC: config.get().engines.audio.q3Codec || '',
      GGML_BACKEND: config.get().engines.audio.ggmlBackend || 'Vulkan0'
    };
  }
  engines[type] = new Engine(type, cfg, (t, line) => broadcast({ type: 'engine:log', typeName: t, line }));
}

const downloads = new Map(); // id -> Download

let transcribeN = 0;

function transcribe(data) {
  return new Promise((resolve, reject) => {
    const bin = config.get().engines.stt.binary;
    if (!bin || !fs.existsSync(bin)) return reject(new Error(`stt binary missing: ${bin}`));
    const tmp = path.join(os.tmpdir(), `polaris-stt-${Date.now()}-${transcribeN++}`);
    const wav = tmp + '.wav';
    const raw = Buffer.from(data.audioB64 || '', 'base64');
    if (!raw.length) return reject(new Error('empty audio received'));
    fs.writeFileSync(wav, raw);
    const { spawn, execFile } = require('child_process');
    // whisper-cli only reads WAV; convert known non-wav containers (uploads) with ffmpeg
    const convert = () => new Promise((res, rej) => {
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', tmp + '.c.wav'], (err) => {
        if (!err) { fs.renameSync(tmp + '.c.wav', wav); return res(); }
        try { fs.unlinkSync(wav); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(tmp + '.c.wav'); } catch (e) { /* ignore */ }
        const line = String(err.stderr || err.message || '').split('\n')[0].trim();
        rej(new Error('ffmpeg: ' + (line || 'decode failed').slice(0, 160)));
      });
    });
    const run = () => {
      const args = ['-m', data.model, '-f', wav, '-nt', '-np', '-l', data.language || 'auto', '-otxt', '-of', tmp];
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (d) => (err += d.toString()));
      proc.on('error', (e) => { try { fs.unlinkSync(wav); } catch (x) { /* ignore */ } reject(e); });
      proc.on('close', (code) => {
        fs.unlinkSync(wav);
        if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${err.slice(0, 300)}`));
        let text = '';
        try { text = fs.readFileSync(tmp + '.txt', 'utf8'); } catch (e) { /* fall through */ }
        try { fs.unlinkSync(tmp + '.txt'); } catch (e) { /* ignore */ }
        resolve({ text: text.trim() });
      });
    };
    const sig = raw.length >= 4 ? raw.toString('latin1', 0, 4) : '';
    const known = ['RIFF', '\x1aE\xdf\xa3', 'ftyp', 'ID3', '\xff\xfb', '\xff\xf3', 'OggS', 'fLaC'];
    const isWav = sig === 'RIFF';
    if (!isWav && !known.some((s) => sig.startsWith(s)))
      return reject(new Error(`unrecognized audio (got 0x${raw.toString('hex', 0, 8)}) — mic chunk or unsupported file format`));
    (isWav ? Promise.resolve() : convert()).then(run).catch(reject);
  });
}

function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) res.write(data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#0f1115',
    title: 'PolarisStudio',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${UI_PORT}`);
  // live mic transcription needs getUserMedia; the page is our own localhost UI
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media'));
  // renderer crash (GPU/GL issue on old cards) must not take the whole app down
  win.webContents.on('render-process-gone', () => {
    console.log('renderer crashed — recreating window, server stays up');
    setTimeout(() => { if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow(); }, 1500);
  });
}

// thinking emulation: Off→enable_thinking:false; On→true; low/medium/high/max→true + reasoning_effort; budget>0→thinking_budget
function thinkingKwargs(opts) {
  const mode = opts.thinkingMode ?? (opts.thinking === undefined ? undefined : (opts.thinking ? 'on' : 'off'));
  const kw = {};
  if (mode === 'off') kw.enable_thinking = false;
  else if (mode === 'on') kw.enable_thinking = true;
  else { const e = ['low', 'medium', 'high', 'max'].includes(mode); if (e) { kw.enable_thinking = true; kw.reasoning_effort = mode; } else kw.enable_thinking = true; }
  const budget = Number(opts.thinkingBudget);
  if (Number.isFinite(budget) && budget > 0) kw.thinking_budget = Math.round(budget);
  return Object.keys(kw).length ? kw : null;
}

// ---- remote helpers (chat-only) ----
function getRemote(id) {
  const list = config.get().remotes || [];
  return list.find((r) => r.id === id) || null;
}
function remoteChatStream(remote, messages, opts, sendEvent) {
  return new Promise((resolve, reject) => {
    const body = { messages, stream: true, temperature: opts.temp ?? 0.7, max_tokens: opts.maxTokens ?? (config.get().engines.text.maxTokens || 8192), repeat_penalty: opts.repeatPenalty ?? 1.1, model: opts.remoteModel || remote.model || undefined };
    const kw = thinkingKwargs(opts);
    if (kw) body.chat_template_kwargs = kw;
    if (kw && kw.reasoning_effort) body.reasoning_effort = kw.reasoning_effort;
    const headers = { 'Content-Type': 'application/json' };
    if (remote.apiKey) headers.Authorization = 'Bearer ' + remote.apiKey;
    const u = new URL('/v1/chat/completions', remote.baseUrl);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { sendEvent({ done: true }); resolve(); return; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta) {
              if (delta.reasoning_content) sendEvent({ reasoning: delta.reasoning_content });
              if (delta.content) sendEvent({ content: delta.content });
            }
          } catch (e) { /* partial chunk */ }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- single-port harness proxy (9090/v1/* → 127.0.0.1:8080) ----
async function ensureHarnessModel() {
  const h = config.get().harness || {};
  const engine = engines.text;
  if (engine.isRunning()) return;
  let modelPath = h.model || '';
  if (!modelPath) {
    // pick first local text model
    try { const list = models.list(config.get().modelDirs); const t = list.find(m=>m.type==='text'); if (t) modelPath = t.path; } catch(e){}
  }
  if (!modelPath) return;
  try { await engine.start(modelPath, { ctx: engine.cfg.ctx || 8192 }); } catch(e){ broadcast({ type:'engine:log', typeName:'system', line:'harness auto-start failed: '+e.message }); }
}
function handleV1Proxy(req, res) {
  const engine = engines.text;
  // CORS for opencode and other harness clients
  const origin = req.headers.origin || '*';
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Expose-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  // handle /v1/models without needing engine running — return local list as fallback
  if (req.url === '/v1/models' || req.url.startsWith('/v1/models?')) {
    if (!engine.isRunning()) {
      // try to return local model list as OpenAI format
      try {
        const list = models.list(config.get().modelDirs).filter(m=>m.type==='text');
        const data = list.map(m=>({ id: m.name, object:'model', created: Math.floor(Date.now()/1000), owned_by:'polaris' }));
        res.writeHead(200, { 'Content-Type':'application/json', ...cors });
        res.end(JSON.stringify({ object:'list', data }));
        return;
      } catch(e){}
    }
  }
  // ensure harness model is loaded for chat/completions (keepAlive)
  const needsModel = req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/completions') || req.url.startsWith('/v1/embeddings');
  const doProxy = () => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    // forward api key if harness has one? use engine cfg apiKey
    if (engine.cfg.apiKey && !headers.authorization) headers.authorization = 'Bearer ' + engine.cfg.apiKey;
    const opts = { method: req.method, headers, timeout: 0 };
    const proxy = http.request(engine.baseUrl + req.url, opts, (r) => {
      const h = { ...r.headers, ...cors };
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    proxy.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type':'application/json', ...cors }); res.end(JSON.stringify({ error: String(e) })); }
    });
    req.pipe(proxy);
  };
  if (needsModel && !engine.isRunning()) {
    ensureHarnessModel().then(()=>{ if (engine.isRunning()) doProxy(); else { res.writeHead(503, { 'Content-Type':'application/json', ...cors }); res.end(JSON.stringify({ error:'no model loaded — select a model in PolarisStudio Chat and Start engine' })); } });
  } else {
    doProxy();
  }
}

// ---- chat streaming (SSE to the HTTP client) ----
function chatStream(engine, messages, opts, sendEvent) {
  return new Promise((resolve, reject) => {
    const body = { messages, stream: true, temperature: opts.temp ?? 0.7, max_tokens: opts.maxTokens ?? (config.get().engines.text.maxTokens || 8192), repeat_penalty: opts.repeatPenalty ?? 1.1 };
    const kw = thinkingKwargs(opts);
    if (kw) body.chat_template_kwargs = kw;
    const headers = { 'Content-Type': 'application/json' };
    if (engine.cfg.apiKey) headers.Authorization = 'Bearer ' + engine.cfg.apiKey;
    const req = http.request(engine.baseUrl + '/v1/chat/completions', { method: 'POST', headers }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { sendEvent({ done: true }); resolve(); return; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta) {
              if (delta.reasoning_content) sendEvent({ reasoning: delta.reasoning_content });
              if (delta.content) sendEvent({ content: delta.content });
            }
          } catch (e) { /* partial chunk */ }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

// ---- conversations (JSON file) ----
function loadConversations() {
  try { return JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, 'utf8')); }
  catch (e) { return []; }
}
function saveConversations(list) {
  fs.writeFileSync(CONVERSATIONS_PATH, JSON.stringify(list, null, 2));
}

// ---- HTTP server ----
const STATIC = {
  '/': ['renderer/index.html', 'text/html'],
  '/style.css': ['renderer/style.css', 'text/css'],
  '/app.js': ['renderer/app.js', 'application/javascript'],
  '/mic-worklet.js': ['renderer/mic-worklet.js', 'application/javascript'],
  '/vendor/marked.min.js': ['renderer/vendor/marked.min.js', 'application/javascript'],
  '/vendor/katex.min.js': ['renderer/vendor/katex.min.js', 'application/javascript'],
  '/vendor/katex.min.css': ['renderer/vendor/katex.min.css', 'text/css']
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const { modelPath, messages, opts } = JSON.parse(body);
      const send = (ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n');
      try {
        // remote provider — chat-only, no local spawn
        const provider = (opts && opts.provider) || config.get().engines.text.provider || 'local';
        const remoteId = (opts && opts.remoteId) || config.get().engines.text.activeRemoteId || '';
        if (provider === 'remote' && remoteId) {
          const remote = getRemote(remoteId);
          if (!remote) throw new Error('remote not found: ' + remoteId);
          await remoteChatStream(remote, messages, opts || {}, send);
        } else {
          const engine = engines.text;
          if (!engine.isRunning()) await engine.start(modelPath, opts || {});
          await chatStream(engine, messages, opts || {}, send);
        }
      } catch (err) {
        send({ error: String(err) });
      }
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        let data = {};
        if (body) data = JSON.parse(body);
        const out = await api(p, data, url);
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && p.startsWith('/api/')) {
    try {
      const out = await api(p, {}, url);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (p.startsWith('/v1/')) { handleV1Proxy(req, res); return; }

  if (p.startsWith('/vendor/fonts/') && req.method === 'GET') {
    const fp = path.join(__dirname, 'renderer', p.slice(1));
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ct = p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.woff') ? 'font/woff' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }
  const stat = STATIC[p];
  if (stat && req.method === 'GET') {
    fs.readFile(path.join(__dirname, stat[0]), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': stat[1], 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// deep-merge plain objects (arrays/leaves replaced) — config/save must not clobber sibling keys
function mergeInto(base, patch) {
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      mergeInto(base[k], pv);
    } else {
      base[k] = pv;
    }
  }
}

// RX 580 (amdgpu) exposes VRAM + temp in sysfs — poll cheap (≈1.8ms a read)
const DRM_DIR = '/sys/class/drm';
function readGpuState() {
  try {
    const modes = fs.readdirSync(DRM_DIR).filter((n) => /^card\d+$/.test(n));
    for (const card of modes) {
      const dev = path.join(DRM_DIR, card, 'device');
      let total = NaN;
      try { total = parseInt(fs.readFileSync(path.join(dev, 'mem_info_vram_total'), 'utf8')); } catch (e) {}
      if (!Number.isFinite(total)) continue;
      let used = 0;
      try { used = parseInt(fs.readFileSync(path.join(dev, 'mem_info_vram_used'), 'utf8')); } catch (e) {}
      let tempCPrev = null;
      try {
        const hwmons = fs.readdirSync(path.join(dev, 'hwmon'));
        for (const h of hwmons) {
          const t = parseInt(fs.readFileSync(path.join(dev, 'hwmon', h, 'temp1_input'), 'utf8'));
          if (Number.isFinite(t)) { tempCPrev = t / 1000; break; }
        }
      } catch (e) {}
      return { vramUsed: used, vramTotal: total, tempC: tempCPrev };
    }
  } catch (e) {}
  return null;
}

async function api(p, data, url) {
  switch (p) {
    case '/api/config': return { body: config.get() };
    case '/api/pick-dir': {
      const opt = { title: 'Select model directory', properties: ['openDirectory', 'createDirectory'] };
      const win0 = BrowserWindow.getAllWindows()[0];
      const r = win0 ? await dialog.showOpenDialog(win0, opt) : await dialog.showOpenDialog(opt);
      return { body: r.canceled || !r.filePaths.length ? { dir: null } : { dir: r.filePaths[0] } };
    }
    case '/api/config/save': {
      mergeInto(config.get(), data);
      config.save();
      return { body: config.get() };
    }
    case '/api/sys/gpu': return { body: readGpuState() };
    case '/api/remotes': return { body: config.get().remotes || [] };
    case '/api/remotes/add': {
      const list = config.get().remotes || [];
      const { name, baseUrl, apiKey } = data;
      if (!name || !baseUrl) return { status: 400, body: { error: 'name and baseUrl required' } };
      const u = baseUrl.replace(/\/$/, '');
      let parsed; try { parsed = new URL(u); } catch (e) { return { status: 400, body: { error: 'invalid URL' } }; }
      const id = 'r' + Date.now().toString(36);
      list.push({ id, name: name.trim(), baseUrl: u, apiKey: (apiKey || '').trim() });
      config.get().remotes = list;
      config.save();
      return { body: list };
    }
    case '/api/remotes/remove': {
      config.get().remotes = (config.get().remotes || []).filter((r) => r.id !== data.id);
      if (config.get().engines.text.activeRemoteId === data.id) config.get().engines.text.activeRemoteId = '';
      config.save();
      return { body: config.get().remotes };
    }
    case '/api/remotes/set-active': {
      config.get().engines.text.activeRemoteId = data.id || '';
      config.get().engines.text.provider = data.provider || (data.id ? 'remote' : 'local');
      config.save();
      return { body: config.get() };
    }
    case '/api/remotes/test': {
      const r = getRemote(data.id) || { baseUrl: data.baseUrl, apiKey: data.apiKey || '' };
      if (!r.baseUrl) return { status: 400, body: { error: 'no baseUrl' } };
      const headers = {};
      if (r.apiKey) headers.Authorization = 'Bearer ' + r.apiKey;
      // try /v1/models then /health
      const testUrl = (r.baseUrl.replace(/\/$/, '') + '/v1/models');
      try {
        const j = await new Promise((resolve, reject) => {
          const u = new URL(testUrl);
          const req = (u.protocol === 'https:' ? https : http).get(u, { headers, timeout: 8000 }, (res) => {
            let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.slice(0, 200), status: res.statusCode }); } });
          });
          req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
        });
        const models = j.data || j.models || j;
        return { body: { ok: true, models: Array.isArray(models) ? models.slice(0, 20) : j } };
      } catch (e) { return { status: 500, body: { error: String(e) } }; }
    }
    case '/api/engines': {
      const base = Object.fromEntries(Object.entries(engines).map(([t, e]) => [t, e.status()]));
      // annotate text with remote info when provider is remote
      const cfg = config.get();
      if ((cfg.engines.text.provider || 'local') === 'remote' && cfg.engines.text.activeRemoteId) {
        const r = getRemote(cfg.engines.text.activeRemoteId);
        if (r) base.text = { ...base.text, provider: 'remote', remote: r.name, remoteUrl: r.baseUrl, running: true, model: r.name + ' (remote)' };
      } else {
        base.text.provider = 'local';
      }
      return { body: base };
    }
    case '/api/quit': app.quit(); return { body: true };
    case '/api/engine/start': {
      const engine = engines[data.type];
      if (!engine) return { status: 400, body: { error: 'unknown engine ' + data.type } };
      const harness = config.get().harness || {};
      const keepAlive = harness.keepAlive !== false && harness.enabled !== false;
      for (const t of ['text', 'image', 'video']) {
        if (t !== data.type && engines[t].isRunning()) {
          if (keepAlive && t === 'text' && (data.type === 'image' || data.type === 'video')) {
            broadcast({ type: 'engine:log', typeName: 'system', line: `keepAlive: keeping text harness alive (not stopping ${t})` });
            continue;
          }
          await engines[t].stop();
          broadcast({ type: 'engine:log', typeName: 'system', line: `stopped ${t} engine to free VRAM` });
        }
      }
      if (engine.isRunning()) await engine.stop();
      // remember harness model when starting text
      if (data.type === 'text' && data.modelPath) {
        const h = config.get().harness || {};
        h.model = data.modelPath;
        config.get().harness = h;
        config.save();
      }
      return { body: await engine.start(data.modelPath, data.opts || {}) };
    }
    case '/api/engine/stop': {
      await engines[data.type].stop();
      return { body: engines[data.type].status() };
    }
    case '/api/vision': {
      // modelPath, prompt, images[] (data URLs) -> {text}
      if (!data.modelPath) return { status: 400, body: { error: 'no modelPath' } };
      if (!(data.images || []).length) return { status: 400, body: { error: 'no images' } };
      const engine = engines.text;
      for (const t of ['text', 'image', 'video']) {
        if (t !== 'text' && engines[t].isRunning()) {
          await engines[t].stop();
          broadcast({ type: 'engine:log', typeName: 'system', line: `stopped ${t} engine to free VRAM` });
        }
      }
      if (engine.isRunning() && engine.model !== path.basename(data.modelPath)) await engine.stop();
      if (!engine.isRunning()) await engine.start(data.modelPath, { ctx: data.ctx || 8192 });
      const parts = (data.images || []).map((u) => ({ type: 'image_url', image_url: { url: u } }));
      if (data.prompt) parts.push({ type: 'text', text: data.prompt });
      const text = await engine.complete([{ role: 'user', content: parts }], { thinking: false, maxTokens: 1024 });
      return { body: { text } };
    }
    case '/api/models': return { body: models.list(config.get().modelDirs) };
    case '/api/models/delete': { await models.remove(data.path); return { body: true }; }
    case '/api/hf/search': return { body: await hf.search(url.searchParams.get('q') || '') };
    case '/api/hf/files': return { body: await hf.listFiles(url.searchParams.get('repo') || '') };
    case '/api/hf/download': {
      const id = `${data.repo}/${data.file}`;
      const prev = downloads.get(id);
      if (prev) { prev.abort(); downloads.delete(id); } // stale/aborted entry — restart fresh
      const dl = new hf.Download(data.repo, data.file, data.destDir);
      downloads.set(id, dl);
      dl.on('progress', (p2) => broadcast({ type: 'dl:progress', id, ...p2 }));
      dl.on('done', (d) => { downloads.delete(id); broadcast({ type: 'dl:done', id, ...d }); });
      dl.on('error', () => downloads.delete(id));
      dl.start().catch((err) => { downloads.delete(id); broadcast({ type: 'dl:error', id, error: String(err) }); });
      return { body: { id } };
    }
    case '/api/hf/abort': {
      const dl = downloads.get(data.id);
      if (dl) dl.abort();
      return { body: true };
    }
    case '/api/harness/set': {
      const h = config.get().harness || {};
      if (data.keepAlive !== undefined) h.keepAlive = !!data.keepAlive;
      if (data.model !== undefined) h.model = data.model || '';
      if (data.enabled !== undefined) h.enabled = !!data.enabled;
      config.get().harness = h;
      config.save();
      return { body: h };
    }
    case '/api/harness/get': return { body: config.get().harness || { enabled: true, keepAlive: true, model: '' } };
    case '/api/server/set': return { body: await setServer(data) };
    case '/api/images/generate': return { body: await engines.image.generate(data.prompt, data.opts || {}) };
    case '/api/images/img2img': return { body: await engines.image.generateImg2Img(data.prompt, data.opts || {}) };
    case '/api/video/generate': return { body: await engines.video.generateVideo(data.prompt, data.opts || {}) };
    case '/api/audio/voices': return { body: await getJson(engines.audio.baseUrl + '/audio/voices') };
    case '/api/audio/tts': return { body: await postJson(engines.audio.baseUrl + '/audio/tts', { text: data.text, voice: data.voice, speed: data.speed, format: data.format, model: data.model, lang: data.lang, instr: data.instr || '' }) };
    case '/api/audio/clone': return { body: await postJson(engines.audio.baseUrl + '/audio/clone', { audioB64: data.audioB64, name: data.name, transcript: data.transcript }) };
    case '/api/audio/delete-clone': return { body: await postJson(engines.audio.baseUrl + '/audio/delete-clone', { name: data.name }) };
    case '/api/audio/transcribe': return { body: await transcribe(data) };
    case '/api/conversations': return { body: loadConversations() };
    case '/api/conversations/save': {
      const list = loadConversations();
      const i = list.findIndex((c) => c.id === data.id);
      if (i >= 0) list[i] = data;
      else list.unshift(data);
      saveConversations(list);
      return { body: true };
    }
    case '/api/conversations/delete': {
      saveConversations(loadConversations().filter((c) => c.id !== data.id));
      return { body: true };
    }
  }
  return { status: 404, body: { error: 'no route ' + p } };
}

async function setServer({ enabled, apiKey, modelPath }) {
  const cfg = config.get();
  cfg.server = { enabled: !!enabled, apiKey: enabled ? (apiKey||'') : '' };
  // UI harness proxy is always at 9090/v1; this flag controls LAN (0.0.0.0) vs local (127.0.0.1)
  // rebind UI server if host changed
  const wantHost = enabled ? '0.0.0.0' : '127.0.0.1';
  const curHost = server.listening ? server.address().address : null;
  if (curHost && curHost !== wantHost) {
    await new Promise(res=> server.close(res));
    await new Promise(res=> server.listen(UI_PORT, wantHost, res));
    console.log(`UI server rebound to ${wantHost}:${UI_PORT}`);
  }
  // keep llama-server on 127.0.0.1 always (single-port design); apiKey for harness proxy if needed
  const t = cfg.engines.text;
  if (enabled && apiKey) t.apiKey = apiKey;
  else delete t.apiKey;
  config.save();
  // no need to restart text engine for single-port design
  return { enabled: !!enabled, url: `http://${enabled ? lanIP() : '127.0.0.1'}:${UI_PORT}/v1`, localUrl: `http://127.0.0.1:${UI_PORT}/v1`, lanUrl: `http://${lanIP()}:${UI_PORT}/v1`, error: null };
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  const host = (config.get().server && config.get().server.enabled) ? '0.0.0.0' : '127.0.0.1';
  server.listen(UI_PORT, host, () => console.log(`PolarisStudio UI+harness on http://${host}:${UI_PORT} (harness: /v1, vision: /api/vision)`));
  createWindow();
  if (process.env.POLARIS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.POLARIS_SHOT, img.toPNG());
        app.quit();
      }, 3000);
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  for (const e of Object.values(engines)) e.stop();
  for (const dl of downloads.values()) dl.abort();
  server.close();
});

app.on('window-all-closed', () => {
  // closing the window keeps the server + downloads + engines alive (headless);
  // relaunch the app (or click in the UI) to get the window back
  if (process.platform !== 'darwin') console.log('window closed — server keeps running headless');
});
