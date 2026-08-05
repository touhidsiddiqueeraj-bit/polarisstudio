const fs = require('fs');
const path = require('path');

// classify a gguf by name so the UI can sort models into Text/Image/Video
function classify(name, dir) {
  const n = name.toLowerCase();
  if (/whisper|ggml-|qwen3-tts|qwen-talker|qwen-tokenizer/.test(n)) return 'audio';
  if (/wan|hunyuan|animatediff|motion|mm_sd|ltx|mochi/.test(n)) return 'video';
  if (/upscaler|esrgan|vae|text-encoder|umt5|clip/.test(n)) return 'aux';
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
    } else if (f.endsWith('.gguf') || f.endsWith('.safetensors')) {
      out.push({ name: f, path: full, dir, size: st.size, type: classify(f, dir) });
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

module.exports = { list, remove, classify };
