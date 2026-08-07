const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// packaged apps resolve __dirname inside app.asar, which is not writable —
// data files must live in a real directory (userData when packaged)
const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

if (app.isPackaged && !fs.existsSync(CONFIG_PATH)) {
  // pre-fix packaged builds read (and shipped) config.json inside the asar;
  // seed the writable data dir once from that snapshot so user settings survive
  try { fs.copyFileSync(path.join(__dirname, '..', 'config.json'), CONFIG_PATH); } catch (e) { /* no legacy config */ }
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  config = { modelDirs: [], engines: {} };
}

const home = require('os').homedir();
const defaults = {
  modelDirs: [`${home}/stable-diffusion.cpp/models`],
  downloadDir: '',
  server: { enabled: false, apiKey: '' },
  audio: { outputDir: `${home}/PolarisAudio`, copyTranscript: false },
  engines: {
    text: { binary: `${home}/llama.cpp/build/bin/llama-server`, port: 8080, ngl: 99, ctx: 8192, nCpuMoe: 0, noMmap: false, mlock: false, directIo: false, extraArgs: [] },
    image: { binary: `${home}/stable-diffusion.cpp/build/bin/sd-server`, port: 7800, backend: 'diffusion=vulkan0,clip=vulkan0,vae=vulkan0', extraArgs: [] },
    video: { binary: `${home}/stable-diffusion.cpp/build/bin/sd-server`, port: 7801, backend: 'diffusion=vulkan0,clip=vulkan0,vae=vulkan0', motionModule: null, extraArgs: [] },
    audio: { binary: `${home}/Downloads/Videos/remotion/Kokoro-TTS-Local/.venv/bin/python3.11`, port: 7802, qwen3Binary: '', q3Codec: '', ggmlBackend: 'Vulkan0', extraArgs: [] },
    stt: { binary: `${home}/whisper.cpp/build/bin/whisper-cli`, extraArgs: [] }
  }
};

for (const k of Object.keys(defaults)) {
  if (config[k] === undefined) config[k] = defaults[k];
}
for (const k of Object.keys(defaults.engines)) {
  if (!config.engines[k]) config.engines[k] = defaults.engines[k];
}

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { get: () => config, save, CONFIG_PATH, DATA_DIR };
