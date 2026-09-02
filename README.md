# PolarisStudio

A local AI studio in the spirit of LM Studio, built on Electron + plain Node.js, driving **llama.cpp** (text), **stable-diffusion.cpp** (image/video), and **Kokoro-82M / XTTS-v2 / Qwen3-TTS + whisper.cpp** (audio speech) over local HTTP. Designed around an AMD RX 580 (Polaris) with 8 GB VRAM, but works with any Vulkan device — or CPU.

No cloud. The app is a thin orchestration layer: it spawns engine binaries, proxies their HTTP APIs, and gives you a clean UI for chat, image, video, TTS/STT, model library, and HuggingFace downloads.

## Where this fits

The "everything local in one app" space is crowded (LM Studio, Locally Uncensored, LocalGPT, OneAI, LocalAI). PolarisStudio's slot is narrower: **low-VRAM AMD Vulkan, one AppImage, no substrate.**

- **Runs on GPUs everyone else refuses** — the stack (llama.cpp + stable-diffusion.cpp on Vulkan, LCM 4-step, ESRGAN, AnimateDiff) is tuned around an RX 580 / 8 GB-class Polaris GPU. Competitors list NVIDIA 8–12 GB as their floor; this app treats 8 GB Vulkan as home.
- **Genuinely small** — a ~114 MB AppImage with zero Docker, zero ComfyUI graph editor as a hidden dependency. The only non-binary runtime is a small Python service for TTS/STT (a venv with Kokoro/XTTS/Qwen3 + whisper.cpp). Everything else in this niche ships a multi-hundred-MB-to-GB runtime.
- **Model procurement is first-class** — in-app HuggingFace search, per-file exact size + quant level + a "fits / too big for 8 GB" VRAM verdict before you download, then a resumable `.part` download straight into your library.
- **Engine cockpit, one window** — per-modality (text/image/video/audio) engine status, spawn/kill, and a shared log without leaving the UI.

Expect parity on the common stuff: OpenAI-compatible local harness, uncensored-model search, chat/images/video generation. The reason to pick PolarisStudio is the hardware it runs on and how little you have to install to get there.

## Features (build 13)

- **Chat** — OpenAI-compatible streaming (SSE), **LaTeX via KaTeX** (`$…$` inline, `$$…$$` display), **system prompt presets** (Helpful/Reviewer/Creative/Custom), markdown rendering, chain-of-thought ("thinking") as a **collapsible** `<details>` with reasoning body, **copy button on every code block**, ctx/temperature/`repeat_penalty` controls, persistent conversation history with **search/filter**, **rename (dblclick)**/**export to .md/.json**/**delete** per chat.
- **Vision** — paste, drop, or attach an image into chat; the model sees it via a multimodal projector. `--mmproj` is auto-discovered next to the model file, and a bundled MCP server (`mcp-server.js`) exposes `describe_image` to coding agents.
- **Images** — txt2img and img2img, LCM 4-step sampling, seed/batch/cfg/clip-skip, optional 4× RealESRGAN upscale, save PNG, **8-thumb history strip** (click to promote).
- **Video** — AnimateDiff txt2vid (webm), with a VRAM guard that rejects jobs too large for 8 GB.
- **Audio** — three TTS backends behind one tab: Kokoro-82M (built-in, 54 voices) + XTTS-v2 voice cloning, and **Qwen3-TTS** (qwentts.cpp on Vulkan) with model selection, 10 languages, **designer voices** and local voice cloning from any audio clip (mp3/webm/m4a normalized to WAV automatically). Speech-to-text via whisper.cpp for uploaded files **and a live microphone** (3-second chunks stream into the transcript as you speak).
- **Model library** — scans configured directories recursively, classifies models into text/image/video/aux by filename, **VRAM badge** (`fits 8GB` / `too big` + `~GB` tooltip), **active-model highlight** (`● loaded`), delete from disk.
- **Engine cockpit, one window** — per-modality (text/image/video/audio) engine status, spawn, and **eject** (⏏ unloads the model, freeing VRAM), plus a shared log without leaving the UI. **Harness `Keep loaded`** keeps the text model alive when you switch to Images/Video.
- **HuggingFace** — search, browse repo files, resumable downloads (`.part` + range resume, follows the HF→CDN redirect chain), live progress via SSE, **Cancel button per download** (aborts stream, keeps `.part` for resume).
- **Local AI harness — single port `9090/v1`** — the same port as the vision MCP (`http://127.0.0.1:9090`). **Open by default** on `127.0.0.1:9090/v1` (same-machine opencode needs no config). Toggle **Expose to LAN** to rebind to `0.0.0.0:9090` for other machines (`http://<lan-ip>:9090/v1`). `GET /v1/models` returns local text GGUFs even before a model is loaded; `POST /v1/chat/completions` auto-starts the harness model if needed. **Copy opencode.json** and **Copy curl** buttons in the Chat harness bar. Works with any OpenAI client (opencode, curl, Python `openai`).
- **Remote harness (chat-only)** — connect to other machines’ `llama-server` / vLLM / Ollama via `Library → Remote llama-servers` (name + `http://host:port` + key, **Test** via `/v1/models`), then pick `Provider: [Local | lab-machine]` in Chat. Streaming + reasoning proxied, no local VRAM needed. Great for using a bigger box’s GPU from the Polaris box.
- **Prettier LM Studio-like UI** — centered 780px chat, pill tabs, `backdrop-blur` topbar, subtle shadows, JetBrains Mono for code, **auto light/dark** (`Auto` follows `prefers-color-scheme`, `Light`/`Dark` override, persisted in `config.json:ui.theme`), **collapsible sidebar** (◧), **Ctrl+K palette** (tabs, models, new chat, theme, etc.), conversation search, theme-aware scrollbars.
- **Settings — 4 tabs, no clipping** — `Appearance` (font + theme with live preview), `Generation` (top_p/top_k/min_p/repeat_penalty with `?` help), `Performance & Memory` (threads/batch/flash/parallel/ngl, KV cache, no-mmap/mlock/direct-io, **MoE CPU offload toggle + number always visible**, speculative decoding + benchmark), `System` (harness/LAN/API key, paths, extraArgs, Reset). Scrollable body with `scrollbar-gutter: stable`; every flag has a `?` tooltip.
- **Sampling + VRAM tuning** — `top_p (0.95)`, `top_k (40)`, `min_p (0.05)`, `repeat_penalty (1.1)` and `ngl (99)` are now persisted in `config.json` and forwarded as `--top-p/--top-k/--min-p/--repeat-penalty/--ngl` (only when non-default). One-line startup log summarizes sampling + ngl.
- **TurboQuant** — KV cache now offers `q4_0_turbo` / `q8_0_turbo` in addition to `f16/q8_0/q4_0`. Needs a rebuilt `llama.cpp` (master post-`2024-12`) — otherwise the engine logs `unknown cache type` and falls back. Pass via UI or `extraArgs`.
- **Resilience** — renderer crash recreates the window automatically; closing the window keeps the server + engines + downloads alive (headless mode); stale port conflicts are detected and killed automatically; harness `keepAlive` avoids cold-start for opencode; one engine runs at a time to stay inside VRAM (unless keepAlive).

## Requirements

- Node.js ≥ 18, npm
- Electron (installed as a dev dependency)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server` build for text models (rebuild for TurboQuant)
- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) — `sd-server` build for image/video
- Audio: a Python 3 venv with `kokoro`, `TTS` (XTTS-v2) and `soundfile`; `ffmpeg` on PATH; [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli`; optionally [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) (Vulkan build) + a `qwen-talker` GGUF + `qwen-tokenizer-12hz` GGUF for Qwen3-TTS
- A Vulkan GPU (tested on AMD RX 580); CPU-only works but is slow
- KaTeX fonts/CSS are vendored (`renderer/vendor/katex.*`, `renderer/vendor/fonts/`) — no CDN needed

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

The UI opens at `http://127.0.0.1:9090` in an Electron window (the same URL works in a plain browser — the window is just a shell). The **harness** is on the same port: `http://127.0.0.1:9090/v1` (and `http://<lan-ip>:9090/v1` when `Expose to LAN` is checked). The legacy `8080` llama-server port is still internal (`127.0.0.1:8080`) and proxied.

First launch: no models → click **Library** → **HuggingFace search** → search → **Files** → **↓** on a `.gguf`. Downloads land in your first configured model directory and become immediately loadable.

## Using as a local harness (opencode, curl, any OpenAI client)

The harness is **on by default** at `http://127.0.0.1:9090/v1` (no toggle needed for same-machine). For other machines on your LAN, check **Expose to LAN** in the Chat harness bar and `Apply`.

**opencode.json** (same machine):
```json
{
  "providers": {
    "polaris": {
      "baseUrl": "http://127.0.0.1:9090/v1",
      "model": "your-model-name.gguf"
    }
  },
  "mcp": {
    "polaris-vision": {
      "type": "local",
      "command": ["node", "/path/to/PolarisStudio/mcp-server.js"],
      "enabled": true
    }
  }
}
```
Click **Copy opencode** in the harness bar to copy the snippet with your current model + key prefilled. **Copy curl** gives a ready `curl http://.../v1/chat/completions` line.

Test quickly:
```bash
curl http://127.0.0.1:9090/v1/models | jq
curl -X POST http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"any","messages":[{"role":"user","content":"hi"}]}'
```

Remote harness: `Library → Remote llama-servers → Add http://other-box:8080 → Test → Use`, then in Chat pick `Provider: lab-machine`.

## Configuration (`config.json`)

This file is machine-specific and gitignored — the app regenerates sane defaults if it's missing.

| Key | Meaning | Default |
|-----|---------|---------|
| `modelDirs` | Directories scanned recursively for `.gguf` / `.safetensors` / `.bin` (whisper) | `~/stable-diffusion.cpp/models` |
| `harness.enabled` | Single-port harness on `9090/v1` is on | `true` |
| `harness.keepAlive` | Keep text model loaded when switching to Image/Video (so opencode doesn’t cold-start) | `true` |
| `harness.model` | Last harness model path (auto-set when you Start engine) | `""` |
| `engines.text.binary` | Path to `llama-server` | `~/llama.cpp/build/bin/llama-server` |
| `engines.text.port` | Port for the text engine (internal, proxied) | `8080` |
| `engines.text.ngl` | GPU layers (`-ngl`, Performance tab) | `99` |
| `engines.text.ctx` | Context size | `8192` |
| `engines.text.topP` / `engines.text.topK` / `engines.text.minP` | Sampling: `top_p` / `top_k` / `min_p` (Generation tab, `?` help; forwarded as `--top-p/--top-k/--min-p` only when non-default) | `0.95` / `40` / `0.05` |
| `engines.text.repeatPenalty` | Repetition penalty (`--repeat-penalty`, Generation tab) | `1.1` |
| `engines.text.nCpuMoe` | MoE experts offloaded to CPU (`--n-cpu-moe`; toggle + number always visible, `?` help; MoE models only) | `0` |
| `engines.text.noMmap` | Load weights without mmap (`--no-mmap`) | `false` |
| `engines.text.mlock` | Lock weights in RAM (`--mlock`) | `false` |
| `engines.text.directIo` | Bypass page cache on weight reads (`--direct-io`) | `false` |
| `engines.text.cacheTypeK` / `engines.text.cacheTypeV` | KV cache quantization (`--cache-type-k/v`; `f16`/`q8_0`/`q4_0`/`q4_0_turbo`/`q8_0_turbo`) | `f16` |
| `engines.text.extraArgs` | Extra llama-server flags (System → Advanced, space-separated) | `["--flash-attn","on","--jinja"]` |
| `engines.text.provider` / `engines.text.activeRemoteId` | Remote harness selection (`local` vs `remote` + id) | `local` |
| `engines.text.mmproj` | Optional explicit vision projector; otherwise auto-discovered only when an `mmproj-*.gguf` **shares the model's family name** (quant suffixes ignored, e.g. `gemma-4-E4B-it-Q4_0.gguf` ↔ `mmproj-gemma-4-E4B-it-Q8_0.gguf`). Unrelated projectors are never attached. | auto |
| `remotes` | List of remote llama-servers `{id,name,baseUrl,apiKey}` | `[]` |
| `ui.theme` | `auto` (follows OS) / `light` / `dark` | `auto` |
| `engines.image.binary` / `engines.video.binary` | Path to `sd-server` | `~/stable-diffusion.cpp/build/bin/sd-server` |
| `engines.image.port` / `engines.video.port` | Image / video ports | `7800` / `7801` |
| `engines.image.backend` / `engines.video.backend` | Vulkan backend string | `diffusion=vulkan0,clip=vulkan0,vae=vulkan0` |
| `engines.image.vae` / `engines.image.llm` | FLUX.2-klein companions: VAE (`flux2_vae.safetensors`) + text encoder LLM (`Qwen3-4B GGUF`); auto-discovered in `modelDirs` if not set | auto |
| `engines.video.motionModule` | AnimateDiff motion module `.safetensors` | `null` |
| `engines.audio.python` | Python interpreter for the TTS/STT service | the app's bundled venv |
| `engines.audio.binary` | Path to `audio_server.py` | bundled |
| `engines.audio.port` | Port for the audio engine | `7802` |
| `engines.audio.sttBinary` | Path to `whisper-cli` | `~/whisper.cpp/build/bin/whisper-cli` |
| `engines.audio.qwen3Binary` | Path to `qwen-tts` (Qwen3-TTS talker runner) | `''` (off) |
| `engines.audio.q3Codec` | Path to `qwen-tokenizer-12hz*.gguf` | `''` (auto: next to the talker) |
| `engines.audio.ggmlBackend` | GGML backend for qwen3 (`Vulkan0`, `CPU`…) | `Vulkan0` |
| `server.enabled` / `server.apiKey` | Expose `9090` to LAN (`0.0.0.0`) + optional Bearer auth for the harness | off |

## FLUX.2-klein (diffusion-only)

`flux-2-klein-4b-*.gguf` (~2.5 GB) is **not** a standalone image model — it is the transformer only. `stable-diffusion.cpp` requires it via `--diffusion-model` plus two companions:

* **VAE** — `flux2_vae.safetensors` (321 MB, `Comfy-Org/flux2-klein-4B` → `split_files/vae/flux2-vae.safetensors`, non-gated)
* **LLM text encoder** — `Qwen3-4B-Q4_K_M.gguf` (2.5 GB, `unsloth/Qwen3-4B-GGUF`)

Place both in any `modelDirs` (e.g. `/mnt/backup/llm-models` or `~/stable-diffusion.cpp/models`) and Polaris auto-discovers them. The Images tab shows a banner when they are missing with one-click download buttons; the Library marks `flux-2-klein` with `needs VAE+LLM`. On RX 580 8 GB use `512×512, steps 4, cfg 1.0, sampler lcm` and `diffusion=vulkan0,clip=vulkan0,vae=vulkan0` (+ `--offload-to-cpu` / `--vae-tiling` if OOM). Full single-file models like `LCM_Dreamshaper_v7-f16.gguf` still work via `-m`.

## Known limitations

- **Model downloads from HuggingFace are unreliable** — downloads can stall, fail silently, or never appear in the download list, especially from datacenter IPs (HF throttles/401s them). Retrying, or downloading manually via `curl -L -C -` into a configured model directory, is the workaround. In-flight downloads now have a **Cancel** button (keeps `.part` for resume). For FLUX.2-klein the VAE on `black-forest-labs/FLUX.2-dev` is gated — Polaris uses the `Comfy-Org` mirror above.
- **Vision needs a multimodal model** — chat attachments only work when the loaded text model has an `mmproj` projector next to it (e.g. an official Gemma/SmolVLM GGUF + its `mmproj-*.gguf` in the same directory). Plain text-only GGUFs ignore attached images.
- **TurboQuant needs a rebuilt llama.cpp** — `q4_0_turbo` / `q8_0_turbo` only works with a post-`2024-12` `llama-server` build; otherwise the log shows `unknown cache type` and you should use `q8_0`.

## Vision / agent API (`/api/vision`) + MCP server

A JSON `POST /api/vision` endpoint lets external agents send images to the local multimodal LLM without touching the UI. It auto-starts/stops the text engine (and frees other engines' VRAM first) and returns a plain text description. The bundled `mcp-server.js` wraps this as an MCP tool (`describe_image`) for coding agents.

### Getting the MCP working — quick start

1. **Start the app** — `npm start`. The MCP proxies to `http://127.0.0.1:9090`, so PolarisStudio must be running (closing the window is fine — the server stays up headless).
2. **Have a multimodal model** — a GGUF with vision, plus its `mmproj-*.gguf` **in the same directory** (auto-discovered, e.g. `gemma-4-E4B-it-Q4_0.gguf` + `mmproj-gemma-4-E4B-it-Q8_0.gguf`). Plain text-only GGUFs can't see images.
3. **Register the server** in your MCP client, e.g. opencode (`opencode.json`, project or `~/.config/opencode/`):

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

4. **Use it** — ask your agent to describe an image file; the tool takes a file path, `file://` URL, or base64 data URI, plus an optional `prompt` and `modelPath`.

### Configuration

| Variable | Meaning | Default |
|----------|---------|---------|
| `POLARIS_VISION_MODEL` | Vision model GGUF used when `modelPath` is not passed | `gemma-4-E4B-it-Q4_0.gguf` (path hardcoded in `mcp-server.js`) |
| `POLARIS_PORT` | PolarisStudio UI server port | `9090` |

### Testing without an agent

```bash
# needs a base64 data URI of your image
curl -X POST http://127.0.0.1:9090/api/vision \
  -H 'Content-Type: application/json' \
  -d '{"modelPath":"/path/to/gemma-4-E4B-it-Q4_0.gguf","prompt":"Describe this image in one sentence.","images":["data:image/png;base64,...."]}'
# => {"text":"A smooth, vibrant gradient..."}
```

### How cold start works

The first request starts the text engine if it isn't running (model load takes a few seconds). During loading, llama-server answers 503 `"Loading model"`; PolarisStudio waits for a real 200 before sending your image, and `mcp-server.js` additionally retries transient `"Loading model"` / `ECONNREFUSED` responses with backoff (5 attempts) — so a cold start succeeds automatically, just slower. If you still see errors: `ECONNREFUSED` means the app isn't running (step 1); `"model missing"` means the `modelPath` GGUF doesn't exist.

## Resolved

- **Log button unresponsive** — the engine-log panel appeared dead because the `footer.logbar` sat below the viewport: `.app` was fixed at `100vh` and `body { overflow: hidden }` clipped it. The app body is now a flex column and the panel slides into view on toggle (build 4+).
- **All buttons dead after the vision update** — `sendChat` declared `const content` for the user message while the streaming accumulator below used `let content`, a redeclaration that killed the whole script (SyntaxError at parse time → zero event listeners attached). The user-message variable was renamed `userContent`.
- **Copy buttons “Write permission denied”** — `navigator.clipboard.writeText` fails in Electron without a secure context. Now uses `copyText()` with `execCommand('copy')` fallback + `prompt()` last resort; no more `unhandled:` banner (build 8).
- **Taskbar still on build 5/8** — `~/.local/bin/polarisstudio` was a stale AppImage; `dist` now contains build 13 and `cp dist/*.AppImage ~/.local/bin/polarisstudio && update-desktop-database ~/.local/share/applications/` updates it (may need unpin/re-pin or `fusermount -u /tmp/.mount_polar*` if `Text file busy`).
- **Settings clipping / scrollbar missing** — `#tab-settings` was `overflow-y:auto` on a flex parent that clipped instead of scrolling; now `flex column + .settings-body overflow-y:auto scrollbar-gutter:stable` with 4 tabs.

## Troubleshooting

- **MoE model too slow / out of VRAM** — in **Settings → Performance & Memory** raise **MoE CPU offload** (toggle + number, offloads expert blocks to RAM) or lower **GPU layers (ngl)**, or switch **KV cache** to `q8_0`/`q4_0`. Changes need **Restart engine** in Chat.
- **"couldn't bind / address already in use"** — a stale engine from a killed app holds the port. The app detects this, runs `fuser -k <port>/tcp`, and retries.
- **Downloads stall or fail** — this machine's IP may be throttled by HuggingFace (datacenter IPs get 401 on the API; the app falls back to scraping the public HTML tree page). Downloads resume via `.part` files; the retry restarts from where it stopped. Use **Cancel** to abort a stalled download.
- **Model repeats itself / loops** — `repeat_penalty: 1.1` is sent by default on every chat request; raise `temperature` if a model is still degenerate.
- **Renderer glitches on old GPUs** — if the window ever goes blank, the app recreates it automatically and the backend keeps running.
- **Window closed** — the server keeps running headless (good for leaving the harness up). Relaunch the app to get the window back, or hit **Quit** in the sidebar to stop everything.
- **Harness not reachable from another machine** — check **Expose to LAN** in the harness bar, `Apply`, then use `http://<lan-ip>:9090/v1` (not `8080`). The harness is always `9090/v1` (same port as vision), `8080` is internal only.

## Project layout

```
main.js            Electron main: HTTP server, routing, engine lifecycle, SSE, harness proxy (9090/v1)
lib/config.js      config.json load + defaults (harness, remotes, ui.theme, turbo cache types)
lib/models.js      model scanning + type classification
lib/engines.js     Engine class: spawn/health/stop, chat, vision, image, video APIs
lib/hf.js          HuggingFace search, HTML scrape, resumable downloads
audio_server.py    TTS/STT service: Kokoro + XTTS-v2 clone + Qwen3-TTS + whisper
renderer/          The UI: index.html, app.js (vanilla JS + KaTeX), style.css (auto light/dark)
  vendor/          vendored KaTeX (katex.min.{js,css} + fonts/) + marked.min.js
mcp-server.js      Vision MCP server for coding agents (describe_image)
preload.js         Legacy bridge, not used by the current UI
config.json        Machine-specific config (gitignored)
conversations.json Chat history (gitignored)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, data flows, and the HTTP API reference.

## License

MIT
