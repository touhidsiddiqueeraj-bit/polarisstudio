const { spawn, exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

function getJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// strip quant/suffix noise (q4_k_m, q8_0, f16, -instruct/-it/-chat) so
// projector and model names compare on their family tokens
function mmNameNorm(name) {
  return name.toLowerCase()
    .replace(/[-_.]q[0-9][a-z0-9_]*$/, '')
    .replace(/[-_.](f16|bf16|fp16)$/, '')
    .replace(/-(instruct|chat|it|base)$/, '');
}

function mmprojFor(modelPath) {
  try {
    const dir = path.dirname(modelPath);
    const base = mmNameNorm(path.basename(modelPath, '.gguf'));
    let best = null;
    for (const f of fs.readdirSync(dir)) {
      const name = f.toLowerCase();
      if (!name.includes('mmproj') || !name.endsWith('.gguf')) continue;
      // only attach a projector that is actually for this model
      if (!mmNameNorm(name).includes(base)) continue;
      best = path.join(dir, f);
    }
    return best;
  } catch (e) { return null; }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('bad response: ' + out.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class Engine {
  constructor(type, cfg, onLog) {
    this.type = type;
    this.cfg = cfg;
    this.onLog = onLog || (() => {});
    this.proc = null;
    this.model = null;
    this.lastLines = [];
    this.startTimeout = 180000;
    this.healthPath = type === 'text' ? '/health' : type === 'audio' ? '/audio/health' : '/sdapi/v1/options';
    if (type === 'audio') this.startTimeout = 60000;
  }

  get port() { return this.cfg.port; }
  get baseUrl() { return `http://127.0.0.1:${this.port}`; }

  isRunning() {
    return this.proc && this.proc.exitCode === null;
  }

  status() {
    return {
      type: this.type,
      running: this.isRunning(),
      port: this.port,
      model: this.model
    };
  }

  argsFor(modelPath, opts) {
    if (this.type === 'audio') return [this.cfg.script, '--port', String(this.port)];
    const a = ['-m', modelPath];
    if (this.type === 'text') {
      a.push('--port', String(this.port), '--host', this.cfg.host || '127.0.0.1');
      if (this.cfg.apiKey) a.push('--api-key', this.cfg.apiKey);
      a.push('-c', String(opts.ctx || this.cfg.ctx || 8192));
      a.push('-ngl', String(this.cfg.ngl ?? 99));
      if (this.cfg.mmproj && fs.existsSync(this.cfg.mmproj)) a.push('--mmproj', this.cfg.mmproj);
      else { // auto-discover a vision/audio projector next to the model
        const proj = mmprojFor(modelPath);
        if (proj) a.push('--mmproj', proj);
      }
      const moe = opts.nCpuMoe ?? this.cfg.nCpuMoe ?? 0;
      if (moe > 0) a.push('--n-cpu-moe', String(moe));
      if (opts.noMmap ?? this.cfg.noMmap) a.push('--no-mmap');
      if (opts.mlock ?? this.cfg.mlock) a.push('--mlock');
      if (opts.directIo ?? this.cfg.directIo) a.push('--direct-io');
      let kv = (opts.cacheTypeK ?? this.cfg.cacheTypeK ?? 'f16').toLowerCase();
      let kvV = (opts.cacheTypeV ?? this.cfg.cacheTypeV ?? kv).toLowerCase();
      if (kv !== 'f16') a.push('--cache-type-k', kv, '--cache-type-v', kvV);
      if (this.cfg.extraArgs) a.push(...this.cfg.extraArgs);
      a.push('--no-webui');
    } else {
      a.push('--listen-port', String(this.port), '--listen-ip', '127.0.0.1');
      a.push('--backend', this.cfg.backend);
      if (this.type === 'video') {
        if (this.cfg.motionModule) a.push('--motion-module', this.cfg.motionModule);
        a.push('--video-frames', String(opts.frames || 16));
        a.push('--fps', String(opts.fps || 8));
      }
      if (this.cfg.extraArgs) a.push(...this.cfg.extraArgs);
    }
    return a;
  }

  async start(modelPath, opts = {}) {
    if (this.isRunning()) throw new Error(`${this.type} engine already running`);
    const bin = this.cfg.binary;
    if (this.type === 'audio') {
      this.model = 'Kokoro + XTTS-v2';
    } else {
      if (!fs.existsSync(bin)) throw new Error(`binary missing: ${bin}`);
      if (!fs.existsSync(modelPath)) throw new Error(`model missing: ${modelPath}`);
      this.model = path.basename(modelPath);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this._spawn(modelPath, opts)) {
        if (this.type === 'text') this._logStartupOpts(opts);
        return this.status();
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${this.type} engine failed to start:\n${this.lastLines.slice(-15).join('')}`);
  }

  // one-line summary of non-default low-VRAM/MoE flags actually in effect
  _logStartupOpts(opts) {
    const parts = [];
    const moe = opts.nCpuMoe ?? this.cfg.nCpuMoe ?? 0;
    if (moe > 0) parts.push(`MoE offload: ${moe}`);
    if (opts.noMmap ?? this.cfg.noMmap) parts.push('no-mmap: on');
    if (opts.mlock ?? this.cfg.mlock) parts.push('mlock: on');
    if (opts.directIo ?? this.cfg.directIo) parts.push('direct-io: on');
    const kv = (opts.cacheTypeK ?? this.cfg.cacheTypeK ?? 'f16').toLowerCase();
    if (kv !== 'f16') parts.push(`KV cache: ${kv}`);
    if (parts.length) this.onLog('text', `low-VRAM opts: ${parts.join(' | ')}\n`);
  }

  _spawn(modelPath, opts) {
    return new Promise((resolve) => {
      const proc = spawn(this.cfg.binary, this.argsFor(modelPath, opts), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(this.cfg.spawnEnv || {}) } });
      this.proc = proc;
      this.lastLines = [];
      const log = (t) => { this.lastLines.push(t); this.onLog(this.type, t); };
      proc.stdout.on('data', (d) => log(d.toString()));
      proc.stderr.on('data', (d) => log(d.toString()));
      proc.on('exit', (code) => {
        log(`engine exited (${code})`);
        if (this.proc === proc) { this.proc = null; this.model = null; }
        const blocked = this.lastLines.join('').match(/couldn't bind|address already in use|bind.*fail/i);
        if (blocked) {
          // stale server (orphan from a killed app, or previous run) holds our port — take it down, caller retries
          log(`port ${this.port} held by another process — killing it`);
          exec(`fuser -k ${this.port}/tcp`, () => {});
        }
        resolve(false);
      });
      const url = this.baseUrl + this.healthPath;
      const start = Date.now();
      const tick = () => {
        if (this.proc !== proc) return; // exited; resolve(false) already fired
        http.get(url, (res) => {
          res.resume();
          // llama-server answers 503 "Loading model" while the model is still
          // loading — only a 2xx means requests will actually be served
          if (res.statusCode === 200) resolve(true);
          else if (Date.now() - start > this.startTimeout) resolve(false);
          else setTimeout(tick, 500);
        }).on('error', () => {
          if (Date.now() - start > this.startTimeout) resolve(false);
          else setTimeout(tick, 500);
        });
      };
      tick();
    });
  }

  async stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null) { this.proc = null; this.model = null; return; }
    this.proc = null;
    this.model = null;
    const killer = setTimeout(() => p.kill('SIGKILL'), 8000);
    await new Promise((resolve) => {
      p.once('exit', () => { clearTimeout(killer); resolve(); });
      if (p.exitCode !== null) { clearTimeout(killer); resolve(); return; }
      p.kill('SIGTERM');
    });
  }

  // non-streaming chat; returns full text (used by /api/vision).
  // Retries while llama-server is still loading the model (rare race after
  // health flips to 200).
  async complete(messages, opts = {}) {
    const deadline = Date.now() + (opts.loadTimeoutMs ?? 60000);
    for (;;) {
      try {
        return await this._completeOnce(messages, opts);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/loading model/i.test(msg) || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  _completeOnce(messages, opts) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ messages, stream: false, temperature: opts.temp ?? 0.2, max_tokens: opts.maxTokens ?? 1024, chat_template_kwargs: { enable_thinking: opts.thinking === true } });
      const req = http.request(this.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(out);
            if (j.error) return reject(new Error(j.error.message || j.error));
            const c = j.choices && j.choices[0];
            resolve((c && c.message && c.message.content) || '');
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // text
  chat(messages, opts) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ messages, stream: true, temperature: opts.temp ?? 0.7, max_tokens: opts.maxTokens ?? 2048 });
      const req = http.request(this.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
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
            if (payload === '[DONE]') { resolve(); return; }
            try {
              const j = JSON.parse(payload);
              const delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta && (delta.content || delta.reasoning_content)) this.onLog('text', JSON.stringify(delta));
            } catch (e) { /* partial json */ }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // image
  generate(prompt, opts) {
    const payload = {
      prompt,
      width: opts.width || 512,
      height: opts.height || 512,
      steps: opts.steps || 4,
      seed: opts.seed ?? -1,
      cfg_scale: opts.cfgScale ?? 1.0,
      batch_size: opts.batch || 1,
      sampler_name: opts.samplerName || 'lcm',
      scheduler: opts.scheduler || 'simple',
      negative_prompt: opts.negativePrompt || ''
    };
    if (opts.clipSkip && opts.clipSkip > 0) payload.clip_skip = opts.clipSkip;
    if (opts.upscale) payload.upscaler = { upscaler: 'RealESRGAN_x4plus', scale: 4 };
    return postJson(this.baseUrl + '/sdapi/v1/txt2img', payload);
  }

  // img2img
  generateImg2Img(prompt, opts) {
    const payload = {
      prompt,
      width: opts.width || 512,
      height: opts.height || 512,
      steps: opts.steps || 4,
      seed: opts.seed ?? -1,
      cfg_scale: opts.cfgScale ?? 1.0,
      sampler_name: opts.samplerName || 'lcm',
      scheduler: opts.scheduler || 'simple',
      negative_prompt: opts.negativePrompt || '',
      init_images: [opts.initImage],
      denoising_strength: opts.denoise ?? 0.6
    };
    return postJson(this.baseUrl + '/sdapi/v1/img2img', payload);
  }

  // video (async job API)
  async generateVideo(prompt, opts) {
    const width = opts.width || 384;
    const height = opts.height || 384;
    const frames = opts.frames || 8;
    const px = width * height * frames;
    if (px > 1700000) throw new Error(`too big for 8GB VRAM: ${width}x${height}x${frames} = ${(px / 1e6).toFixed(1)}M px·frames — keep under ~1.7M (e.g. 384x384x8)`);
    const payload = {
      prompt,
      width,
      height,
      seed: opts.seed ?? -1,
      video_frames: frames,
      fps: opts.fps || 8,
      output_format: 'webm',
      sample_params: { sample_method: opts.samplerName || 'lcm', scheduler: opts.scheduler || 'simple', sample_steps: opts.steps || 4, guidance: { txt_cfg: opts.cfgScale ?? 1.0 } }
    };
    const { poll_url } = await postJson(this.baseUrl + '/sdcpp/v1/vid_gen', payload);
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = await getJson(this.baseUrl + poll_url);
      if (j.status === 'completed') return j.result;
      if (j.status === 'failed' || j.status === 'cancelled') {
        throw new Error((j.error && j.error.message) || 'video job failed');
      }
    }
    throw new Error('video generation timed out');
  }

  options() {
    return getJson(this.baseUrl + '/sdapi/v1/options');
  }
}

module.exports = { Engine, getJson, postJson };
