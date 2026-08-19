# PolarisStudio — Architecture (build 8)

## Overview

PolarisStudio is an Electron app whose main process doubles as a Node HTTP server. The UI is a plain HTML/JS renderer loaded over `http://127.0.0.1:9090` — there is **no IPC layer** between window and backend; the renderer talks to the server exactly like a browser would (fetch + EventSource). Engine binaries (llama-server, sd-server) are spawned as child processes and driven through their own local HTTP APIs. **Build 8 adds a single-port harness proxy on `9090/v1` (same port as vision), auto light/dark, KaTeX, remote harnesses, and harness keepAlive.**

```
┌───────────────────────────── Electron main process ─────────────────────────────┐
│                                                                                  │
│  main.js ── HTTP server :9090 (static + /api/* + /v1/* proxy + SSE /api/events)│
│    │  ▲                                ▲                                       │
│    │  │ child processes                │ proxy lib/config.js  config.json+harness│
│    │  ▼                                 ─────── lib/models.js  conversations.json│
│  lib/engines.js ── spawn/health/stop ──► llama-server :8080 (text, OpenAI API)  │
│    │   (9090/v1/* proxied with CORS)    sd-server  :7800  (image, A1111 API)    │
│    │                                    sd-server  :7801  (video, sd.cpp API)   │
│  lib/hf.js ── HTTPS ──► huggingface.co (search / tree scrape / resolve → CDN)    │
│                                                                                  │
└──────────┬───────────────────────────────────────────────────────────────────────┘
           │ fetch/SSE over http://127.0.0.1:9090 (no IPC)  ← also 0.0.0.0:9090 when LAN enabled
┌──────────▼───────────────────────────────────────────────────────────────────────┐
│  Renderer (Chromium window)                                                      │
│  renderer/index.html + app.js + style.css — vanilla JS, marked.min.js + KaTeX, │
│  auto light/dark (prefers-color-scheme / data-theme), palette, harness bar       │
└──────────────────────────────────────────────────────────────────────────────────┘
         ▲
         │ MCP stdio — mcp-server.js → POST 127.0.0.1:9090/api/vision
```

## Process model

- **Main process** owns: HTTP server (port 9090, now also `0.0.0.0:9090` when LAN harness enabled), the engine child processes, the download registry, SSE client set, config and conversation persistence.
- **Engines**: at most one child process runs at a time per type (text/image/video) **unless** `harness.keepAlive` keeps text alive when you start Image/Video (so opencode doesn’t cold-start). Otherwise VRAM arbitration stops the others first — 8 GB guard.
- **Harness (single port)**: `9090/v1/*` is **always** proxied to `127.0.0.1:8080` (`handleV1Proxy`, `ensureHarnessModel`, CORS). `8080` stays `127.0.0.1` internal; LAN clients use `http://<lan-ip>:9090/v1` (same port as UI + vision). `config.harness.{enabled,keepAlive,model}` defaults to on/keep/model-last-used. `config.server.enabled` now controls **LAN bind** for `9090` (`127.0.0.1` vs `0.0.0.0`), not llama-server’s host.
- **Remote harness (outbound, chat-only)**: `config.remotes[]` + `engines.text.provider/activeRemoteId`; `remoteChatStream()` forwards streaming to `http(s)://other-host/v1/chat/completions` with Bearer auth. Library → Remotes UI + Chat `Provider` select.
- **Headless mode**: closing the window does **not** quit the app (`window-all-closed` handler is intentionally empty). The server, engines, and downloads keep running; relaunching the app (or the `second-instance` handler) recreates the window. `before-quit` stops engines, aborts downloads, and closes the server.
- **Single instance**: `requestSingleInstanceLock()` — a second launch only opens a window.

## Engine lifecycle (`lib/engines.js`)

1. `start(modelPath, opts)` builds args (`lib/engines.js:90`), verifies binary and model exist, spawns, then polls the health endpoint (`/health` for text, `/sdapi/v1/options` for image/video) every 500 ms up to 180 s.
2. Two spawn attempts; on failure the last 15 log lines are surfaced as the error.
3. If the child exits with a bind error, the port is considered held by a stale process: `fuser -k <port>/tcp` is run and the caller retries.
4. `stop()` sends SIGTERM, escalates to SIGKILL after 8 s.
5. `argsFor` now maps `cacheTypeK/V` passthrough for TurboQuant (`q4_0_turbo`, `q8_0_turbo` — needs rebuilt llama.cpp) and logs `KV cache: …` in one-line low-VRAM summary.

Engine stdout/stderr is streamed to the renderer as `engine:log` SSE events and kept in a rolling buffer for error reporting.

## HTTP API (all JSON unless noted)

Served by `main.js`. GET requests are one-shot; POST bodies are JSON. Errors return `500 {"error": "..."}`; unknown routes return `404`. Harness proxy adds CORS (`Access-Control-Allow-Origin`).

| Route | Method | Purpose |
|-------|--------|---------|
| `/` , `/style.css`, `/app.js`, `/vendor/katex.min.js`, `/vendor/katex.min.css`, `/vendor/fonts/*.woff2` | GET | static UI (served with `Cache-Control: no-store` except fonts `max-age=86400`) |
| `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | GET/POST | **Harness proxy** — proxied to `127.0.0.1:8080` with CORS; `GET /v1/models` falls back to local GGUF list if no engine; chat auto-starts harness model if needed |
| `/api/events` | GET | SSE: `engine:log`, `dl:progress`, `dl:done`, `dl:error` |
| `/api/chat` | POST | stream a chat reply (SSE) — body `{modelPath, messages, opts:{ctx,temp,thinking,provider,remoteId,cacheTypeK}}` — `provider:remote` routes to `remoteChatStream` |
| `/api/config` | GET | current config (now includes `harness`, `remotes`, `ui.theme`) |
| `/api/config/save` | POST | merge + persist config (`config.json`) |
| `/api/harness/set`, `/api/harness/get` | POST/GET | set/get `harness:{enabled,keepAlive,model}` |
| `/api/remotes`, `/api/remotes/add`, `/api/remotes/remove`, `/api/remotes/set-active`, `/api/remotes/test` | GET/POST | remote harness CRUD + `GET /v1/models` probe |
| `/api/engines` | GET | status of all three engines (+ harness/remote annotation) |
| `/api/engine/start` | POST | start an engine — body `{type, modelPath, opts}`; respects `harness.keepAlive` (keeps text alive) |
| `/api/engine/stop` | POST | stop one engine — body `{type}` |
| `/api/models` | GET | recursive model list from `modelDirs` |
| `/api/models/delete` | POST | remove a model file |
| `/api/hf/search` | GET | HF model search — `?q=...` |
| `/api/hf/files` | GET | file list for a repo — `?repo=...` |
| `/api/hf/download` | POST | start/restart a download — `{repo, file, destDir}`; returns `{id}` |
| `/api/hf/abort` | POST | abort a download — `{id}` |
| `/api/server/set` | POST | toggle LAN harness (`0.0.0.0` vs `127.0.0.1` for 9090) + optional Bearer key — returns `{url, localUrl, lanUrl}` |
| `/api/images/generate` | POST | txt2img via sd-server |
| `/api/images/img2img` | POST | img2img via sd-server |
| `/api/video/generate` | POST | txt2vid (AnimateDiff, async job poll) |
| `/api/conversations` | GET | all conversations |
| `/api/conversations/save` | POST | upsert one conversation (now includes `systemPrompt`) |
| `/api/conversations/delete` | POST | delete one conversation |
| `/api/quit` | POST | quit the app |

## Data flows

### Chat (streaming) — local vs remote

- **Local:** Renderer → `POST /api/chat {provider:local}` → if engine not running, `engine.start()` (90–180 s budget, TurboQuant cache type forwarded) → forward to `llama-server /v1/chat/completions` with `stream:true`, `temperature`, `max_tokens`, `repeat_penalty:1.1`, `cacheTypeK/V`, and `chat_template_kwargs.enable_thinking` → main re-emits `{content}`/`{reasoning}` SSE → renderer streams into collapsible thinking `<details>` + markdown bubble with KaTeX + copy buttons.
- **Remote:** Renderer → `POST /api/chat {provider:remote, remoteId}` → `remoteChatStream(remote, messages)` → `https://other-host/v1/chat/completions` (Bearer if `apiKey`, same `enable_thinking`) → same SSE re-emit. No local VRAM arbitration for remote.
- **Harness (external client → Polaris):** `curl http://127.0.0.1:9090/v1/chat/completions` or opencode `baseUrl:http://<lan-ip>:9090/v1` → `handleV1Proxy` → if no engine, `ensureHarnessModel()` lazy-starts `harness.model` (or first text GGUF) → proxy with CORS → response streamed back. `GET /v1/models` returns OpenAI-shaped `{object:list, data:[{id,object:model}]}` from local GGUFs even before load.

### HuggingFace downloads (`lib/hf.js`)

1. `Download.start()` writes to `<dest>.part`, never the final name.
2. Existing `.part` size → `Range: bytes=N-` header (resume).
3. HF `/resolve/main/<file>` responds 302 → the URL is resolved manually (`followRedirects`, HEAD walk, ≤5 hops) to the CDN endpoint, then streamed with the range header.
4. A `416 Range Not Satisfiable` means the file is already complete → rename `.part` → done.
5. Progress events (`{bytes, total}`) are broadcast as `dl:progress`; completion as `dl:done`; each row now has a **Cancel** button → `POST /api/hf/abort`.
6. `downloads` is a Map keyed by `repo/file`. Re-POSTing the same id aborts the stale entry and restarts fresh. `/api/hf/abort` sets the `aborted` flag; the stream is destroyed and the partial `.part` remains for later resume.

### Model listing (`lib/models.js`)

Recursive scan of each `modelDirs` entry; directories like `animatediff`, `wan_models`, hidden dirs are skipped; `.gguf`/`.safetensors` are classified by filename heuristics (`models.js:5`) into `text` / `image` / `video` / `aux` + `moe` flag. Rendered with VRAM badge (`~need GB → fits/too big`) and active-model highlight.

## Renderer architecture (`renderer/app.js` + `style.css`)

- **Theme:** `applyTheme(theme)` + `initTheme()` + `updateHarnessBar()`; `document.documentElement[data-theme]` + `@media (prefers-color-scheme)` in `style.css:1`; `theme-toggle` persists to `config.ui.theme`; `sidebar.collapsed` via `◧` button.
- **KaTeX:** `md(s)` protects ``` blocks/inline code, renders `$$…$$`/`\[…\]` display and `$…$`/`\(…\)` inline via `katex.renderToString({throwOnError:false})`, then `marked.parse`. Fonts served from `vendor/fonts/` with `Cache-Control: public`.
- **Harness UI:** `serverbar` now `harness: 9090/v1` pill + `Keep loaded` (`#harness-keep` → `/api/harness/set`) + `Expose to LAN` (`#srv-enable` → `/api/server/set` rebinding `9090`) + `Copy opencode`/`Copy curl` via `copyText()` (clipboard + `execCommand` fallback + `prompt`).
- **Remotes:** `renderRemotes()` + `renderProviderSelect()` + `/api/remotes/*` CRUD.
- **Chat extras:** system prompt presets (`#sys-preset` → `#sys-prompt`), reasoning `<details>`, per-`pre` Copy, `Ctrl+K` palette (`PALETTE_ITEMS` + model list), conversation search (`#conv-search`) + export (`exportConv` to .md/.json), sidebar search, image history strip (`pushHistory` 8-thumb).
- **Clipboard:** `copyText(text)` helper (secure `writeText` → `execCommand` → `prompt`) used for harness, code blocks, and TTS autocopy — avoids `Write permission denied` unhandled rejections in Electron.
- **Init order matters**: `bindUI()` and `connectEvents()` run first, then data loading (`config → theme/harness/remotes → samplers → conversations → models → chat render`). Every data step is wrapped in try/catch; failures show a red `err-banner` instead of silently killing the UI. `window.__initDone` is set at the end; global `error`/`unhandledrejection` handlers record into `window.__errs` for debugging.
- **SSE**: `EventSource('/api/events')` with server-side `retry: 3000` for reconnect; engine log lines are capped at 500 DOM nodes.
- **State**: `config`, `localModels`, `conversations`, `activeConv`, `remotes`, `imageHistory` are module globals; conversations persist on every mutation (now include `systemPrompt`).
- **Security**: CSP in `index.html` restricts to `'self'` (images/media allow `data:`/`blob:`; `connect-src` now allows `http://127.0.0.1:*` `https://huggingface.co`; `style-src` allows `'unsafe-inline'` for KaTeX); `contextIsolation: true`, `nodeIntegration: false` in the window.

## Data stores

- `config.json` — machine-specific engine paths, `harness`, `remotes`, `ui.theme`, and server settings; regenerated with defaults when missing; **gitignored**.
- `conversations.json` — full chat history (now with `systemPrompt` per conversation), rewritten on each upsert/delete; **gitignored**.

## Resilience notes

- `render-process-gone` (GPU/GL crash on old cards) → window recreated after 1.5 s; server untouched.
- Renderer download buttons re-enable on failure; download restart handles stale entries; **Cancel** keeps `.part`.
- HF API 401s on datacenter IPs are worked around by scraping the public HTML tree page for file listings (sizes unavailable in HTML → shown as `?`).
- Harness `keepAlive` avoids cold-start for opencode; stale `9090`/`8080`/`7800` ports are `fuser -k`’d on next start.
- Clipboard fallback chain prevents `unhandled: Failed to execute 'writeText'` banners in Electron.
