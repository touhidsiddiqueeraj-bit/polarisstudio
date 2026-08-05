# PolarisStudio

A local AI studio in the spirit of LM Studio, built on Electron + plain Node.js, driving **llama.cpp** (text) and **stable-diffusion.cpp** (image/video) over local HTTP. Designed around an AMD RX 580 (Polaris) with 8 GB VRAM, but works with any Vulkan device — or CPU.

No Python, no CUDA, no cloud. The app is a thin orchestration layer: it spawns engine binaries, proxies their HTTP APIs, and gives you a clean UI for chat, image, video, model library, and HuggingFace downloads.

## Features

- **Chat** — OpenAI-compatible streaming (SSE), markdown rendering, chain-of-thought ("thinking") toggle, ctx/temperature controls, `repeat_penalty` to tame repetitive models, persistent conversation history with rename/delete.
- **Images** — txt2img and img2img, LCM 4-step sampling, seed/batch/cfg/clip-skip, optional 4× RealESRGAN upscale, save PNG.
- **Video** — AnimateDiff txt2vid (webm), with a VRAM guard that rejects jobs too large for 8 GB.
- **Model library** — scans configured directories recursively, classifies models into text/image/video/aux by filename, delete from disk.
- **HuggingFace** — search, browse repo files, resumable downloads (`.part` + range resume, follows the HF→CDN redirect chain), live progress via SSE.
- **LAN OpenAI server** — optionally rebinds llama-server to `0.0.0.0` with an API key, so other apps/agents on your network can use the same model at `http://<lan-ip>:8080/v1`.
- **Resilience** — renderer crash recreates the window automatically; closing the window keeps the server + engines + downloads alive (headless mode); stale port conflicts are detected and killed automatically; one engine runs at a time to stay inside VRAM.

## Requirements

- Node.js ≥ 18, npm
- Electron (installed as a dev dependency)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server` build for text models
- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) — `sd-server` build for image/video
- A Vulkan GPU (tested on AMD RX 580); CPU-only works but is slow

## Install & run

```bash
git clone <this-repo>
cd PolarisStudio
npm install
```

Edit `config.json` to point at your engine binaries and model directories, then:

```bash
npm start          # or: ./node_modules/.bin/electron .
```

The UI opens at `http://127.0.0.1:9090` in an Electron window (the same URL works in a plain browser — the window is just a shell).

First launch: no models → click **Library** → **HuggingFace search** → search → **Files** → **↓** on a `.gguf`. Downloads land in your first configured model directory and become immediately loadable.

## Configuration (`config.json`)

This file is machine-specific and gitignored — the app regenerates sane defaults if it's missing.

| Key | Meaning | Default |
|-----|---------|---------|
| `modelDirs` | Directories scanned recursively for `.gguf` / `.safetensors` | `~/stable-diffusion.cpp/models` |
| `engines.text.binary` | Path to `llama-server` | `~/llama.cpp/build/bin/llama-server` |
| `engines.text.port` | Port for the text engine | `8080` |
| `engines.text.ngl` | GPU layers (`-ngl`) | `99` |
| `engines.text.ctx` | Context size | `8192` |
| `engines.text.extraArgs` | Extra llama-server flags | `["--flash-attn","on","--jinja"]` |
| `engines.text.host` | `127.0.0.1`, or `0.0.0.0` when LAN server enabled | `0.0.0.0` |
| `engines.image.binary` / `engines.video.binary` | Path to `sd-server` | `~/stable-diffusion.cpp/build/bin/sd-server` |
| `engines.image.port` / `engines.video.port` | Image / video ports | `7800` / `7801` |
| `engines.image.backend` / `engines.video.backend` | Vulkan backend string | `diffusion=vulkan0,clip=vulkan0,vae=vulkan0` |
| `engines.video.motionModule` | AnimateDiff motion module `.safetensors` | `null` |
| `server.enabled` / `server.apiKey` | LAN OpenAI-API exposure (managed via UI) | off |

## Troubleshooting

- **"couldn't bind / address already in use"** — a stale engine from a killed app holds the port. The app detects this, runs `fuser -k <port>/tcp`, and retries.
- **Downloads stall or fail** — this machine's IP may be throttled by HuggingFace (datacenter IPs get 401 on the API; the app falls back to scraping the public HTML tree page). Downloads resume via `.part` files; the retry restarts from where it stopped.
- **Model repeats itself / loops** — `repeat_penalty: 1.1` is sent by default on every chat request; raise `temperature` if a model is still degenerate.
- **Renderer glitches on old GPUs** — if the window ever goes blank, the app recreates it automatically and the backend keeps running.
- **Window closed** — the server keeps running headless (good for leaving the OpenAI API up). Relaunch the app to get the window back, or hit **Quit** in the sidebar to stop everything.

## Project layout

```
main.js            Electron main: HTTP server, routing, engine lifecycle, SSE
lib/config.js      config.json load + defaults
lib/models.js      model scanning + type classification
lib/engines.js     Engine class: spawn/health/stop, chat, image, video APIs
lib/hf.js          HuggingFace search, HTML scrape, resumable downloads
renderer/          The UI: index.html, app.js (vanilla JS), style.css
preload.js         Legacy bridge, not used by the current UI
config.json        Machine-specific config (gitignored)
conversations.json Chat history (gitignored)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, data flows, and the HTTP API reference.

## License

MIT
