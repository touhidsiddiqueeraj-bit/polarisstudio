const fs = require('fs');
const path = require('path');

// MoE detection by filename only (no gguf parsing): A\d+B active-expert
// naming (Qwen3 A3B, Gemma 4 26B-A4B...), plus common MoE series. Gemma 4
// "E2B/E4B" are edge-dense, not experts — deliberately not matched.
function isMoeName(name) {
  const n = name.toLowerCase();
  return /a\d+b|moe|mixtral|deepseek|grok|\d+x\d+b|\d+e\b/.test(n);
}

// classify a gguf by name so the UI can sort models into Text/Image/Video
function classify(name, dir) {
  const n = name.toLowerCase();
  if (/whisper|ggml-|qwen3-tts|qwen-talker|qwen-tokenizer/.test(n)) return 'audio';
  if (/wan|hunyuan|animatediff|motion|mm_sd|ltx|mochi/.test(n)) return 'video';
  if (/mmproj|upscaler|esrgan|vae|text-encoder|umt5|clip/.test(n)) return 'aux';
  if (/dreamshaper|sdxl|flux|schnell|pixart|stable|turbo|realistic|lcm|playground|pony|juggernaut/.test(n)) return 'image';
  return 'text';
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (/^(animatediff|wan_models|gui|venv|\.)/.test(f)) continue;
      out.push(...scanDir(full));
    } else if (f.endsWith('.gguf') || f.endsWith('.safetensors') || f.endsWith('.bin')) {
      out.push({ name: f, path: full, dir, size: st.size, type: classify(f, dir), moe: isMoeName(f) });
    }
  }
  return out;
}

function list(modelDirs) {
  const models = modelDirs.flatMap((d) => scanDir(d));
  models.sort((a, b) => (a.name < b.name ? -1 : 1));
  return models;
}

function remove(modelPath) {
  return fs.promises.rm(modelPath, { force: true });
}

module.exports = { list, remove, classify, isMoeName };
