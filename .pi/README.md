# NeurOn pi extension

Ports the three NeurOn features — cold-start gate, keepalive extend, and the
manual `/neuron-extend` command — to the **pi coding agent (0.74.2, frozen)**,
with semantics identical to the OpenCode reference plugin
(`.opencode/plugins/neuron.js`). The reservation client + policy live in
`shared/neuron-core/` (shared by all three harness adapters); this directory
holds the pi adapter, its thin TypeScript loader, and the esbuild bundle.

## Repo layout

```
.pi/
  src/neuron-pi.js          # the adapter (plain ESM, imports shared/neuron-core)
  extensions/neuron/index.ts # thin loader (re-exports the sibling bundle)
  dist/neuron-pi.js         # esbuild bundle (gitignored; built on demand)
  README.md
```

## Install

1. Build the bundle (from this directory):

   ```powershell
   npx --yes esbuild src/neuron-pi.js --bundle --format=esm --platform=node --outfile=dist/neuron-pi.js
   ```

2. Copy the **two files** into pi's user-global extension dir (pi 0.74.2
   autoloads `~/.pi/agent/extensions/*/index.ts`; no trust gate):

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\extensions\neuron" | Out-Null
   Copy-Item .pi\extensions\neuron\index.ts "$env:USERPROFILE\.pi\agent\extensions\neuron\index.ts"
   Copy-Item .pi\dist\neuron-pi.js "$env:USERPROFILE\.pi\agent\extensions\neuron\neuron-pi.js"
   ```

   The installed dir is exactly `{ index.ts, neuron-pi.js }` — the bundle
   renamed from `dist/neuron-pi.js` to sit next to the loader. `index.ts`
   imports the **sibling** `./neuron-pi.js`, so the two files must stay
   together (re-copy both on every sync).

3. In a running pi session: `/reload` (or restart pi). A `neuron-pi: loaded
   (baseUrl=…)` line in the log file (see [Logging](#logging)) confirms the
   extension registered.

## Environment variables

Same semantics as the OpenCode plugin (read at extension load):

| Variable | Default | Meaning |
|---|---|---|
| `NEURON_API_BASE_URL` | `http://localhost:8090` | NeurOn control-plane base URL |
| `NEURON_API_KEY` | — | Bearer key for the control plane. Missing → inputs pass through (one-time notice); `/neuron-extend` reports "plugin not configured" |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | Reservation duration for create + keepalive/manual extend amounts |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `40` | **Hard** gate wait in seconds (the core's bounded healthy-wait deadline; same variable as the OpenCode plugin). The gate also nudges once at 15 s |
| `NEURON_ALLOWED_PROVIDERS` | (all) | Comma-separated provider filter (e.g. `litellm`). Disallowed providers skip the gate with **zero** API calls |
| `NEURON_USERNAME` | — | Pin the authenticated username for adoption scoping (otherwise resolved once per process via `GET /api/me`, memoized) |
| `NEURON_LOG_FILE` | `%USERPROFILE%\neuron-pi.log` (Windows) or `$HOME/neuron-pi.log` | Log file. |
| `NEURON_LOG_MAX_BYTES` | `5242880` | Rotate the log at this size; the old file is renamed to `.1`. |

Other core knobs (`NEURON_RESERVATION_KEEPALIVE_MINUTES`,
`NEURON_WAIT_FOR_HEALTHY`, `NEURON_WAIT_POLL_SECONDS`,
`NEURON_PREFLIGHT_TIMEOUT_MS`, …) are honored through the shared core.

## Behavior

### Cold-start gate (fail-closed)

pi awaits the `input` hook before any LLM traffic; `{action:"handled"}`
discards the turn with **zero LLM calls** — the only pre-LLM cancellation
point.

1. `event.source === "extension"` → skipped (internal plumbing).
2. No `ctx.model` → `continue` (nothing to gate, no API call).
3. Provider filter miss → `continue` (**no API call**).
4. Managed candidate → `ensureReservation` (adopt-or-create + bounded healthy
    wait, hard cap `NEURON_WAIT_TIMEOUT_SECONDS`, default 40 s; one "still waiting"
   notice at 15 s):
   - success → `continue`;
   - control plane reachable but the model is **not in the registry** →
     `continue` (the model is served by its own provider);
   - **timeout / unreachable / API error / target failure →
     `ctx.ui.notify(…, "error")` + `handled`** (turn dropped).
5. Any unexpected error inside the handler → notify + `handled`. The whole
   body is try/caught **on purpose**: pi swallows uncaught handler throws and
   would let the input pass through the gate silently.

**Config failure behavior:** A *missing* config (no `NEURON_API_BASE_URL`)
legitimately deactivates the plugin — a one-time log notice, silent
pass-through. A *malformed* config (URL present but not http/https, e.g. a
typo like `http:/localhost:8090`) is **loud**: an ERROR-level log line
(`CONFIG ERROR: … — gate is DISABLED`) plus a one-time `ui.notify` error on
the first input turn, so a typo can't silently degrade the plugin to a no-op.
The `/neuron-extend` command reports the misconfiguration specifically.

**Why fail-closed on unreachable (vs. the OpenCode plugin's fail-open):** in
OpenCode the request still goes out and surfaces its own error; in pi the
input hook is the *only* pre-LLM gate, so a turn that cannot be reserved must
not silently bypass a known-bad state — dropping it with a one-line
explanation is the consistent choice. Unmanaged models are unaffected (they
never cross the gate).

### Keepalive

- `lastActivityAt` is stamped on `input`, `turn_start`, `agent_start`.
- A **5 s interval** is started on `session_start` (reasons: startup/reload/
  new/resume/fork) and cleared on `session_shutdown` (reasons: …/quit), which
  also scrubs all per-session state.
- Each tick extends **additively** (`fromNow:false`, duration =
  `NEURON_RESERVATION_DURATION_MINUTES`) only when the core policy says due:
  `now − lastExtend ≥ max(0.5·lifetime, 30 s)` **and** real activity since the
  last extend **and** still inside the keepalive grace window.
- On idle, it simply stops extending — the reservation expires naturally.
  **No release/teardown calls anywhere.**
- `agent_settled` (pi ≥ 0.84.4) is feature-detected (passive registration; it
  simply never fires on 0.74.2) as the settle signal; on 0.74.2 settle is
  derived from `agent_end` + `ctx.isIdle()` polling. It is never required.

### Model switches

`model_select` re-resolves the target for the new model (bounded status read,
background) and updates the session pointer. It does **not** reserve
eagerly — the next `input` gate adopts or creates. The previous model's
local reservation entry is dropped from `state.reservations` (the server-side
reservation expires naturally). This keeps the local map tracking only the
live pointer, preventing stale entries from accumulating on rapid
model-switching.

### `/neuron-extend [minutes]`

Registered via `pi.registerCommand` — **native and LLM-free** (checked before
the `input` event; the only LLM-free command surface in pi).

- `minutes`: integer 1–720, else the configured default
  (`NEURON_RESERVATION_DURATION_MINUTES`, default 2). Bad input → usage
  notice, no API call.
- Same gate/resolution as the input path: session model → provider filter →
  bounded status read → registry match → adopt the active reservation
  (local entry first, then server-side).
- The extend is **additive** (`fromNow:false`): the server computes
  `expiry = max(now, currentExpiry) + N`, so the command never shortens the
  remaining time.
- Success notice (exact format):
  `NeurOn: reservation <id> extended to <HH:MM:SS AM/PM> (+N min)` — the
  clock is the core's `formatClock` applied to the refreshed `expiresAt`.
- Each precondition failure is a one-line notice with no API call:
  `plugin not configured` / `no session model recorded yet` /
  `<model> is not managed` / `control plane unreachable — try again` /
  `no active reservation — send a message to start one`.

### `/neuron-done`

Registered via `pi.registerCommand` — **native and LLM-free**.

- No arguments. Marks the session's active reservation done server-side
  (same endpoint the web UI "I'm Done" button calls).
- Same gate/resolution as `/neuron-extend`: session model → provider filter →
  bounded status read → registry match → find the active reservation.
- On success: the local reservation entry is deleted and the keepalive timer
  is cleared. A subsequent cold message creates a fresh reservation.
- Success notice: `NeurOn: reservation <id> ended`.
- Each precondition failure is a one-line notice with no API call:
  `plugin not configured` / `no session model recorded yet` /
  `<model> is not managed` / `control plane unreachable — try again` /
  `no active reservation to end`.

## Logging

All diagnostics go to a log file, never the terminal (pi renders extension
stderr between turns, and the per-message gate lines are noise there).
Default: `%USERPROFILE%\neuron-pi.log` (Windows) / `$HOME/neuron-pi.log`
(Unix); `NEURON_LOG_FILE` overrides the path, `NEURON_LOG_MAX_BYTES` the
rotation size (5 MB default, old file → `.1`). Every line is an ISO
timestamp + `neuron-pi: …`.

The terminal shows only:

- the one-time `NeurOn: still waiting for target capacity (up to Ns)`
  warning while a cold-start hold is in progress;
- gate-failure errors (timeout / unreachable / API error — the ones paired
  with `handled`, i.e. the dropped turn);
- `/neuron-extend` and `/neuron-done` results (success line, per-precondition notices, usage);
- the one-time missing-`NEURON_API_KEY` notice.

In headless runs (no `ctx.ui`) even those notices go to the log file.

Watch it live:

```powershell
Get-Content $HOME\neuron-pi.log -Wait   # Unix: tail -f $HOME/neuron-pi.log
```

## Mapping to the OpenCode plugin

| OpenCode (`.opencode/plugins/neuron.js`) | pi (this extension) |
|---|---|
| `chat.message` hook (awaited, blocks the request) | `pi.on("input")` (awaited; `handled` drops the turn) |
| Fail-open on unreachable (request races warmup) | **Fail-closed** on unreachable (`handled`) |
| Per-reservation countdown `setInterval` (50% lifetime) | One 5 s per-session interval; core `isExtendDue` policy per tick |
| `session.idle` / busy-status grace window | `agent_end` / `agent_settled` (feature-detected) + `ctx.isIdle()` polling; same core grace window |
| `command.execute.before` hook (LLM still runs; parts replaced) | `pi.registerCommand` (truly native, LLM-free) |
| `session.deleted` scrub | `session_shutdown` scrub |
| Warmup toasts on `ctx.client.tui.showToast` | `ctx.ui.notify` (guarded by `ctx.hasUI`) |
| `plugins/neuron.js` bundle installed by copy | `neuron-pi.js` bundle + `index.ts` installed by copy |

The shared core (`shared/neuron-core/`) is unchanged: config loading,
`NeurOnClient`, registry resolution, ensure-reservation (adopt-or-create +
bounded wait), keepalive policy arithmetic, `formatClock`.

## Verification

Unit tests (stubbed pi ExtensionAPI + ctx, fake fetch):

```powershell
cd .opencode
npm test   # node --test test/*.test.js — includes test/neuron-pi.test.js
```

Live (against the real control plane + litellm):

1. Confirm the extension loaded: `neuron-pi: loaded (baseUrl=…)` in the log
   file (see Logging), or `/neuron-extend` answering in the TUI.
2. Headless one-shot on a managed (litellm) model:
   `pi -p "Reply with exactly: ok"` — watch the control-plane log /
   `GET /api/status` (with the API key) for the reservation being adopted or
   created for the target before the turn completes.
3. Interactive: send a message on a cold model (gate waits, notifies at 15 s
   if still waiting), then `/neuron-extend 5` and check the new wall-clock
   expiry; idle for > the grace window and confirm no further extends
   (reservation expires naturally).
4. Model switch mid-session (`/model` → another litellm route): next message
   gates on the new target; the old reservation is not extended.

## Troubleshooting

- **Extension not loading** → `/reload` in the TUI (hot-reloads
  `~/.pi/agent/extensions/`); check that `index.ts` and `neuron-pi.js` are
  **siblings** in the same dir; `pi --no-extensions` disables extension
  discovery entirely (diagnostic flag — with it the gate is off).
- **`index.ts` errors** → pi transpiles it on the fly with jiti; keep it the
  3-line re-export (the bundle is plain ESM, `--platform=node`).
- **Turns dropped with `NeurOn: …`** → the gate failed closed (timeout /
   unreachable / API error). Fix the control-plane reachability or raise
   `NEURON_WAIT_TIMEOUT_SECONDS`. Unmanaged models are never dropped by the gate.
- **Nothing happens** → check `NEURON_API_BASE_URL` / `NEURON_API_KEY` are
  set in the environment pi starts in, and that `NEURON_ALLOWED_PROVIDERS`
  matches the model's provider (default: all providers).
- **Gate failing but the terminal is quiet** → the drop reason is in the log
  file: `input gate: dropping turn … error=…` (see Logging). The terminal
  only shows warnings, errors, and `/neuron-extend` results.

## v1 notes

- Targets installed **pi 0.74.2 exactly** (frozen); newer pi features
  (`agent_settled`) are feature-detected, never required.
- One process = one session: all state is in-memory per session id
  (`ctx.sessionManager.getSessionId()`); `session_shutdown` scrubs it.
- The hard gate wait defaults to 40 s (vs. OpenCode's 10-minute cooperative
  block) because the pi gate drops the turn rather than letting it race the
  warmup.
- Session-granular keepalive: if the model is switched, the old model's
  reservation is not released — it expires naturally.
