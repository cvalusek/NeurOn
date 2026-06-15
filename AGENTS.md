# AGENTS.md

Context for AI agents (and future humans) working on this repo. This
captures decisions and rationale that aren't visible from the files alone —
read this before changing presets, the Dockerfile, or the detection scripts.

## Project overview

llama.cpp router containers for self-hosted LLM inference, primarily for
RunPod. `docker/multiple-moe/` hosts three models — gemma-4-26B-A4B,
Qwen3.6-35B-A3B, and GLM-4.7-Flash-REAP-23B-A3B — via `llama-server`'s router
mode, with models downloaded from Hugging Face on first start.

## Conventions

- **Preset naming**: `presets/<N>gb.ini`, where `N` is a VRAM tier in GB.
  `detect-preset.sh` picks the largest tier that fits the detected GPU's
  total VRAM (falling back to the smallest tier if VRAM is below all of
  them). Adding a new tier (e.g. `16gb.ini`) requires no changes to the
  detection script.
- **Router model id naming**: `<model>-<context>` where context is the
  approximate ctx-size in "k" (e.g. `gemma-4-26b-a4b-64k`,
  `glm-4.7-flash-reap-23b-a3b-198k`). Ids should reflect the *actual*
  ctx-size, not a historical/arbitrary label.
- **Shared defaults use `[*]`**, not per-section duplication. A per-section
  "common defaults" convention (duplicating `[*]`'s values into every model
  section, with `[*]` commented out as documentation) was tried and
  reverted — it didn't avoid the phantom "default" model entry (see below)
  and added maintenance burden for no benefit.
- **No comments inside `.ini` files** (deliberate preference). Rationale for
  any non-obvious value lives in this file instead.
- `mmap = false` is set on any preset where `n-cpu-moe > 0` — combining
  mmap with CPU-offloaded MoE tensors triggers a llama.cpp performance
  warning.
- `sleep-idle-seconds = 1800` is set on `12gb.ini`/`8gb.ini` only.
  `96gb.ini` deliberately omits it (not needed with that much headroom).

## Base image

Pinned to `ghcr.io/ggml-org/llama.cpp:server-cuda-b9592`, **not** the rolling
`server-cuda` tag. Builds around the gemma4-assistant MTP merge (#23398,
~b9549, merged 2026-06-07) were unstable; b9592 was confirmed working
(gemma's MTP draft loads, web UI serves correctly).

To bump this pin: rebuild with `--pull` against a candidate tag, then verify
on actual hardware that (1) the web UI loads at `/` and (2) gemma's draft
model (`mtp-gemma-4-26B-A4B-it.gguf`) loads without an
`unknown model architecture: 'gemma4-assistant'` error before changing the
`FROM` line.

## Known upstream llama.cpp issues (not fixable via our config)

- **#22364** — router synthesizes a phantom `"default"` model entry in
  `/v1/models` regardless of whether `[*]`/`default-model` are used.
  Apparently cosmetic (`status: unloaded`), but if real models stop loading
  under `models-max=1`, check whether this entry is consuming a slot.
- **#21375 / #21338 / #22786** — cluster of Gemma 4 thinking+tool-calling
  bugs in llama-server's `peg-gemma4` chat format: infinite repetition loops
  where the model never exits a `<|tool_call>` block. #21418 (merged
  2026-04-04) fixed the original #21375 case and should be included in
  b9592 — but looping has still been observed on b9592, possibly a new
  regression from the June 7 MTP merge interacting with
  tool-calling+reasoning. Mitigated (not fixed) via DRY sampling (see
  below). If still problematic: try `reasoning = off` for gemma (known
  workaround, loses thinking output), or test with `spec-type`/`model-draft`
  removed from gemma to isolate whether MTP is the trigger.
- **GLM tokenizer warnings** (`special_eot_id`/`special_eom_id` not in
  `special_eog_ids`) — known issue across GLM-4.x GGUFs. Generation usually
  still stops correctly via other EOG tokens (e.g. `<|user|>`), but "breaks
  sometimes". If this persists: try `temp = 0.6` (down from `0.7`) on GLM,
  or as a deeper fix, patch the GGUF's tokenizer metadata with
  `gguf-set-metadata.py`.
- **#19379** — `sleep-idle-seconds` leaves ~600MiB resident on the idle
  subprocess (doesn't fully terminate it). With `models-max=1` on
  `12gb.ini`/`8gb.ini`, this is bounded to at most one subprocess and gets
  cleaned up on the next model switch via LRU eviction — not considered a
  real problem here.
- **#20137 / #21678** — `models-max` LRU eviction has TOCTOU races and
  doesn't check for in-flight requests before evicting. Acceptable for
  single-developer use ("these are dev tools, not 5 nines").

## DRY sampling

`dry-multiplier = 0.8`, `dry-base = 1.75`, `dry-allowed-length = 24` are set
globally (in every preset's `[*]`) as a mitigation for repetition loops,
particularly Gemma 4's tool-calling loop issue (see above). `allowed_length`
was deliberately raised from DRY's "chat" default of `2` to `24` — at `2`,
DRY penalizes *any* 3+ token verbatim repeat, which corrupted agentic output
(an agent re-typing the same file path or identifier across tool calls would
get penalized into producing a near-neighbor token instead — e.g. `repos`
becoming `Repositories`). At `24`, short identifiers/paths repeat freely,
while a genuinely looping sequence still gets exponentially penalized after
~24 tokens (`0.8 × 1.75^(n-24)`), which is a tight enough bound in practice.
Caveats: DRY prevents loops from *forming*, it can't break one already in
progress (so a max-tokens cap is still the real backstop for worst-case
cost). Default sequence breakers (`\n`, `:`, `"`, `*`) are common in JSON
tool-call syntax and may reduce DRY's effectiveness for that specific case —
if loops persist on gemma tool calls despite DRY, consider
`dry-sequence-breaker = none` (or dropping `:`/`"` from the breaker set) for
gemma specifically.

## Qwen sampling: `presence-penalty`

Qwen3.6's official recommendation is `presence_penalty = 1.5` (alongside
`temp=1.0, top_p=0.95, top_k=20`) to avoid loops in long reasoning — but
presence penalty applies to *every* token seen so far in the context,
regardless of whether repeating it is a loop or legitimate verbatim reuse
(e.g. an agent re-typing the same file path). This is a documented tension
in the Qwen community itself, not unique to our setup. Since the
`dry-allowed-length = 24` change above covers the same "long reasoning loop"
failure mode more precisely (only penalizing actual repeated *sequences*,
not all repeated tokens), Qwen's `presence-penalty` was set to `0.0` across
all presets, relying on DRY instead. If long-reasoning loops reappear on
Qwen without presence_penalty, that'd be the first thing to revisit —
either raise `presence-penalty` back up (accepting the agentic-output risk)
or tune DRY further before doing so.

## `n-cpu-moe` tuning status

- **`96gb.ini`**: `n-cpu-moe = 0` for all three models — confirmed working
  (all three load and generate correctly).
- **`12gb.ini`**: `gemma-4-26b-a4b-64k` (`n-cpu-moe=12`) and
  `glm-4.7-flash-reap-23b-a3b-64k` (`n-cpu-moe=12`) are confirmed working on
  actual Titan X Pascal hardware (GLM measured at ~21 tok/s).
  `qwen3.6-35b-a3b-64k` (`n-cpu-moe=18`) was confirmed loading and working
  but "slow" *before* `mmap=false` was added — worth retesting now that
  mmap is disabled. The four `-256k`/`-198k` variants (`n-cpu-moe` 20/26/18)
  are **heuristic guesses** (scaled from the 64k values by context-size
  ratio), untested.
- **`8gb.ini`**: **entirely heuristic** — all six `n-cpu-moe` values are
  scaled from `12gb.ini`'s numbers by a rough 33% VRAM-reduction factor.
  Nothing here has been tested on real 8GB hardware (GTX 1070) yet.

## Download / Hugging Face specifics

- Uses the `hf` CLI (not the deprecated `huggingface-cli`).
- `HF_HOME=/models` so the HF cache/staging directory shares the model
  volume (avoids filling the container's ephemeral filesystem, and survives
  restarts).
- Qwen's actual GGUF filename is `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` — no
  `-MTP-` in the filename despite the repo being named
  `Qwen3.6-35B-A3B-MTP-GGUF`. The MTP layer is embedded in this file (no
  separate `model-draft`).
- Gemma's MTP draft (`mtp-gemma-4-26B-A4B-it.gguf`) downloads flat into the
  repo's root directory, not under an `MTP/` subfolder.
- **gemma-4-E2B/E4B** (added for speed — same family, 2B/4B "effective
  params", 128K max context): filenames
  `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` / `gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf`
  are assumed by analogy with the 26B-A4B naming pattern, **not yet verified
  on disk**. The `--include "*UD-Q4_K_XL*"` glob should match regardless of
  minor naming differences, but the exact `model =` path in the presets
  could be wrong until a real download confirms it.

  **MTP for these two is the highest-risk, least-verified part of this
  config.** Without MTP, E2B/E4B were observed to be significantly
  out-throughput by the 26B-A4B (which has MTP) despite being much larger —
  so MTP isn't optional polish here, it's the point of including these
  models at all. The current config assumes MTP is embedded in the main
  `UD-Q4_K_XL.gguf` (same pattern as Qwen3.6, no separate `model-draft`),
  via `spec-type = draft-mtp` + `spec-draft-n-max = 4` +
  `flash-attn = off` (overriding `[*]`'s `on`, per unsloth's documented E4B
  MTP command).

  Unsloth's Gemma 4 qat-GGUF repos are in *very* active flux around MTP
  right now — files and folder structure (root-level `mtp-gemma-4-*-it.gguf`
  vs an `MTP/` subfolder vs embedded) have been renamed/reorganized multiple
  times within days, confirmed by checking 26B-A4B's repo directly (its
  root-level 252MB `mtp-gemma-4-26B-A4B-it.gguf` drafter was added within
  the last hour at the time of checking). E2B/E4B may or may not have
  reached the same state yet.

  **If `spec-type = draft-mtp` causes E2B/E4B to fail loading** (likely if
  the GGUF has no embedded MTP tensors), the fix is *not* to just remove
  `spec-type` — per the above, that makes these models not worth running.
  Instead: check `unsloth/gemma-4-E{2,4}B-it-qat-GGUF` directly for whatever
  the current MTP drafter situation is (root-level `mtp-gemma-4-E{2,4}B-it.gguf`,
  an `MTP/` subfolder with a differently-named/precision file, or genuinely
  not yet available for these sizes), and either point `model-draft` at the
  correct file, download from the `MTP/` subfolder, or — if MTP truly isn't
  available yet for E2B/E4B — hold off on these two entries entirely until
  it lands, rather than shipping them in a state that's "not worth running."

## Testing

There's no automated test suite — all verification so far has been manual,
on actual GPU hardware (a Blackwell-class ~96GB card and a Titan X Pascal
12GB card). Useful manual checks:

- `docker compose config` — verify env var resolution (especially
  `LLAMA_ARG_MODELS_PRESET`/`LLAMA_ARG_MODELS_MAX`) before `up`.
- `docker compose run --rm multiple-moe /download-models.sh` — pre-warm the
  model cache without starting the GPU server.
- `GET /v1/models` and a minimal `POST /v1/chat/completions` per model id —
  confirm a preset's models load and respond.

If adding an automated smoke test, it would need to run on a GPU host (no
CPU-only fallback is practical given model sizes) — not currently set up in
CI.