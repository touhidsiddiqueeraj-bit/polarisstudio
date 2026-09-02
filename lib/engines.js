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

// FLUX.2-klein is shipped as diffusion-only GGUF (~2.5GB, 149 tensors).
// sd-server expects it via --diffusion-model + --vae + --llm, NOT via -m.
// Detect that case by filename (robust without GGUF parsing) and patch args.
function isFluxKleinDiffusionOnly(name) {
  return /flux[._-]?2.*klein/i.test(name) || /flux-2-klein/i.test(name.toLowerCase());
}
function isFluxKleinPath(p) { return p && isFluxKleinDiffusionOnly(path.basename(p)); }
function findFileRecursive(dirs, predicate) {
  for (const d of dirs || []) {
    try {
      const stack = [d];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) {
            if (ent.name.startsWith('.') || /^(animatediff|wan_models|venv)$/.test(ent.name)) continue;
            stack.push(full);
          } else if (predicate(ent.name, full)) {
            return full;
          }
        }
      }
    } catch (e) {}
  }
  return null;
}
function resolveFluxKleinDeps(modelPath, cfg) {
  // explicit paths win
  let vae = cfg.vae || cfg.fluxVae || null;
  let llm = cfg.llm || cfg.fluxLlm || null;
  if (vae && !fs.existsSync(vae)) vae = null;
  if (llm && !fs.existsSync(llm)) llm = null;
  // auto-discover in configured modelDirs + alongside the diffusion model
  let modelDirs = cfg.modelDirs || [];
  if (!modelDirs.length) {
    try {
      // avoid requiring electron's config module in bare node tests — read file directly
      const cfgPath = require('path').join(__dirname, '..', 'config.json');
      const j = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
      modelDirs = j.modelDirs || [];
    } catch (e) {}
  }
  const searchDirs = [...modelDirs, path.dirname(modelPath)];
  const uniqDirs = [...new Set(searchDirs.filter(Boolean))];
  if (!vae) {
    vae = findFileRecursive(uniqDirs, (n) => /flux2.*(ae|vae)|flux.*ae/i.test(n) && n.endsWith('.safetensors'));
    if (!vae) vae = findFileRecursive(uniqDirs, (n) => /flux2.*(ae|vae)/i.test(n.toLowerCase()) && n.endsWith('.safetensors'));
  }
  if (!llm) {
    // qwen3 4B for klein-4B, 8B for 9B — accept either; also mistral for flux2-dev
    llm = findFileRecursive(uniqDirs, (n) => /qwen.*3.*4b|qwen.*4b.*flux|mistral.*small/i.test(n.toLowerCase()) && (n.endsWith('.gguf') || n.endsWith('.safetensors')));
  }
  return { vae, llm };
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
    // FLUX.2-klein diffusion-only GGUF: route via --diffusion-model + --vae + --llm
    const fluxKlein = (this.type === 'image' || this.type === 'video') && modelPath && isFluxKleinDiffusionOnly(path.basename(modelPath));
    if (fluxKlein) {
      const a = [];
      // stash dep resolution for start() validation / logging
      const deps = resolveFluxKleinDeps(modelPath, { ...this.cfg, modelDirs: this.cfg.modelDirs || [] });
      this._fluxKleinDeps = deps;
      a.push('--diffusion-model', modelPath);
      if (deps.vae) a.push('--vae', deps.vae);
      if (deps.llm) a.push('--llm', deps.llm);
      // common FLUX.2-klein flags for 8GB Vulkan (ponytail: minimal, no extra VRAM without them)
      // Caller can override via extraArgs; we add sensible defaults only if not already present
      const extra = Array.isArray(this.cfg.extraArgs) ? this.cfg.extraArgs.join(' ') : String(this.cfg.extraArgs || '');
      if (!extra.includes('--diffusion-fa')) a.push('--diffusion-fa');
      a.push('--listen-port', String(this.port), '--listen-ip', '127.0.0.1');
      a.push('--backend', this.cfg.backend);
      if (this.type === 'video') {
        if (this.cfg.motionModule) a.push('--motion-module', this.cfg.motionModule);
        a.push('--video-frames', String(opts.frames || 16));
        a.push('--fps', String(opts.fps || 8));
      }
      if (this.cfg.extraArgs) {
        if (Array.isArray(this.cfg.extraArgs)) a.push(...this.cfg.extraArgs);
        else if (typeof this.cfg.extraArgs === 'string' && this.cfg.extraArgs.trim()) a.push(...this.cfg.extraArgs.trim().split(/\s+/));
      }
      return a;
    }
    const a = ['-m', modelPath];
    if (this.type === 'text') {
      a.push('--port', String(this.port), '--host', this.cfg.host || '127.0.0.1');
      if (this.cfg.apiKey) a.push('--api-key', this.cfg.apiKey);
      a.push('-c', String(opts.ctx || this.cfg.ctx || 8192));
      a.push('-ngl', String(opts.ngl ?? this.cfg.ngl ?? 99));
      // ponytail: perf knobs — all optional, defaults keep current behavior
      const thr = opts.threads ?? this.cfg.threads;
      if (Number.isFinite(thr) && thr > 0) a.push('-t', String(thr));
      const thrB = opts.threadsBatch ?? this.cfg.threadsBatch;
      if (Number.isFinite(thrB) && thrB > 0) a.push('-tb', String(thrB));
      const bsz = opts.batchSize ?? this.cfg.batchSize;
      if (Number.isFinite(bsz) && bsz > 0) a.push('-b', String(bsz));
      const ub = opts.ubatchSize ?? this.cfg.ubatchSize;
      if (Number.isFinite(ub) && ub > 0) a.push('-ub', String(ub));
      const fa = opts.flashAttn ?? this.cfg.flashAttn;
      if (fa === 'on' || fa === 'off' || fa === 'auto') a.push('-fa', fa);
      const par = opts.parallel ?? this.cfg.parallel;
      if (Number.isFinite(par) && par > 0) a.push('-np', String(par));
      if ((opts.contBatching ?? this.cfg.contBatching) === false) a.push('--no-cont-batching');
      else if ((opts.contBatching ?? this.cfg.contBatching) === true) a.push('--cont-batching');
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
      // sampling defaults — ponytail: emit only when non-default so logs stay clean
      const topP = opts.topP ?? this.cfg.topP;
      if (Number.isFinite(topP) && topP >= 0 && topP <= 1 && topP !== 0.95) a.push('--top-p', String(topP));
      const topK = opts.topK ?? this.cfg.topK;
      if (Number.isFinite(topK) && topK >= 0 && topK !== 40) a.push('--top-k', String(topK));
      const minP = opts.minP ?? this.cfg.minP;
      if (Number.isFinite(minP) && minP >= 0 && minP <= 1 && minP !== 0.05) a.push('--min-p', String(minP));
      const rep = opts.repeatPenalty ?? this.cfg.repeatPenalty;
      if (Number.isFinite(rep) && rep !== 1.1) a.push('--repeat-penalty', String(rep));
      // speculative: self-MTP (Qwen3 nextn) or separate draft model
      // ponytail: 3 nullable knobs, one gate, emitted only when enabled
      const selfMtp = opts.selfMtp ?? this.cfg.selfMtp;
      const dModel = (opts.draftModel ?? this.cfg.draftModel ?? '').trim();
      const dMin = opts.draftMin ?? this.cfg.draftMin;
      const dMax = opts.draftMax ?? this.cfg.draftMax;
      const dPMin = opts.draftPMin ?? this.cfg.draftPMin;
      if (selfMtp || dModel) {
        if (dModel) a.push('--model-draft', dModel);
        // use MTP type for self, draft-simple for external
        a.push('--spec-type', selfMtp && !dModel ? 'draft-mtp' : 'draft-simple');
        if (Number.isFinite(dMax) && dMax > 0) a.push('--spec-draft-n-max', String(dMax));
        if (Number.isFinite(dMin) && dMin >= 0) a.push('--spec-draft-n-min', String(dMin));
        if (Number.isFinite(dPMin)) a.push('--spec-draft-p-min', String(dPMin));
      }
      if (this.cfg.extraArgs) {
        if (Array.isArray(this.cfg.extraArgs)) a.push(...this.cfg.extraArgs);
        else if (typeof this.cfg.extraArgs === 'string' && this.cfg.extraArgs.trim()) a.push(...this.cfg.extraArgs.trim().split(/\s+/));
      }
      a.push('--no-webui');
    } else {
      a.push('--listen-port', String(this.port), '--listen-ip', '127.0.0.1');
      a.push('--backend', this.cfg.backend);
      if (this.type === 'video') {
        if (this.cfg.motionModule) a.push('--motion-module', this.cfg.motionModule);
        a.push('--video-frames', String(opts.frames || 16));
        a.push('--fps', String(opts.fps || 8));
      }
      if (this.cfg.extraArgs) {
        if (Array.isArray(this.cfg.extraArgs)) a.push(...this.cfg.extraArgs);
        else if (typeof this.cfg.extraArgs === 'string' && this.cfg.extraArgs.trim()) a.push(...this.cfg.extraArgs.trim().split(/\s+/));
      }
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
      // flux klein diffusion-only needs companion files — fail fast with actionable message
      if ((this.type === 'image' || this.type === 'video') && modelPath && isFluxKleinDiffusionOnly(path.basename(modelPath))) {
        const deps = resolveFluxKleinDeps(modelPath, { ...this.cfg, modelDirs: this.cfg.modelDirs || [] });
        const missing = [];
        if (!deps.vae) missing.push('VAE (flux2_ae.safetensors from https://huggingface.co/black-forest-labs/FLUX.2-dev/tree/main  → ae.safetensors)');
        if (!deps.llm) missing.push('text encoder LLM (Qwen3-4B-GGUF from https://huggingface.co/unsloth/Qwen3-4B-GGUF  or safetensors from https://huggingface.co/Comfy-Org/flux2-klein-4B/tree/main/split_files/text_encoders)');
        if (missing.length) {
          let dirsHint = '';
          try { dirsHint = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf8')).modelDirs.join(', '); } catch (e) { dirsHint = '/mnt/backup/llm-models, ~/stable-diffusion.cpp/models'; }
          throw new Error(
            `FLUX.2-klein is a diffusion-only model — your 2.5 GB GGUF is just the transformer, not a standalone image model.\n` +
            `Missing: ${missing.join(' + ')}\n` +
            `Fix: download the missing file(s) into one of your modelDirs (${dirsHint}) or set engines.image.vae / engines.image.llm in config.json.\n` +
            `Then restart the image engine. Example working command (see stable-diffusion.cpp/docs/flux2.md):\n` +
            `  sd-server --diffusion-model "${modelPath}" --vae <flux2_ae.safetensors> --llm <qwen3_4b.gguf> --diffusion-fa --backend diffusion=vulkan0,clip=vulkan0,vae=vulkan0\n` +
            `Your LCM_Dreamshaper still works via -m (it is a full single-file model).`
          );
        }
      }
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
    // perf
    const thr = this.cfg.threads, thrB = this.cfg.threadsBatch, b = this.cfg.batchSize, ub = this.cfg.ubatchSize, fa = this.cfg.flashAttn, par = this.cfg.parallel;
    if (thr || thrB || b || ub || fa) parts.push(`perf: t${thr ?? 4}/tb${thrB ?? 4} b${b ?? 2048}/ub${ub ?? 512} fa:${fa ?? 'on'} par:${par ?? 1}`);
    const ngl = this.cfg.ngl;
    if (Number.isFinite(ngl) && ngl !== 99) parts.push(`ngl: ${ngl}`);
    const topP = this.cfg.topP, topK = this.cfg.topK, minP = this.cfg.minP, rep = this.cfg.repeatPenalty;
    const samp = [];
    if (Number.isFinite(topP) && topP !== 0.95) samp.push(`top_p ${topP}`);
    if (Number.isFinite(topK) && topK !== 40) samp.push(`top_k ${topK}`);
    if (Number.isFinite(minP) && minP !== 0.05) samp.push(`min_p ${minP}`);
    if (Number.isFinite(rep) && rep !== 1.1) samp.push(`rep ${rep}`);
    if (samp.length) parts.push(`sampling: ${samp.join(' ')}`);
    const dModel = (this.cfg.draftModel || '').trim();
    if (this.cfg.selfMtp) parts.push(`spec: MTP n-max ${this.cfg.draftMax ?? 3}`);
    else if (dModel) parts.push(`spec: draft ${dModel.split('/').pop()} n-max ${this.cfg.draftMax ?? 3}`);
    if (parts.length) this.onLog('text', `opts: ${parts.join(' | ')}\n`);
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

module.exports = { Engine, getJson, postJson, isFluxKleinPath, isFluxKleinDiffusionOnly, resolveFluxKleinDeps };
