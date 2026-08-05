const { app, BrowserWindow, dialog } = require('electron');
const http = require('http');
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
      AUDIO_VOICES_DIR: path.join(config.DATA_DIR, 'voices')
    };
  }
  engines[type] = new Engine(type, cfg, (t, line) => broadcast({ type: 'engine:log', typeName: t, line }));
}

const downloads = new Map(); // id -> Download

function transcribe(data) {
  return new Promise((resolve, reject) => {
    const bin = config.get().engines.stt.binary;
    if (!bin || !fs.existsSync(bin)) return reject(new Error(`stt binary missing: ${bin}`));
    const tmp = path.join(os.tmpdir(), `polaris-stt-${Date.now()}`);
    const wav = tmp + '.wav';
    fs.writeFileSync(wav, Buffer.from(data.audioB64, 'base64'));
    const args = ['-m', data.model, '-f', wav, '-nt', '-np', '-l', data.language || 'auto', '-otxt', '-of', tmp];
    const { spawn } = require('child_process');
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      fs.unlinkSync(wav);
      if (code !== 0) return reject(new Error(`whisper-cli exited ${code}: ${err.slice(0, 300)}`));
      let text = '';
      try { text = fs.readFileSync(tmp + '.txt', 'utf8'); } catch (e) { /* fall through */ }
      try { fs.unlinkSync(tmp + '.txt'); } catch (e) { /* ignore */ }
      resolve({ text: text.trim() });
    });
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
  // renderer crash (GPU/GL issue on old cards) must not take the whole app down
  win.webContents.on('render-process-gone', () => {
    console.log('renderer crashed — recreating window, server stays up');
    setTimeout(() => { if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow(); }, 1500);
  });
}

// ---- chat streaming (SSE to the HTTP client) ----
function chatStream(engine, messages, opts, sendEvent) {
  return new Promise((resolve, reject) => {
    const body = { messages, stream: true, temperature: opts.temp ?? 0.7, max_tokens: opts.maxTokens ?? 2048, repeat_penalty: opts.repeatPenalty ?? 1.1 };
    if (opts.thinking !== undefined) body.chat_template_kwargs = { enable_thinking: !!opts.thinking };
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
  '/vendor/marked.min.js': ['renderer/vendor/marked.min.js', 'application/javascript']
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
      const engine = engines.text;
      const send = (ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n');
      try {
        if (!engine.isRunning()) await engine.start(modelPath, opts || {});
        await chatStream(engine, messages, opts || {}, send);
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
      Object.assign(config.get(), data);
      config.save();
      return { body: config.get() };
    }
    case '/api/engines': return { body: Object.fromEntries(Object.entries(engines).map(([t, e]) => [t, e.status()])) };
    case '/api/quit': app.quit(); return { body: true };
    case '/api/engine/start': {
      const engine = engines[data.type];
      if (!engine) return { status: 400, body: { error: 'unknown engine ' + data.type } };
      for (const t of ['text', 'image', 'video']) {
        if (t !== data.type && engines[t].isRunning()) {
          await engines[t].stop();
          broadcast({ type: 'engine:log', typeName: 'system', line: `stopped ${t} engine to free VRAM` });
        }
      }
      if (engine.isRunning()) await engine.stop();
      return { body: await engine.start(data.modelPath, data.opts || {}) };
    }
    case '/api/engine/stop': {
      await engines[data.type].stop();
      return { body: engines[data.type].status() };
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
    case '/api/server/set': return { body: await setServer(data) };
    case '/api/images/generate': return { body: await engines.image.generate(data.prompt, data.opts || {}) };
    case '/api/images/img2img': return { body: await engines.image.generateImg2Img(data.prompt, data.opts || {}) };
    case '/api/video/generate': return { body: await engines.video.generateVideo(data.prompt, data.opts || {}) };
    case '/api/audio/voices': return { body: await getJson(engines.audio.baseUrl + '/audio/voices') };
    case '/api/audio/tts': return { body: await postJson(engines.audio.baseUrl + '/audio/tts', { text: data.text, voice: data.voice, speed: data.speed, format: data.format }) };
    case '/api/audio/clone': return { body: await postJson(engines.audio.baseUrl + '/audio/clone', { audioB64: data.audioB64, name: data.name }) };
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
  const t = cfg.engines.text;
  t.host = enabled ? '0.0.0.0' : '127.0.0.1';
  if (enabled && apiKey) t.apiKey = apiKey;
  else delete t.apiKey;
  cfg.server = { enabled, apiKey: enabled ? apiKey : '' };
  config.save();
  let error = null;
  if (engines.text.isRunning()) {
    if (!modelPath) {
      error = 'engine running — stop it, then Apply to rebind';
    } else {
      await engines.text.stop();
      try { await engines.text.start(modelPath, { ctx: t.ctx }); }
      catch (err) { error = String(err); }
    }
  }
  return { enabled, url: enabled ? `http://${lanIP()}:${t.port}/v1` : null, error };
}

app.whenReady().then(() => {
  // relaunching the app while a server is already up just opens a window
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  server.listen(UI_PORT, '127.0.0.1', () => console.log(`PolarisStudio UI on http://127.0.0.1:${UI_PORT}`));
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
