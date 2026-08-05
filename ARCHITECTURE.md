# PolarisStudio — Architecture

## Overview

PolarisStudio is an Electron app whose main process doubles as a Node HTTP server. The UI is a plain HTML/JS renderer loaded over `http://127.0.0.1:9090` — there is **no IPC layer** between window and backend; the renderer talks to the server exactly like a browser would (fetch + EventSource). Engine binaries (llama-server, sd-server) are spawned as child processes and driven through their own local HTTP APIs.

```
┌───────────────────────────── Electron main process ─────────────────────────────┐
│                                                                                  │
│  main.js ── HTTP server :9090 (static + /api/* + SSE /api/events)                │
│    │  ▲                                                                          │
│    │  │ child processes                 lib/config.js   config.json              │
│    │  ▼                                 lib/models.js   conversations.json        │
│  lib/engines.js ── spawn/health/stop ──► llama-server :8080  (text, OpenAI API)   │
│    │                                    sd-server  :7800  (image, A1111 API)     │
│    │                                    sd-server  :7801  (video, sd.cpp API)    │
│  lib/hf.js ── HTTPS ──► huggingface.co (search / tree scrape / resolve → CDN)     │
│                                                                                  │
└──────────┬───────────────────────────────────────────────────────────────────────┘
           │ fetch/SSE over http://127.0.0.1:9090 (no IPC)
┌──────────▼───────────────────────────────────────────────────────────────────────┐
│  Renderer (Chromium window)                                                      │
│  renderer/index.html + app.js + style.css — vanilla JS, marked.min.js for MD     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Process model

- **Main process** owns: HTTP server (port 9090), the engine child processes, the download registry, SSE client set, config and conversation persistence.
- **Engines**: at most one child process runs at a time per type (text/image/video). Starting any engine stops the others first — VRAM arbitration for the 8 GB card. Text runs from `127.0.0.1:8080` (or `0.0.0.0:8080` when LAN exposure is enabled).
- **Headless mode**: closing the window does **not** quit the app (`window-all-closed` handler is intentionally empty). The server, engines, and downloads keep running; relaunching the app (or the `second-instance` handler) recreates the window. `before-quit` stops engines, aborts downloads, and closes the server.
- **Single instance**: `requestSingleInstanceLock()` — a second launch only opens a window.

## Engine lifecycle (`lib/engines.js`)

1. `start(modelPath, opts)` builds args (`lib/engines.js:64`), verifies binary and model exist, spawns, then polls the health endpoint (`/health` for text, `/sdapi/v1/options` for image/video) every 500 ms up to 90 s.
2. Two spawn attempts; on failure the last 15 log lines are surfaced as the error.
3. If the child exits with a bind error, the port is considered held by a stale process: `fuser -k <port>/tcp` is run and the caller retries.
4. `stop()` sends SIGTERM, escalates to SIGKILL after 8 s.

Engine stdout/stderr is streamed to the renderer as `engine:log` SSE events and kept in a rolling buffer for error reporting.

## HTTP API (all JSON unless noted)

Served by `main.js`. GET requests are one-shot; POST bodies are JSON. Errors return `500 {"error": "..."}`; unknown routes return `404`.

| Route | Method | Purpose |
|-------|--------|---------|
| `/` , `/style.css`, `/app.js`, `/vendor/marked.min.js` | GET | static UI (served with `Cache-Control: no-store`) |
| `/api/events` | GET | SSE: `engine:log`, `dl:progress`, `dl:done`, `dl:error` |
| `/api/chat` | POST | stream a chat reply (SSE) — body `{modelPath, messages, opts}` |
| `/api/config` | GET | current config |
| `/api/config/save` | POST | merge + persist config (`config.json`) |
| `/api/engines` | GET | status of all three engines |
| `/api/engine/start` | POST | start an engine — body `{type, modelPath, opts}`; stops other engines first |
| `/api/engine/stop` | POST | stop one engine — body `{type}` |
| `/api/models` | GET | recursive model list from `modelDirs` |
| `/api/models/delete` | POST | remove a model file |
| `/api/hf/search` | GET | HF model search — `?q=...` |
| `/api/hf/files` | GET | file list for a repo — `?repo=...` |
| `/api/hf/download` | POST | start/restart a download — `{repo, file, destDir}`; returns `{id}` |
| `/api/hf/abort` | POST | abort a download — `{id}` |
| `/api/server/set` | POST | toggle LAN OpenAI exposure — `{enabled, apiKey, modelPath}` |
| `/api/images/generate` | POST | txt2img via sd-server |
| `/api/images/img2img` | POST | img2img via sd-server |
| `/api/video/generate` | POST | txt2vid (AnimateDiff, async job poll) |
| `/api/conversations` | GET | all conversations |
| `/api/conversations/save` | POST | upsert one conversation |
| `/api/conversations/delete` | POST | delete one conversation |
| `/api/quit` | POST | quit the app |

## Data flows

### Chat (streaming)

Renderer → `POST /api/chat` → if engine not running, start it (90 s budget) → forward to `llama-server /v1/chat/completions` with `stream: true`, `temperature`, `max_tokens`, `repeat_penalty: 1.1` (default), and `chat_template_kwargs.enable_thinking` when the thinking toggle is on → main process parses each `data:` line and re-emits `{content}` / `{reasoning}` events as SSE to the renderer → renderer streams into the bubble with markdown. The client AbortController cancels via the `AbortSignal` propagated through the request; a `{done}` event completes the turn and the message is persisted.

### HuggingFace downloads (`lib/hf.js`)

1. `Download.start()` writes to `<dest>.part`, never the final name.
2. Existing `.part` size → `Range: bytes=N-` header (resume).
3. HF `/resolve/main/<file>` responds 302 → the URL is resolved manually (`followRedirects`, HEAD walk, ≤5 hops) to the CDN endpoint, then streamed with the range header.
4. A `416 Range Not Satisfiable` means the file is already complete → rename `.part` → done.
5. Progress events (`{bytes, total}`) are broadcast as `dl:progress`; completion as `dl:done`.
6. `downloads` is a Map keyed by `repo/file`. Re-POSTing the same id aborts the stale entry and restarts fresh. `/api/hf/abort` sets the `aborted` flag; the stream is destroyed and the partial `.part` remains for later resume.

### Model listing (`lib/models.js`)

Recursive scan of each `modelDirs` entry; directories like `animatediff`, `wan_models`, hidden dirs are skipped; `.gguf`/`.safetensors` are classified by filename heuristics (`models.js:5`) into `text` / `image` / `video` / `aux`.

## Renderer architecture (`renderer/app.js`)

- **Init order matters**: `bindUI()` and `connectEvents()` run first, then data loading (`config → samplers → conversations → models → chat render`). Every data step is wrapped in try/catch; failures show a red `err-banner` instead of silently killing the UI. `window.__initDone` is set at the end; global `error`/`unhandledrejection` handlers record into `window.__errs` for debugging.
- **SSE**: `EventSource('/api/events')` with server-side `retry: 3000` for reconnect; engine log lines are capped at 500 DOM nodes.
- **State**: `config`, `localModels`, `conversations`, `activeConv` are module globals; conversations persist on every mutation.
- **Security**: CSP in `index.html` restricts to `'self'` (images/media allow `data:`/`blob:`); `contextIsolation: true`, `nodeIntegration: false` in the window.

## Data stores

- `config.json` — machine-specific engine paths and server settings; regenerated with defaults when missing; **gitignored**.
- `conversations.json` — full chat history, rewritten on each upsert/delete; **gitignored**.

## Resilience notes

- `render-process-gone` (GPU/GL crash on old cards) → window recreated after 1.5 s; server untouched.
- Renderer download buttons re-enable on failure; download restart handles stale entries.
- HF API 401s on datacenter IPs are worked around by scraping the public HTML tree page for file listings (sizes unavailable in HTML → shown as `?`).
