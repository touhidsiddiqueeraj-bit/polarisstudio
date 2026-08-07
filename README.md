# PolarisStudio

A local AI studio in the spirit of LM Studio, built on Electron + plain Node.js, driving **llama.cpp** (text), **stable-diffusion.cpp** (image/video), and **Kokoro-82M / XTTS-v2 / Qwen3-TTS + whisper.cpp** (audio speech) over local HTTP. Designed around an AMD RX 580 (Polaris) with 8 GB VRAM, but works with any Vulkan device — or CPU.

No CUDA, no cloud. The app is a thin orchestration layer: it spawns engine binaries, proxies their HTTP APIs, and gives you a clean UI for chat, image, video, TTS/STT, model library, and HuggingFace downloads.

## Where this fits

The "everything local in one app" space is crowded (LM Studio, Locally Uncensored, LocalGPT, OneAI, LocalAI). PolarisStudio's slot is narrower: **low-VRAM AMD Vulkan, one AppImage, no substrate.**

- **Runs on GPUs everyone else refuses** — the stack (llama.cpp + stable-diffusion.cpp on Vulkan, LCM 4-step, ESRGAN, AnimateDiff) is tuned around an RX 580 / 8 GB-class Polaris GPU. Competitors list NVIDIA 8–12 GB as their floor; this app treats 8 GB Vulkan as home.
- **Genuinely small** — a ~110 MB AppImage with zero Docker, zero ComfyUI graph editor as a hidden dependency. The only non-binary runtime is a small Python service for TTS/STT (a venv with Kokoro/XTTS/Qwen3 + whisper.cpp). Everything else in this niche ships a multi-hundred-MB-to-GB runtime.
- **Model procurement is first-class** — in-app HuggingFace search, per-file exact size + quant level + a "fits / too big for 8 GB" VRAM verdict before you download, then a resumable `.part` download straight into your library.
- **Engine cockpit, one window** — per-modality (text/image/video/audio) engine status, spawn/kill, and a shared log without leaving the UI.

Expect parity on the common stuff: OpenAI-compatible LAN API, uncensored-model search, chat/images/video generation. The reason to pick PolarisStudio is the hardware it runs on and how little you have to install to get there.

## Features

- **Chat** — OpenAI-compatible streaming (SSE), markdown rendering, chain-of-thought ("thinking") toggle, ctx/temperature controls, `repeat_penalty` to tame repetitive models, persistent conversation history with rename/delete.
- **Vision** — paste, drop, or attach an image into chat; the model sees it via a multimodal projector. `--mmproj` is auto-discovered next to the model file, and a bundled MCP server (`mcp-server.js`) exposes `describe_image` to coding agents.
- **Images** — txt2img and img2img, LCM 4-step sampling, seed/batch/cfg/clip-skip, optional 4× RealESRGAN upscale, save PNG.
- **Video** — AnimateDiff txt2vid (webm), with a VRAM guard that rejects jobs too large for 8 GB.
- **Audio** — three TTS backends behind one tab: Kokoro-82M (built-in, 54 voices) + XTTS-v2 voice cloning, and **Qwen3-TTS** (qwentts.cpp on Vulkan) with model selection, 10 languages, **designer voices** (describe the voice in a prompt — `--instruct`, no reference needed) and local voice cloning from any audio clip (mp3/webm/m4a normalized to WAV automatically). Speech-to-text via whisper.cpp for uploaded files **and a live microphone** (3-second chunks stream into the transcript as you speak).
- **Model library** — scans configured directories recursively, classifies models into text/image/video/aux by filename, delete from disk.
- **Engine cockpit, one window** — per-modality (text/image/video/audio) engine status, spawn, and **eject** (⏏ unloads the model, freeing VRAM), plus a shared log without leaving the UI.
- **HuggingFace** — search, browse repo files, resumable downloads (`.part` + range resume, follows the HF→CDN redirect chain), live progress via SSE.
- **LAN OpenAI server** — optionally rebinds llama-server to `0.0.0.0` with an API key, so other apps/agents on your network can use the same model at `http://<lan-ip>:8080/v1`.
- **Resilience** — renderer crash recreates the window automatically; closing the window keeps the server + engines + downloads alive (headless mode); stale port conflicts are detected and killed automatically; one engine runs at a time to stay inside VRAM.

## Requirements

- Node.js ≥ 18, npm
- Electron (installed as a dev dependency)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server` build for text models
- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) — `sd-server` build for image/video
- Audio: a Python 3 venv with `kokoro`, `TTS` (XTTS-v2) and `soundfile`; `ffmpeg` on PATH; [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli`; optionally [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) (Vulkan build) + a `qwen-talker` GGUF + `qwen-tokenizer-12hz` GGUF for Qwen3-TTS
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
| `modelDirs` | Directories scanned recursively for `.gguf` / `.safetensors` / `.bin` (whisper) | `~/stable-diffusion.cpp/models` |
| `engines.text.binary` | Path to `llama-server` | `~/llama.cpp/build/bin/llama-server` |
| `engines.text.port` | Port for the text engine | `8080` |
| `engines.text.ngl` | GPU layers (`-ngl`) | `99` |
| `engines.text.ctx` | Context size | `8192` |
| `engines.text.nCpuMoe` | MoE experts offloaded to CPU (`--n-cpu-moe`; UI slider, MoE models only) | `0` |
| `engines.text.noMmap` | Load weights without mmap (`--no-mmap`) | `false` |
| `engines.text.mlock` | Lock weights in RAM (`--mlock`) | `false` |
| `engines.text.directIo` | Bypass page cache on weight reads (`--direct-io`) | `false` |
| `engines.text.cacheTypeK` / `engines.text.cacheTypeV` | KV cache quantization (`--cache-type-k/v`; `f16`/`q8_0`/`q4_0`) | `f16` |
| `engines.text.extraArgs` | Extra llama-server flags | `["--flash-attn","on","--jinja"]` |
| `engines.text.host` | `127.0.0.1`, or `0.0.0.0` when LAN server enabled | `0.0.0.0` |
| `engines.text.mmproj` | Optional explicit vision projector; otherwise auto-discovered (`mmproj*` next to the model) | auto |
| `engines.image.binary` / `engines.video.binary` | Path to `sd-server` | `~/stable-diffusion.cpp/build/bin/sd-server` |
| `engines.image.port` / `engines.video.port` | Image / video ports | `7800` / `7801` |
| `engines.image.backend` / `engines.video.backend` | Vulkan backend string | `diffusion=vulkan0,clip=vulkan0,vae=vulkan0` |
| `engines.video.motionModule` | AnimateDiff motion module `.safetensors` | `null` |
| `engines.audio.python` | Python interpreter for the TTS/STT service | the app's bundled venv |
| `engines.audio.binary` | Path to `audio_server.py` | bundled |
| `engines.audio.port` | Port for the audio engine | `7802` |
| `engines.audio.sttBinary` | Path to `whisper-cli` | `~/whisper.cpp/build/bin/whisper-cli` |
| `engines.audio.qwen3Binary` | Path to `qwen-tts` (Qwen3-TTS talker runner) | `''` (off) |
| `engines.audio.q3Codec` | Path to `qwen-tokenizer-12hz*.gguf` | `''` (auto: next to the talker) |
| `engines.audio.ggmlBackend` | GGML backend for qwen3 (`Vulkan0`, `CPU`…) | `Vulkan0` |
| `server.enabled` / `server.apiKey` | LAN OpenAI-API exposure (managed via UI) | off |

## Known limitations

- **Model downloads from HuggingFace are unreliable** — downloads can stall, fail silently, or never appear in the download list, especially from datacenter IPs (HF throttles/401s them). Retrying, or downloading manually via `curl -L -C -` into a configured model directory, is the workaround.
- **No cancel button for in-flight downloads** — once a download is queued there is no way to abort it from the UI; it runs to completion (or stalls). Restarting the app is the only out.
- **Vision needs a multimodal model** — chat attachments only work when the loaded text model has an `mmproj` projector next to it (e.g. an official Gemma/SmolVLM GGUF + its `mmproj-*.gguf` in the same directory). Plain text-only GGUFs ignore attached images.

## Vision / agent API (`/api/vision`)

A JSON `POST /api/vision` endpoint lets external agents send images to the local multimodal LLM without touching the UI. It auto-starts/stops the text engine (and frees other engines' VRAM first) and returns a plain text description.

```bash
curl -X POST http://127.0.0.1:9090/api/vision \
  -H 'Content-Type: application/json' \
  -d '{"modelPath":"/path/to/gemma-4-E4B-it-Q4_0.gguf","prompt":"Describe this image in one sentence.","images":["data:image/png;base64,...."]}'
# => {"text":"A smooth, vibrant gradient..."}
```

The bundled `mcp-server.js` wraps this as an MCP tool (`describe_image`) for coding agents. Register it in opencode with:

```json
{
  "mcp": {
    "polaris-vision": {
      "type": "local",
      "command": ["node", "/path/to/PolarisStudio/mcp-server.js"],
      "enabled": true
    }
  }
}
```

The default model is the official `gemma-4-E4B-it` GGUF; override per-call with `modelPath` or globally with the `POLARIS_VISION_MODEL` env var.

## Resolved

- **Log button unresponsive** — the engine-log panel appeared dead because the `footer.logbar` sat below the viewport: `.app` was fixed at `100vh` and `body { overflow: hidden }` clipped it. The app body is now a flex column and the panel slides into view on toggle (build 4+).
- **All buttons dead after the vision update** — `sendChat` declared `const content` for the user message while the streaming accumulator below used `let content`, a redeclaration that killed the whole script (SyntaxError at parse time → zero event listeners attached). The user-message variable was renamed `userContent`.

## Troubleshooting

- **MoE model too slow / out of VRAM** — raise **MoE CPU** (offloads expert blocks to system RAM), or switch **KV cache** to `q8_0`/`q4_0` to shrink cache VRAM. Toggles apply per session from the chat toolbar. (Deprecated `--no-mmap`/`--mlock`/`--direct-io` still work in llama-server; a one-line deprecation warning in the log is expected.)
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
lib/engines.js     Engine class: spawn/health/stop, chat, vision, image, video APIs
lib/hf.js          HuggingFace search, HTML scrape, resumable downloads
audio_server.py    TTS/STT service: Kokoro + XTTS-v2 clone + Qwen3-TTS + whisper
renderer/          The UI: index.html, app.js (vanilla JS), style.css
mcp-server.js      Vision MCP server for coding agents (describe_image)
preload.js         Legacy bridge, not used by the current UI
config.json        Machine-specific config (gitignored)
conversations.json Chat history (gitignored)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, data flows, and the HTTP API reference.

## License

MIT
