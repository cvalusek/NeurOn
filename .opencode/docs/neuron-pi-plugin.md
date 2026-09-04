# NeurOn pi extension (`neuron-pi.js`)

Extension for the **pi coding agent** (`@earendil-works/pi-coding-agent`) that
ports the three NeurOn features — cold-start gate, activity-gated keepalive,
and the manual `/neuron-extend` command — to pi, with semantics identical to
the OpenCode reference plugin. It makes sure a managed model's capacity target
is reserved **before** any LLM traffic, keeps the reservation alive while the
session is active, and drops turns that cannot be reserved instead of letting
them race a cold target.

The reservation client and policy live in the shared core
(`shared/neuron-core/`, also consumed by the OpenCode and Codex adapters).
The pi adapter is a thin layer over it: `.pi/src/neuron-pi.js` in this repo,
bundled to one file and installed next to a 3-line `index.ts` loader
(see [Install](#install)).

**Version note** — targeted at installed **pi 0.74.2** (frozen; do not
upgrade). The core extension API used here — the awaited `input` hook with
`handled`, `registerCommand`, `ctx.isIdle()`, `session_shutdown` — is
identical from 0.73.1 through 0.84.4. Newer events such as `agent_settled`
(0.84.4+) are feature-detected: registered passively, never required.

## What it does, in one paragraph

When a session uses a model that NeurOn manages, the extension ensures an
active reservation for the resolved capacity target before pi sends the input
to the model: it adopts an existing reservation or creates one and waits
(bounded) for the target to report healthy. While the session has real
activity, a keepalive tick extends the reservation additively; on idle it
stops extending and the reservation expires naturally. Unlike the OpenCode
plugin's fail-open posture, the gate is **fail-closed**: a turn whose
reservation cannot be established is dropped (zero LLM traffic) with a
one-line explanation, because pi's `input` hook is the only pre-LLM
cancellation point and letting the turn through would silently bypass a
known-bad state. Unmanaged models are unaffected — they never cross the gate.

## Why this architecture

pi's extension API is the cleanest mapping of the three harnesses:

- The `input` hook is **awaited** before skill/template expansion and the
  agent loop, and returning `{action: "handled"}` discards the turn with
  **zero LLM traffic** — the only pre-LLM cancellation point in pi. OpenCode
  has no equivalent: its plugin approximates gating with an awaited
  `chat.message` hook plus preflight checks, and must fail open.
- `pi.registerCommand` is **native and LLM-free** — the command is checked
  before the `input` event, so `/neuron-extend` never burns a model turn
  (OpenCode's `command.execute.before` hook still runs an LLM turn after).
- Every signal the port needs exists: `session_start` / `session_shutdown`
  (reasons: startup/reload/new/resume/fork/quit), `model_select`
  (mid-session switches), `turn_start` / `turn_end`, `agent_start` /
  `agent_end`, and `ctx.isIdle()`.

**The throw trap.** An uncaught throw in an `input` handler is swallowed by
pi and the input **passes through** the gate — the exact failure the gate
exists to prevent. The entire handler body is therefore wrapped in try/catch:
any unexpected error becomes `ctx.ui.notify(…, "error")` +
`{action: "handled"}` (never silently passed through). No other registration
or handler may throw either; each is individually guarded.

## Cold-start gate (fail-closed)

Flow of the `input` handler:

1. `event.source === "extension"` → skipped (pi-internal plumbing).
2. No `ctx.model` → `continue` (nothing to gate; no API call).
3. Provider filter miss (`NEURON_ALLOWED_PROVIDERS`) → `continue` with
   **zero API calls**.
4. Managed candidate → the core's `ensureReservation` — adopt-or-create plus
   the bounded healthy wait:
   - one "still waiting" notice at **15 s** (soft);
    - hard cap `NEURON_WAIT_TIMEOUT_SECONDS`, default **40 s**;
   - success → `continue`;
   - control plane reachable but the model is **not in the registry** →
     `continue` (the model is served by its own provider; "not managed" is a
     property of the registry, not an error);
   - **timeout / unreachable / API error / target failure →
     `ctx.ui.notify(…, "error")` + `handled`** — the turn is dropped, zero
     LLM calls.
5. Any unexpected error → notify + `handled` (see
   [Why this architecture](#why-this-architecture)).

Reservation state is in memory, keyed per session id
(`ctx.sessionManager.getSessionId()`): pi runs one process = one session, and
`session_shutdown` scrubs it.

**Deliberate deviations from the plan** (both documented in the
[`.pi/README.md`](../../.pi/README.md)):

- **Missing `NEURON_API_KEY` → pass-through with a one-time notice.** An
  unconfigured plugin must not start dropping every managed-model turn over a
  config the user may not know about; no API call is made either way. (The
  OpenCode equivalent is fail-open for the same reason.)
- **Hard-wait default 40 s** (the core default is 600 s). The core's
  10-minute budget serves OpenCode's cooperative block, where the request may
   still race the warmup; the pi gate *drops* the turn, so the bounded wait
   stays short. `NEURON_WAIT_TIMEOUT_SECONDS` overrides.

**Shared-core semantics.** The ensure flow's decision branches live in
`shared/neuron-core/reservation.js`: a live local entry is refreshed;
otherwise the server is checked for a reservation another session made —
**"adopt remote + refresh"** — otherwise a new reservation is created
(bounded retries with exponential backoff + jitter; permanent 4xx fails
fast) and, with `NEURON_WAIT_FOR_HEALTHY`, waited on until every target
reports healthy. The adopt/keepalive refresh is a `fromNow: true` call with
`NEURON_RESERVATION_DURATION_MINUTES`: the server rolls the expiry to
`now + duration`, identical to the OpenCode plugin's keepalive refresh (so it
can shrink a long-remaining window down to the configured duration — the
verified live run adopted an OpenCode-created reservation and reset its expiry
to now+30 min). Manual `/neuron-extend` and the keepalive tick below are the
`fromNow: false` (additive, never shortens) paths.

## Keepalive

- `lastActivityAt` is stamped on `input`, `turn_start`, `agent_start`
  (liveness alone never counts as activity).
- A **5 s interval** is started on `session_start` and cleared on
  `session_shutdown` (which also scrubs the session).
- A tick extends **additively** (`fromNow: false`, duration =
  `NEURON_RESERVATION_DURATION_MINUTES`) only when the core policy says due:
  `now − lastExtend ≥ max(0.5·lifetime, 30 s)` **and** real activity since the
  last extend **and** still inside the keepalive grace window
  (`NEURON_RESERVATION_KEEPALIVE_MINUTES`).
- On idle it simply stops extending — the reservation expires naturally.
  **No release or teardown calls anywhere**; server expiry is authoritative.
- Settle signal: `agent_settled` when present (0.84.4+), else `agent_end` +
  `ctx.isIdle()` polling — never required.

## Model switches

`model_select` re-resolves the target for the new model (bounded status read,
background) and updates the session's pointer. It does **not** reserve
eagerly — the next `input` gate adopts or creates for the new target. The
previous model's reservation is left to expire naturally (not released).

## Install

Installed layout (pi 0.74.2 autoloads `~/.pi/agent/extensions/*/index.ts`;
no trust gate):

```
~/.pi/agent/extensions/neuron/
  index.ts       # 3-line loader: re-exports the sibling bundle
  neuron-pi.js   # the esbuild bundle (core + adapter), renamed from dist/
```

pi transpiles `index.ts` on the fly with **jiti** (no compile step). The two
files must stay siblings — `index.ts` imports `./neuron-pi.js`, so re-copy
both on every sync.

```powershell
# from the repo root:
npx --yes esbuild .pi/src/neuron-pi.js --bundle --format=esm --platform=node --outfile=.pi/dist/neuron-pi.js
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\extensions\neuron" | Out-Null
Copy-Item .pi\extensions\neuron\index.ts "$env:USERPROFILE\.pi\agent\extensions\neuron\index.ts"
Copy-Item .pi\dist\neuron-pi.js "$env:USERPROFILE\.pi\agent\extensions\neuron\neuron-pi.js"
```

Then `/reload` in a running pi session (or restart pi). `pi --no-extensions`
disables extension discovery entirely (diagnostic flag — with it the gate is
off). A `neuron-pi: loaded (baseUrl=…)` line in the log file (see
[Logging](#logging)) confirms the extension registered.

### Environment variables

Read at extension load; same semantics as the OpenCode plugin.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEURON_API_BASE_URL` | `http://localhost:8090` | Control-plane base URL. Must start with `http://` or `https://`. |
| `NEURON_API_KEY` | — | `sk-neuron-...` key, sent as `Authorization: Bearer`. Missing → inputs pass through (one-time notice); `/neuron-extend` reports `plugin not configured`. |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | Duration sent on create; the additive amount for keepalive ticks and `/neuron-extend`. |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `40` | **Hard** gate wait in seconds (the core's bounded healthy-wait deadline; same variable as the OpenCode plugin). The gate nudges once at 15 s. |
| `NEURON_ALLOWED_PROVIDERS` | (empty = all) | Comma-separated provider filter; models outside the list skip the gate with zero API calls. |
| `NEURON_LOG_FILE` | `%USERPROFILE%\neuron-pi.log` (Windows) or `$HOME/neuron-pi.log` | Log file. |
| `NEURON_LOG_MAX_BYTES` | `5242880` | Rotate the log at this size; the old file is renamed to `.1`. |

Other core knobs (`NEURON_RESERVATION_KEEPALIVE_MINUTES`,
`NEURON_WAIT_FOR_HEALTHY`, `NEURON_WAIT_POLL_SECONDS`,
`NEURON_PREFLIGHT_TIMEOUT_MS`, …) are honored through the shared core.

## Manual extension (`/neuron-extend`)

`pi.registerCommand("neuron-extend", …)` — **native and LLM-free**: the
command is checked before the `input` event, so no model turn ever runs for
it.

- **Argument** — `minutes` integer 1–720, else
  `NEURON_RESERVATION_DURATION_MINUTES` (default 2). Bad input →
  `NeurOn: usage: /neuron-extend [minutes 1-720]`, no API call.
- **Gate/resolution** — same as the input path: session model → provider
  filter → bounded status read (preflight budget) → registry match → adopt
  the active reservation (local entry first, then server-side).
- **Semantics — additive.** The extend is sent with `fromNow: false`, so the
  server computes `expiry = max(now, currentExpiry) + N`; the command can
  never shorten the remaining time.
- **Success notice** (exact): `NeurOn: reservation <id> extended to
  <HH:MM:SS AM/PM> (+N min)` — the clock is the core's `formatClock` applied
  to the refreshed `expiresAt`.
- **Precondition failures** — one-line notice, no API call: `NeurOn: plugin
  not configured`, `NeurOn: no session model recorded yet`, `NeurOn: <model>
  is not managed`, `NeurOn: control plane unreachable — try again`, `NeurOn:
  no active reservation — send a message to start one`. A server 400/404
  becomes `NeurOn: extend rejected — <server error message>`; a transport
  failure or timeout becomes the unreachable notice.
- **Keepalive interaction** — running the command counts as activity: the
  refreshed reservation is saved locally (re-aiming the keepalive tick), so a
  still-busy session keeps extending; if the session then goes idle the
  reservation still expires naturally. The command only bought more time.

## Logging

Diagnostics go to a **log file, never the terminal** — pi renders extension
stderr between turns, and the per-message gate lines would be noise there.
Default: `%USERPROFILE%\neuron-pi.log` (Windows) / `$HOME/neuron-pi.log`
(Unix); `NEURON_LOG_FILE` overrides the path, `NEURON_LOG_MAX_BYTES` the
rotation size (5 MB default; old file → `.1`). Every line is an ISO timestamp
+ `neuron-pi: …` (core decision lines are routed through the same logger).

The **terminal** shows only:

- the one-time `NeurOn: still waiting for target capacity (up to Ns)`
  warning while a cold-start hold is in progress;
- gate-failure errors (timeout / unreachable / API error — the ones paired
  with `handled`, i.e. the dropped turn);
- the `/neuron-extend` success line, its per-precondition notices, and the
  usage line;
- the one-time missing-`NEURON_API_KEY` notice.

In headless runs (no `ctx.ui`) even those notices go to the log file. Watch
the log live with `Get-Content $HOME\neuron-pi.log -Wait` (Windows) or
`tail -f $HOME/neuron-pi.log` (Unix).

A headless run on a managed model
(`pi -p --no-session "Reply with exactly: ok"`, with
`NEURON_WAIT_TIMEOUT_SECONDS=600` to match the OpenCode 10-minute budget)
produced this log-file content (the turn's own output — `ok` in that run —
goes to the terminal as usual):

```
neuron-pi: loaded (baseUrl=https://epd-neuron.sandbox.benefitsgo.tech, allowedProviders=[litellm] or all, hardWait=600000ms)
neuron-pi: session_start: reason=startup session=01a051c5-c922-7673-…
neuron-pi: resolve target success: model=litellm/g6.xlarge.qwen-9b/… targetId=g6.xlarge.qwen-9b observed=healthy
neuron-pi: reservation decision: refresh local targetId=g6.xlarge.qwen-9b session=01a051c5-… reservationId=yTwHVthdxC9x
neuron-pi: input gate: ensured session=01a051c5-… model=litellm/g6.xlarge.qwen-9b/…
neuron-pi: session_shutdown: reason=quit session=01a051c5-…
```

The `reservation decision:` line is the core's branch label
(`shared/neuron-core/reservation.js`) — `refresh local` for a live local
entry, `adopt remote+refresh` when adopting another session's reservation,
`create new reservation` otherwise. Other notable lines: `input gate:
not managed …`, `input gate: dropping turn … error=…`, `keepalive extend:
session=… reservationId=… fromNow=false`, `keepalive extend fail: …`,
`model_select: target re-resolved model=… targetId=…`, `command extend:
session=… minutes=… fromNow=false result=ok|rejected_<status>|unreachable`.

## Development

```bash
cd .opencode
npm test        # node --test test/*.test.js — includes test/neuron-pi.test.js (23 tests)
```

- **Tests** — `.opencode/test/neuron-pi.test.js` (picked up by the existing
  `npm test`; no `package.json` changes): stubbed pi ExtensionAPI (capturing
  `on` / `registerCommand`), stubbed ctx (`model`, `isIdle()`, `ui.notify`
  capture, `sessionManager.getSessionId()`), and a fake-fetch route table for
  the core. Keepalive tests drive the tick directly through the adapter's
  `__test` export (`reset` / `sessions` / `state` / `tick`) — deterministic,
  no 5 s waits. The export is inert at runtime: pi only consumes the default
  export.
- **Bundle** — from `.pi/`:
  `npx --yes esbuild src/neuron-pi.js --bundle --format=esm --platform=node --outfile=dist/neuron-pi.js`,
  then `node --check dist/neuron-pi.js`. `dist/` is gitignored; the install
  step copies the artifact.

## v1 notes

- One process = one session; all state is in-memory per session id
  (`session_shutdown` scrubs it).
- Session-granular keepalive: switching models does not release the old
  model's reservation — it expires naturally.
- Headless `pi -p` loads user-global extensions and the gate (verified
  live); `/neuron-extend` is available in both interactive and headless
  contexts, though only interactive has a `ctx.ui` to render the notice.

See also: [server plugin (OpenCode)](./neuron-server-plugin.md) ·
[TUI panel plugin](./neuron-tui-plugin.md) ·
[Codex CLI plugin](./neuron-codex-plugin.md)
