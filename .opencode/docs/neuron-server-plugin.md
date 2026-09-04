# NeurOn server plugin (`neuron.js`)

OpenCode **server-side** plugin for [NeurOn](https://github.com/cvalusek/NeurOn),
the control plane for shared self-hosted LLM capacity. It reserves capacity for
a session's model, blocks requests only for genuine cold starts, keeps
reservations alive while a session is active, and explains model switches to
the user.

A separate **TUI panel plugin** (`neuron-tui.tsx`) displays the reservation
state in the sidebar — see [neuron-tui-plugin.md](./neuron-tui-plugin.md).
The two plugins are independent modules (OpenCode plugin modules are
target-exclusive: a file cannot export both `server` and `tui`) and share only
the control-plane API and the `NEURON_*` environment variables.

## What it does, in one paragraph

When a session uses a model that NeurOn manages, the plugin makes sure the
matching capacity target is on and healthy **before** the session sends
meaningful traffic, holds a reservation for the duration of real activity, and
releases capacity when the session goes idle. Everything is fail-open: a
control-plane problem degrades to "no gating" rather than breaking OpenCode.

## Configuration

All configuration is via environment variables read at plugin init.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEURON_API_KEY` | — (required) | `sk-neuron-...` key, sent as `Authorization: Bearer` on every call. |
| `NEURON_API_BASE_URL` | `http://localhost:8090` | Control-plane base URL. Must start with `http://` or `https://`. |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | Reservation duration sent on create. |
| `NEURON_RESERVATION_KEEPALIVE_MINUTES` | `2` | Keepalive duration sent on create. |
| `NEURON_WAIT_FOR_HEALTHY` | `true` | After creating a reservation, poll until all its targets report healthy. |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `600` | Cap on the healthy-wait (and on warmup blocking). |
| `NEURON_WAIT_POLL_SECONDS` | `5` | Reservation status poll interval. |
| `NEURON_REQUEST_TIMEOUT_MS` | `8000` | Per-request timeout for NeurOn API calls. |
| `NEURON_PREFLIGHT_TIMEOUT_MS` | `2000` | Budget for the health preflight before messages and tools. |
| `NEURON_COOLDOWN_PERIOD_MS` | `30000` | Skip tool preflights after a transport failure to the API. |
| `NEURON_RETRY_MAX_ATTEMPTS` | `3` | Bounded retries when creating reservations. |
| `NEURON_RETRY_BASE_MS` | `1000` | Base delay for exponential backoff (with jitter). |
| `NEURON_RETRY_MAX_MS` | `8000` | Backoff cap. |
| `NEURON_BLOCK_ON_COLD_MESSAGE` | `false` | `true`: fail fast with a "retry later" error on a cold/stopped/stopping target instead of blocking the message path until warm. |
| `NEURON_STRICT_PROVIDER_MATCH` | `false` | `true`: disable the single-target / single-provider fallbacks when mapping models to targets. |
| `NEURON_WARMUP_LOCK_TIMEOUT_MS` | `60000` | Time budget for waiting on another session's warmup of the same target during tool execution. |
| `NEURON_ALLOWED_PROVIDERS` | (empty = all) | Comma-separated provider filter; models outside the list are left alone (see [Provider filter](#provider-filter)). |
| `NEURON_LOG_FILE` | `%USERPROFILE%\neuron-plugin.log` (Windows) or `$HOME/neuron-plugin.log` | Log file. |
| `NEURON_LOG_MAX_BYTES` | `5242880` | Rotate the log at this size; the old file is renamed to `.1`. |

Minimal configuration:

```env
NEURON_API_KEY=sk-neuron-...
```

If config fails to load (for example an invalid `NEURON_API_BASE_URL`), the
plugin logs the failure, shows an error toast, and installs no-op hooks —
OpenCode keeps working without any gating.

## Status cache and preflight

`GET /api/status` is cached for **3 s** (`statusCacheTTL`). Preflight on the
hot paths (`message.updated`, `tool.execute.before`, `chat.message`) works in
two tiers:

1. **Fresh cache** (≤ 3 s old) — zero network I/O; the cached state decides.
2. **Stale or empty cache** — one **bounded live check**: a live status fetch
   raced against `NEURON_PREFLIGHT_TIMEOUT_MS` (`getLiveStatus`).
   - The live fetch lands a fresh state (even a cold one) → decide from it.
     A stale check that finds the target **cold engages the cold-start flow**.
   - The fetch times out or errors → state is `unknown` → **fail open**
     (the request proceeds; the in-flight response still lands in the cache
     for the next preflight).

The model-switch toast path uses a cached-only lookup
(`getTargetStateNow`) because it runs in a synchronous context where a
network call is not appropriate.

Target states: `healthy` (proceed), `cold` / `stopped` / `stopping`
(cold-start flow), everything else (`unknown`) fails open.

## Cold-start flow

The only intentional blocking path. Triggered by a message when a managed model's target is
`cold`, `stopped`, or `stopping`:

1. A warmup reservation is started (or adopted) under the **shared warmup
   lock** — multiple sessions warming the same target share one warmup; the
   first becomes the leader and the others queue behind it.
2. A toast tells the user what is happening (once per target, with a
   cooldown), then the request blocks until every target of the reservation
   reports `observed: healthy`.
3. The block is capped at `NEURON_WAIT_TIMEOUT_SECONDS` (default 10 min).
4. `chat.message` never throws from this path — if warmup fails or times out,
   the request proceeds so OpenCode surfaces the real model error.
5. `NEURON_BLOCK_ON_COLD_MESSAGE=true` swaps step 3 for a fast "retry once
   warmup completes" error on the message path (background warmup still runs).

## Reservation lifecycle (keepalive-only)

Reservations are keyed per session and target.

- **Establish** — during the cold-start message flow, a locally live reservation is kept; an active server-side
  reservation for the same target is **adopted**; otherwise one is created
  (bounded retries with exponential backoff + jitter for timeouts/429/5xx;
  permanent 4xx fails fast).
- **Active work = keepalive only** — user messages, tool runs, and chat
  requests on a healthy target **never extend the reservation**. They mark
  activity and re-arm the keepalive timer *only if it was stopped*. This was
  a deliberate policy change: per-message `extend { fromNow: true }` calls
  used to reset the expiry countdown on every message.
- **Keepalive timer** — the sole periodic extender. It ticks every
  `max(50% of reservation lifetime, 30 s)` and extends only while the session
  has real activity within the keepalive grace window. On inactivity it stops
  without a refresh. A 4xx refresh failure stops the timer and drops the
  local entry.
- **Session idle** — the plugin **stops** the session's keepalive timers
  without any refresh call. The reservation is not extended: it expires
  naturally and the target is released.
- **Returning to a session** — within the reservation window the keepalive is
  re-armed and work continues seamlessly; after the reservation expired the
  next message re-establishes (adopt/create) through the warmup flow, i.e. it
  cold-starts.

With `NEURON_WAIT_FOR_HEALTHY`, the plugin polls the reservation status until
every target reports `observed: healthy`; a `failed` target or a timeout is an
error. Model warmup itself happens in NeurOn — the plugin only waits on the
reservation's target states.

## Manual extension (`/neuron-extend`)

The custom command `/neuron-extend [minutes]` extends the session's active
reservation **on demand** — the one deliberate exception to the keepalive-only
policy. It is handled natively by the `command.execute.before` hook (no LLM
round-trip): the hook performs the API call and replaces the command's parts
with a single status line,
`NeurOn: reservation <id> extended to <HH:MM:SS AM/PM> (+<n> min)`.

- **Semantics — additive.** The extend call is sent with `fromNow: false`, so
  the server computes `expiry = max(now, currentExpiry) + N`. The command can
  never shorten the remaining time (a `fromNow: true` reset was rejected
  because the 2-minute default would replace, e.g., 5 remaining minutes with
  2). The keepalive's `refreshReservation` keeps its own `fromNow: true`
  semantics — the two paths share the endpoint but never each other's payload.
- **Argument handling** — `N` is the argument if given, else
  `NEURON_RESERVATION_DURATION_MINUTES`. An argument must be an integer in
  1–720 (the server enforces the same range); anything else yields
  `NeurOn: usage: /neuron-extend [minutes 1-720]` with no API call.
- **Scope** — the command operates on the session's recorded model (the same
  per-session model state as the message path), gated by
  `NEURON_ALLOWED_PROVIDERS`, resolved through the normal model→target
  mapping, and requires an **active** reservation for that target (the same
  adoption lookup the message path uses; a bounded live status read with the
  preflight budget).
- **Edge cases** — each precondition failure replaces the parts with a
  one-line explanation instead of an API call: `NeurOn: plugin not
  configured`, `NeurOn: no session model recorded yet`, `NeurOn: <model> is
  not managed`, `NeurOn: no active reservation — send a message to start
  one`. A server 400/404 becomes `NeurOn: extend rejected — <server error
  message>`; a transport failure or timeout becomes `NeurOn: control plane
  unreachable — try again`. The hook never throws, and never touches commands
  other than `neuron-extend` (other commands' parts are left untouched).
- **Keepalive interaction** — running the command is activity: the refreshed
  reservation is saved locally, which re-arms the keepalive timer
  (`restart=true`), exactly like a create/adopt/extend. Nothing else changes:
  if the session goes idle afterwards the keepalive still stops without a
  refresh and the reservation expires naturally — the command only bought
  more time.
- **Command file** — `commands/neuron-extend.md` (shipped with the package;
  install to `~/.config/opencode/commands/neuron-extend.md` for global use).
  Its body is a fallback prompt for when the plugin is absent: with the
  plugin installed, the hook replaces the parts before any LLM call.

## Manual end (`/neuron-done`)

The custom command `/neuron-done` marks the session's active reservation
**done** server-side — the same endpoint the web UI "I'm Done" button calls
(`POST /api/reservations/:id/done`). It is handled natively by the
`command.execute.before` hook (no LLM round-trip) and replaces the command's
parts with `NeurOn: reservation <id> ended`.

- **Semantics — terminal.** Unlike `/neuron-extend` (which re-arms keepalive),
  `/neuron-done` disarms it: the local reservation entry is deleted, the
  keepalive timer is cancelled, and inflight keys are cleared. A subsequent
  cold message in the same session will create a fresh reservation.
- **No arguments.** The command takes no arguments (unlike `/neuron-extend`
  which accepts minutes).
- **Scope** — same as `/neuron-extend`: the session's recorded model, gated by
  `NEURON_ALLOWED_PROVIDERS`, resolved through the normal model→target
  mapping, and requires an **active** reservation for that target.
- **Edge cases** — same pattern: `NeurOn: plugin not configured`, `NeurOn: no
  session model recorded yet`, `NeurOn: <model> is not managed`, `NeurOn: no
  active reservation to end`. A server 400/404 becomes `NeurOn: end rejected —
  <server error message>`; a transport failure becomes `NeurOn: control plane
  unreachable — try again`. The hook never throws.
- **Command file** — `commands/neuron-done.md` (shipped with the package;
  install to `~/.config/opencode/commands/neuron-done.md` for global use).

## Model switches

When a session's model changes between two NeurOn-managed models (or away
from one), the plugin:

- backgrounds cleanup/release of the **old** model's reservation without
  blocking the event path, and
- toasts an explanation with the most recent recorded failure context:
  `NeurOn: model switched old → new — last failure: Name status: message`
  (from `session.error` / retry `session.status` events within a 2-minute
  window; neutral wording when no failure was recorded). Toasts are cooldown-
  gated (60 s); the log always carries the `recentFailure=` detail.

## Event handling

| Event | Behavior |
| --- | --- |
| `session.created` | Record the session model; start background warmup (reserve + wait for healthy) so the target is usually ready before the first message. |
| `message.updated` | Preflight (cache, else bounded live check). Healthy: keepalive-only (mark activity, re-arm timer if stopped) — never blocks on network. Unreachable: fail open. Cold/stopped/stopping: cold-start flow. |
| `chat.message` | Same tiers; non-throwing. Blocks on the shared warmup lock only for cold starts. |
| `tool.execute.before` | Preflight with the same budget; unhealthy → wait on the warmup lock up to `NEURON_WARMUP_LOCK_TIMEOUT_MS`, then background reserve + throw so the caller retries later. Unreachable → fail open + tool preflight cooldown (`NEURON_COOLDOWN_PERIOD_MS`). |
| `session.status busy` | Mark activity; re-arm stopped keepalive timers for the session's live reservations (no extend). |
| `session.idle` | Stop the session's keepalive timers without refresh; the reservation expires naturally. |
| `session.error` / retry statuses | Record failure context for model-switch explanations. |
| `session.deleted` | Release all per-session state (reservations, inflight work, retries, keepalive timers). Compaction does not clear state. |

## Provider filter

`NEURON_ALLOWED_PROVIDERS` (comma-separated, case-insensitive) restricts which
OpenCode providers are treated as NeurOn-managed. Matching
(`matchesAllowedProvider`):

- empty list → every provider is managed;
- a provider id is present → it must be in the list;
- no provider id → the model string must start with `provider/`.

Models outside the list are ignored entirely (no reservations, no preflights,
no toasts). Example: with `NEURON_ALLOWED_PROVIDERS=litellm`, local
`homellm` (llama.cpp) sessions are never gated even if a local model name
collides with a NeurOn catalog alias. Models served by the plugin's own
providers (`neuron`, `neuron-bridge`, `opencode-neuron`) are always skipped —
the plugin never reserves capacity for its own traffic.

## Model mapping

The plugin maps the OpenCode model (optionally in `provider/targetId/model`
form) to a NeurOn capacity target using `/api/status` and `/api/models`
(cached 3 s):

1. **Model lookup** by every name key — model id, `aliases`,
   `backendModelIds`, `runtimeModelIds` — against the full id **and each `/`
   suffix** (litellm route names carry a `targetId/` prefix, so the bare
   runtime model name is a suffix). The target named by the leading segment is
   preferred, then the requested provider.
2. **Direct target `modelIds` match** (try each candidate).
3. **Direct target-id match** (config names the target itself).

If a model is hosted by multiple providers and no provider is specified, the
plugin reports an ambiguous-mapping error instead of guessing.
`NEURON_ALLOWED_PROVIDERS` restricts which providers are considered, and
`NEURON_STRICT_PROVIDER_MATCH` disables the single-target fallbacks.

## Failure posture

Everything fails open toward "no gating":

- API unreachable on a hot path → request proceeds, background reserve
  attempted, silent on plain timeouts (tool paths add a cooldown).
- Warmup failure/timeout in `chat.message` → request proceeds so OpenCode
  surfaces the real model error.
- Config failure → no-op hooks + error toast.
- Reservation refresh 4xx → timer stopped, local entry dropped; the next
  activity re-establishes.

## Logging

Appends to `NEURON_LOG_FILE` (rotated at `NEURON_LOG_MAX_BYTES`, old file
renamed `.1`). Notable lines:

- `plugin init: allowedProviders=... baseUrl=...`
- `allowed-provider skip: provider=... model=... allowed=...`
- `message.updated user preflight ... targetState=...` / `... keepalive-only:`
- `keepalive stopped (idle)`
- `model switch: ... recentFailure=...`
- `command extend: session=... minutes=... fromNow=false result=ok|<error>`

## Development

```bash
npm run build        # node --check plugins/neuron.js (+ TUI logic.js)
npm test             # node --test test/*.test.js (server plugin suite)
npm run pack:check   # npm pack --dry-run
```

The server-plugin test suite covers cold-start flows, stale-cache bounded
live checks (unreachable/hang/cold), keepalive-only refresh behavior,
model-switch cleanup and toasts, provider filtering, and the `/neuron-extend`
command hook (argument validation, additive payload, rejection/unreachable
parts, local state + keepalive re-arm, never-throw). `npm run build` is a
plain syntax check.

See also: [TUI panel plugin](./neuron-tui-plugin.md) ·
[Codex CLI plugin](./neuron-codex-plugin.md) ·
[pi extension](./neuron-pi-plugin.md) ·
original design plan ·
TUI panel plan ·
[Codex/pi port plan](./plans/2026-08-29-003-neuron-codex-pi-port-plan.md)
