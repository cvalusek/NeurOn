# opencode-neuron

OpenCode plugin for [NeurOn](https://github.com/cvalusek/NeurOn), a lightweight
control plane for shared self-hosted LLM capacity.

The plugin reserves NeurOn capacity for a session's model, blocks the request
only for genuine cold starts until the matching capacity target is healthy,
then keeps that reservation alive (via a keepalive timer, never per request)
while the session stays active, so capacity stays warm without stacking long
reservation tails.

A companion **TUI panel plugin** shows the reservation state in the sidebar.
The same reservation semantics are also ported to **Codex CLI** (launcher
wrapper + keeper coprocess) and the **pi coding agent** (extension with a
native input gate) — see [Other agent harnesses](#other-agent-harnesses).
Documentation: [server plugin](./docs/neuron-server-plugin.md) ·
[TUI panel plugin](./docs/neuron-tui-plugin.md) ·
[Codex CLI plugin](./docs/neuron-codex-plugin.md) ·
[pi extension](./docs/neuron-pi-plugin.md) ·
[panel visual preview](../docs/neuron-tui-preview.html).

The wait happens in OpenCode's awaited `chat.message` hook. A cold target does
not receive the model request and ask the user to retry later: the original
request remains pending until NeurOn reports readiness or the configured wait
times out.

## Install

Any one of these; all plugin sources load at OpenCode startup.

1. npm package — add it to `opencode.json`:

   ```json
   { "plugin": ["opencode-neuron"] }
   ```

   OpenCode installs npm plugins automatically (Bun, cached in
   `~/.cache/opencode/node_modules/`).

2. Project-local file — this repository ships the plugin at:

   ```text
   .opencode/plugins/neuron.js
   ```

   Files in `.opencode/plugins/` are auto-loaded for the project.

3. Global file — copy `neuron.js` to `~/.config/opencode/plugins/` to load it
   for every project.

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
| `NEURON_BLOCK_ON_COLD_MESSAGE` | `false` | `true`: fail fast with a "retry later" error on a cold/stopping target instead of blocking the message path until warm. |
| `NEURON_STRICT_PROVIDER_MATCH` | `false` | `true`: disable the single-target / single-provider fallbacks when mapping models to targets. |
| `NEURON_WARMUP_LOCK_TIMEOUT_MS` | `60000` | Time budget for waiting on another session's warmup of the same target during tool execution. |
| `NEURON_ALLOWED_PROVIDERS` | (empty = all) | Comma-separated provider filter; models outside the list are left alone. |
| `NEURON_USERNAME` | — | Pin the authenticated username for adoption scoping (otherwise resolved once per process via `GET /api/me`, memoized). |
| `NEURON_LOG_FILE` | `%USERPROFILE%\neuron-plugin.log` (Windows) or `$HOME/neuron-plugin.log` | Log file. |
| `NEURON_LOG_MAX_BYTES` | `5242880` | Rotate the log at this size; the old file is renamed to `.1`. |

Minimal configuration:

```env
NEURON_API_KEY=sk-neuron-...
```

If config fails to load (for example an invalid `NEURON_API_BASE_URL`), the
plugin logs the failure, shows an error toast, and installs no-op hooks —
OpenCode keeps working without any gating.

## Lifecycle behavior

- **Session created** — the plugin records the session's model only. It does not
  reserve or warm the target when a model is selected.
- **User message** (`message.updated`) — a preflight health check runs against
  the 3 s status cache; a stale or empty cache triggers one bounded live check
  within `NEURON_PREFLIGHT_TIMEOUT_MS` (timeout/error → fail open; live-cold →
  cold-start flow):
  - target healthy: **keepalive only** — activity is marked and the keepalive
    timer re-armed if it was stopped, but the reservation is never extended per
    message; the message is never held up by network I/O.
  - target unreachable: fail open — the message proceeds, a background reserve is
    attempted, and the failure is silent if it is a plain timeout.
  - target cold/stopped/stopping: a warning toast is shown once, a reservation is
    started, and the message path either blocks until the target is healthy
    (default, capped at `NEURON_WAIT_TIMEOUT_SECONDS`) or throws a "retry once
    warmup completes" error (`NEURON_BLOCK_ON_COLD_MESSAGE=true`).
- **Chat gate** (`chat.message`) — OpenCode awaits this hook before sending the
  chat completion. If the target is healthy the request proceeds (refresh in
  background); if it is unreachable the request fails open; if it is cold or
  stopping, the hook blocks on the shared warmup lock until the target is
  healthy or `NEURON_WAIT_TIMEOUT_SECONDS` elapses. A heartbeat toast
  ("NeurOn: still warming up…") fires every 30 s while the block is active,
  so a follower held behind the leader's lock gets progress feedback instead
  of a silent wait. It never throws — if warmup fails, the request proceeds so
  OpenCode surfaces the real error.
- **Tool execution** (`tool.execute.before`) — preflight with the same timeout
  budget. If the target is unhealthy, the hook waits on the shared warmup lock
  up to `NEURON_WARMUP_LOCK_TIMEOUT_MS`; if the target is still not healthy it
  starts a background reserve and throws so the caller retries later. If the
  API is unreachable it fails open and skips preflights for
  `NEURON_COOLDOWN_PERIOD_MS`.
- **Model switch** — switching between NeurOn models backgrounds cleanup of the
  old model's reservation and toasts an explanation with the most recent
  recorded failure (e.g. `last failure: AI_APICallError 502: Gateway Timeout`).
  If the old and new models map to the same capacity target (e.g. a different
  alias of the same model), the cleanup is skipped so the new model's warmup
  doesn't orphan a freshly-adopted reservation.
- **Session idle** — the session's keepalive timers are stopped **without a
  refresh**: the reservation is not extended, expires naturally, and the target
  is released. Returning within the reservation window is seamless (keepalive
  re-armed); returning after expiry re-establishes via the cold-start flow.
- **Session deleted** — all per-session state (reservations, inflight work,
  retries, keepalive timers) is released. Compaction does not clear state.

Reservation handling:

- Reservations are keyed per session and target. A live local reservation is
  kept; an active server-side reservation for the same target is adopted;
  otherwise one is created. Adoption is **owner-scoped**: the plugin resolves
  the authenticated username once per process (`GET /api/me`, memoized;
  `NEURON_USERNAME` pins it) and only adopts reservations owned by that user —
  the server-side extend/done APIs are owner-scoped, so a foreign lease would
  only produce 404 churn. An admin key adopts freely. When the username
  cannot be resolved (older control plane without `/api/me`, network blip)
  the plugin fails open and adopts as before.
- Extensions happen only from the keepalive timer (every `max(50% of
  lifetime, 30 s)`, activity-gated). Messages, tool runs, and chat requests
  never extend the reservation — they only mark activity.
- Creation retries with exponential backoff and jitter for transient errors
  (timeouts, HTTP 429, 5xx); permanent 4xx errors fail fast.
- With `NEURON_WAIT_FOR_HEALTHY`, the plugin polls the reservation status until
  every target reports `observed: healthy`; a `failed` target or a timeout is an
  error. Model warmup itself happens in NeurOn — the plugin only waits on the
  reservation's target states.
- A background keepalive timer extends each live reservation at half its
  effective lifetime, and stops (dropping the local entry) on a 4xx refresh
  failure.
- Multiple sessions warming the same target share one warmup: the first becomes
  the leader and the others queue behind it.
- The plugin never reserves capacity for its own traffic — models whose provider
  is `neuron`, `neuron-bridge`, or `opencode-neuron` are skipped.

## Commands

- **`/neuron-extend [minutes]`** — extends the session's active NeurOn
  reservation by N minutes (default: `NEURON_RESERVATION_DURATION_MINUTES`;
  the argument must be an integer 1–720). The extension is **additive** — the
  server computes `expiry = max(now, currentExpiry) + N`, so the command never
  shortens the remaining time. The server plugin handles the command natively
  via the `command.execute.before` hook (no LLM round-trip) and answers with
  the new wall-clock expiry. If the plugin is absent or unconfigured, the
  command degrades to a plain prompt that reports the reservation could not be
  extended. Install the command file at
  `~/.config/opencode/commands/neuron-extend.md` (global, matching the global
   plugin install); the source copy ships in this repo at
   `.opencode/commands/neuron-extend.md`.

- **`/neuron-done`** — ends the session's active reservation (same as the web
  UI "I'm Done" button). Takes no arguments. Clears local state and stops
  keepalive; a subsequent cold message creates a fresh reservation.
  Install the command file at
  `~/.config/opencode/commands/neuron-done.md`; the source copy ships in this
  repo at `.opencode/commands/neuron-done.md`.

## Other agent harnesses

The reservation client and policy live in a shared, harness-agnostic core
(`shared/neuron-core/`); each harness gets a thin adapter over it, so the
semantics (keepalive-only extension, additive manual extend, adopt-or-create,
no release calls) are identical everywhere. All three adapters are built into
single-file bundles with esbuild and installed with a copy + SHA256 parity
check.

| Harness | Surface | Install | Docs |
| --- | --- | --- | --- |
| OpenCode | server plugin (events) + TUI panel + `/neuron-extend` + `/neuron-done` command hooks | npm package, `.opencode/plugins/`, or global copy | [server plugin](./docs/neuron-server-plugin.md) · [TUI panel](./docs/neuron-tui-plugin.md) |
| Codex CLI 0.93.0 | launcher wrapper (pre-launch gate) + keeper coprocess (keepalive) + `neuron-extend` + `neuron-done` shell functions | `.codex/sync.ps1` / `sync.sh` → `~/.codex/neuron/` + profile aliases | [Codex CLI plugin](./docs/neuron-codex-plugin.md) |
| pi 0.74.2 | extension: `input` gate (cold start) + keepalive tick + native `/neuron-extend` + `/neuron-done` commands | copy `.pi/extensions/neuron/` → `~/.pi/agent/extensions/neuron/` | [pi extension](./docs/neuron-pi-plugin.md) |

Both ports are pinned to the installed versions (Codex 0.93.0 — its
lifecycle-hook system only exists from 0.114+; pi 0.74.2) and require no
upgrades.

## Model mapping

The plugin maps the OpenCode model (optionally in `provider/targetId/model`
form) to a NeurOn capacity target using `/api/status` and `/api/models`
(cached for 3 seconds):

1. NeurOn model lookup by model id, aliases, `backendModelIds`, or
   `runtimeModelIds`, preferring the target named by a `targetId/` segment or
   the requested provider.
2. Direct match against target `modelIds`.
3. Direct match where the config names the target id itself.

If a model is hosted by multiple providers and no provider is specified, the
plugin reports an ambiguous-mapping error instead of guessing.
`NEURON_ALLOWED_PROVIDERS` restricts which providers are considered, and
`NEURON_STRICT_PROVIDER_MATCH` disables the single-target fallbacks.

## Development

Declared npm scripts (run from this directory):

```bash
npm run build       # esbuild bundle of src/opencode-adapter.js + shared core → plugins/neuron.js, then node --check
npm test            # node --test test/*.test.js (core, server plugin, TUI logic, Codex adapter, pi adapter)
npm run check:tui   # esbuild TSX parse check of plugins/neuron-tui.tsx
npm run pack:check  # npm pack --dry-run
```

`plugins/neuron.js` is a build artifact (gitignored) — the source lives in
`src/opencode-adapter.js` plus `shared/neuron-core/`. The test suite covers
the shared core (config, client contracts, registry resolution, ensure flow,
keepalive policy), the OpenCode plugin (model mapping, cold-start flows,
stale-cache bounded live checks, keepalive-only refresh, model switches,
provider filtering, `/neuron-extend` hook), the TUI logic, and the Codex and
pi adapters.

In-depth documentation: [server plugin](./docs/neuron-server-plugin.md) ·
[TUI panel plugin](./docs/neuron-tui-plugin.md) ·
[Codex CLI plugin](./docs/neuron-codex-plugin.md) ·
[pi extension](./docs/neuron-pi-plugin.md).

## License

AGPL-3.0-only.
