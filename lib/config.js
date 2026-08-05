const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  config = { modelDirs: [], engines: {} };
}

const home = require('os').homedir();
const defaults = {
  modelDirs: [`${home}/stable-diffusion.cpp/models`],
  server: { enabled: false, apiKey: '' },
  engines: {
    text: { binary: `${home}/llama.cpp/build/bin/llama-server`, port: 8080, ngl: 99, ctx: 8192, extraArgs: [] },
    image: { binary: `${home}/stable-diffusion.cpp/build/bin/sd-server`, port: 7800, backend: 'diffusion=vulkan0,clip=vulkan0,vae=vulkan0', extraArgs: [] },
    video: { binary: `${home}/stable-diffusion.cpp/build/bin/sd-server`, port: 7801, backend: 'diffusion=vulkan0,clip=vulkan0,vae=vulkan0', motionModule: null, extraArgs: [] }
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

module.exports = { get: () => config, save, CONFIG_PATH };
