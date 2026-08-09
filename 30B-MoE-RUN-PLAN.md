# 30B MoE on 8 GB VRAM — run plan (Qwen3-30B-A3B on PolarisStudio)

Reference for running a 30B-A3B MoE model on this machine. Context: YouTube video
"8F_5pdcD3HY" (t=770s) shows the recipe on an i3-8100 + 6 GB card, 17 t/s.

## Machine facts (measured)

| Resource | Value |
|---|---|
| GPU | AMD RX 580 2048SP, 8 GB VRAM (Vulkan/radv, Mesa 26.1.5) |
| CPU | i5-7500T, 4C/4T, 2.7 GHz base / 3.3 GHz boost, AVX2 |
| RAM | 16 GB total (DDR4), ~10.6 GB available at rest |
| Swap | 15.5 GB zram (compressed RAM-backed) |
| Disk (models) | /mnt/backup = 2.5" HDD (sda4, ST1000LM035, ~100 MB/s) |
| SSD | /dev/sdc2 btrfs, 23 GB free — holds /home |
| llama.cpp | master @ a6aa6f545 (2026-08-04) |

## Model facts (parsed from the GGUF)

- File: `Qwen3-30B-A3B-Claude-4.5-Opus-High-Reasoning-2507-ABLITERATED-UNCENSORED-V2.Q4_K_M.gguf` (18.4 GB)
- Architecture: qwen3moe — 48 blocks, 64 experts, 8 active, hidden 2048
- Expert weights ≈ 62% of total; ~0.24 GB per expert-layer at Q4_K_M
- Attention + shared + embeddings ≈ sub-1 GB total → fits GPU trivially once experts are offloaded

## Why Q4_K_M cannot run here

1. ngl=99 on 18.4 GB with 8 GB VRAM → Vulkan OOM at allocation.
   `failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort`
   is llama.cpp's auto-fit bailing (warning, benign) — the real failure is the GPU alloc.
2. MoE CPU sweep 0→10 did nothing: only 10/48 expert layers moved (~2.4 GB freed),
   GPU still needed ~16 GB → same crash. The trick only starts working at (near) full offload.
3. Even fully offloaded, 18.4 GB weights > 16 GB RAM → `--no-mmap` impossible, mmap path
   page-cache-evicts mid-generation (disk re-reads every token). RAM is the wall, not VRAM.

## The video's 5 tricks → mapping on this box

| Trick | Video | On this machine |
|---|---|---|
| MoE offload | active parts GPU, sleeping experts RAM/CPU | UI "MoE CPU" slider → `--n-cpu-moe N` (per-session, MoE models only). Q2: N≈28 keeps ~20 expert layers on GPU; Q3: N≈38; Q4: N=48 (all) |
| `--no-mmap` | whole model resident in RAM, no page faults mid-token | UI checkbox (chat toolbar). Deprecated-but-working in this llama.cpp (`--load-mode` is the new name). Only fits models ≤ ~11 GB usable RAM |
| GPU balancing | ngl tuned until VRAM nearly full | Keep ngl=99 default; VRAM split: attention ~0.5 GB + KV + compute, remainder holds expert layers |
| TurboQuant (`--turbo-4`/`--turbo-3`) | 4-bit K / 3-bit V cache → 256K ctx | NOT in this llama.cpp build (verified: no "turbo" in common/arg.cpp). Use KV cache `q8_0` via UI select, keep ctx modest |
| `--mlock` | pin weights in RAM | UI checkbox; pair with no-mmap |

## Corrected speed math

- Per token: 3.3 B active params × 2 FLOPs = 6.6 GFLOP. File size is irrelevant at gen time.
- i3-8100 @ 3.6 GHz AVX2 int8 kernels ≈ 100–130 GFLOP/s effective → ~60 ms/token → 17 t/s = its compute ceiling (video number checks out, no magic).
- This box (7500T, 3.3 GHz, ~10% slower) forecasts:
  - Q2_K + ~20 expert layers GPU + no-mmap + mlock + KV q8_0: **10–14 t/s**
  - Q3_K_S + ~10 layers GPU, same recipe: **8–12 t/s**
  - Q4_K_M all-CPU + mmap: 3–5 t/s with stutter (RAM-bound) — not worth it
- 9B Qwen3.5-heretic Q4 fully GPU: 20–40 t/s — still the daily driver.

## Quant ladder (30B-A3B, stock sizes)

| Quant | Size | Note |
|---|---|---|
| Q2_K | 10.91 GB | fits RAM cleanly; "very low quality but surprisingly usable" |
| Q2_K_L | 11.21 GB | Q8 embeds/output; slightly better; recommended test pick |
| Q3_K_S | 13.3 GB | noticeably better, tighter RAM fit |
| Q4_K_M | 18.4 GB | current file — RAM-blocked on this box |

15 GB RAM constraint → only Q2 family fits with headroom; Q3_K_S works but maxes RAM.
The exact finetune has no Q2/Q3 published — closest is bartowski `Qwen3-30B-A3B-Thinking-2507` GGUF.
Do NOT locally re-quantize Q4→Q2 (double-quant damage > native Q2).

## Test procedure (when ready — do not download yet)

1. Calibrate CPU first: `llama-bench -m /mnt/backup/llm-models/qwen2.5-0.5b-instruct-q4_k_m.gguf -p 32 -n 32`
   (small model, seconds; gives real local GFLOPS/t/s reference).
2. Download chosen quant to a new SSD dir `/home/llm-models` (23 GB free fits ONE file).
   Use PolarisStudio HF tab or `curl -L -C -`.
3. Add `/home/llm-models` to `config.json` `modelDirs`.
4. In UI chat toolbar: select model → MoE CPU = 28 (Q2) / 38 (Q3) →
   tick no-mmap + mlock → KV cache q8_0 → Start engine.
5. Eager load reads the whole file (~40–60 s from SSD; startTimeout now 180 s, see below).
6. Watch `free -h` during prefill; if OOM/pressure: drop ctx 8192→4096 or raise MoE CPU.

## Implemented so far (options only — no model work)

- `lib/engines.js`: `startTimeout` 90 s → 180 s (covers eager no-mmap loads + HDD first-touch).
- All tuning knobs (MoE CPU, no-mmap, mlock, KV cache, ctx/temp) already exist per-session in the UI.

## Open decisions

- Test quant: Q2_K_L (default) vs imatrix Q2_K vs Q3_K_S
- Accept base "Thinking-2507" in place of the exact abliterated finetune
- TurboQuant unavailable in current llama.cpp; revisit on llama.cpp update