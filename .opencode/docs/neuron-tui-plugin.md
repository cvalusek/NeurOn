# NeurOn TUI panel plugin (`neuron-tui.tsx`)

OpenCode **TUI-side** plugin that shows a live NeurOn reservation panel in the
**right sidebar of the main session window** — model, target state,
reservation expiry (with live countdown), keepalive, cost estimate, and API
health. Collapsed by default to a one-line state + time chip; click the header
to expand.

Visual reference: [neuron-tui-preview.html](../docs/neuron-tui-preview.html)
(open in a browser).

The panel is a separate module from the server plugin
([neuron-server-plugin.md](./neuron-server-plugin.md)) because OpenCode
plugin modules are **target-exclusive** — a file cannot export both `server`
and `tui`. The two plugins share nothing in memory: the panel is
self-sufficient and reads the same control-plane API and `NEURON_*` env vars
directly (server and TUI run in the same local process).

## Where it renders

- Slot: `sidebar_content` (right sidebar of the session route), registered at
  `order: 110` so it stacks **below** the Token Usage panel (order 100) when
  both are installed.
- **Main window only** — the panel renders only for sessions whose
  `parentID` is undefined. Subagent sessions show nothing.
- One panel per session: each session shows its own model, target, and
  reservation.

```
sidebar (right)
┌──────────────────────────────────────────┐
│ ▼ Token Usage            $0.42 · 63%     │  ← token-meter (if installed)
├──────────────────────────────────────────┤
│ ▼ NeurOn                                │  ← collapsed: chip on this row
│   model    Small - Qwen 9B (litellm/…)  │     "▶ NeurOn  ● healthy · 11:32 left"
│   target state  healthy                 │
│   reservation   JtJgNhDYLU9b            │
│   expires     2:46:08 PM · 11:32 left   │
│   keepalive   5 min                     │
│   rate        $0.80 /hr                 │
│   cost        $0.43 left · $0.78 total  │
│   target      aws-ec2 · users: 1        │
│   session     ses_abc123 busy           │
│   api         ok · refreshed 2s ago     │
└──────────────────────────────────────────┘
```

## Panel content

### Collapsed (default) — state + remaining time

The chip is deliberately short (the header row shares the narrow sidebar
width); the model name lives on the expanded model row.

| Situation | Chip | Color (theme token) |
| --- | --- | --- |
| Healthy + reservation held | `● healthy · 11:32 left` | `success` |
| Healthy, no reservation | `● healthy · no reservation` | `success` |
| Starting / stopping | `● starting · no reservation` | `warning` |
| Stopped / cold / offline / failed | `● stopped · no reservation` | `error` |
| Non-NeurOn model (or provider not allowed) | `○ not managed` | `textMuted` |
| Control plane unreachable | `! unreachable` (+ ` (stale)` when showing last-known data) | `warning` |
| Target not yet resolved | `● unknown` | `textMuted` |

### Expanded rows

| Row | Source | Notes |
| --- | --- | --- |
| `model` | session model + API `displayName` | API name leads, opencode id in parentheses: `Small - Qwen 9B (litellm/g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL)`. Falls back to the raw id before the first successful fetch. For non-NeurOn models: a muted ` · not managed` suffix. |
| `target state` | `/api/status` target `observed` (+ `message`) | Colored by state level (healthy=success, starting/stopping/warming=pending=warning, stopped/cold/offline/error/failed=error). Managed models only — never shown for non-NeurOn models. |
| `reservation` | active reservation id | `none` when the session's target has no active reservation. For non-NeurOn models: muted `none for this model`, plus `(n active for other model(s))` when reservations for other models are active. |
| `expires` | reservation `expiresAt` | 12-hour wall clock **plus live countdown**: `2:46:08 PM · 11:32 left`. Tone: `accent` → `warning` under 2 min → `error` under 30 s. |
| `keepalive` | reservation `keepaliveMinutes` | Static configured window — not a countdown. |
| `rate` | `costEstimate.estimatedHourlyCostUsd` | `$0.80 /hr` (non-USD rendered as `0.80 EUR`). |
| `cost` | `costEstimate.projectedRemainingCostUsd` / `projectedTotalCostUsd` | `$0.43 left · $0.78 total`. Rows appear only when the reservation carries an estimate. |
| `target` | target `provider` + `activeUsers` | `aws-ec2 · users: 1` (the display name moved to the model row). |
| `session` | session id (truncated) + status | `ses_abc123 busy` / `idle`. |
| `api` | poll health | `ok · refreshed 2s ago` / `unreachable · stale`. |

**Non-NeurOn session models** (collapsed chip `○ not managed`): the
expanded panel shows the marked model row and the muted reservation note
(`none for this model` + count of the other models' active reservations) —
no `target state` row and no `expires` / `keepalive` / `rate` / `cost` rows.
A reservation that is active for *another* (managed) model is never picked
for an unmanaged session model and never renders its detail rows under it.
Managed models are unaffected: the reservation is picked exactly as before
(model-intersection → target filter → nearest `expiresAt`).

## Data flow

- **Polling** — `GET /api/status` every **2.5 s** with a 3 s
  `AbortController` timeout and an in-flight guard (no overlapping requests).
  `GET /api/models` is cached **60 s** (refetch on error).
- **Event-driven refresh** — re-render immediately on `session.status`,
  `session.idle`, `message.updated`, `session.created`, `tui.session.select`
  (the countdown is recomputed from `expiresAt` on every render, so ticks are
  at most ~2.5 s apart).
- **Failure posture** — an API error keeps the last known payload with a
  `stale` marker and a `! unreachable` chip; the render path never throws.
  Missing config (no `NEURON_API_KEY`) renders a muted
  `! NeurOn plugin not configured` line and skips polling entirely.

### Model resolution (mirrors the server plugin)

The session model id is matched against the `/api/models` catalog:

1. **Candidate names** — the full id plus each `/` suffix, longest first.
   Litellm route names carry a target prefix
   (`g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL`), so the bare catalog
   / runtime model name is a suffix of the session model id.
2. **Name keys** — each entry's `id`, `aliases`, `backendModelIds`, and
   `runtimeModelIds`, case-insensitive.
3. **Target selection** — when the leading segment of the id is one of the
   entry's `targetIds` (the litellm target prefix), that target wins;
   otherwise the entry's first target.
4. **Reservation pick** — reservations whose `modelIds` intersect the matched
   entry's full key set, then filtered by target, nearest `expiresAt` wins.
5. **Provider filter** — `NEURON_ALLOWED_PROVIDERS` gates everything: a
   session model whose provider (or `provider/model` string) is not in the
   list is treated as not managed before any catalog lookup. Same parsing and
   matching rules as the server plugin (`matchesAllowedProvider`).

## Configuration

Same env vars as the server plugin (read at plugin init from the shared local
process environment):

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEURON_API_KEY` | — (required for data) | Bearer key for the control plane. Missing → "not configured" line, no polling. |
| `NEURON_API_BASE_URL` | `http://localhost:8090` | Control-plane base URL. |
| `NEURON_ALLOWED_PROVIDERS` | (empty = all) | Only session models on these providers are shown as NeurOn-managed. |

## Installation

The TUI loader runs TSX natively (solid-js + `@opentui/solid` must be
resolvable from the plugin directory — the same `node_modules` that serves
other TUI plugins such as token-meter).

1. **Repo copy** (source of truth): `.opencode/plugins/neuron-tui.tsx` +
   `.opencode/plugins/neuron-tui/logic.js`.
2. **Active copy**: `~/.config/opencode/plugins/neuron-tui.tsx` +
   `~/.config/opencode/plugins/neuron-tui/logic.js`.
3. **Register** in `~/.config/opencode/tui.json`:

   ```json
   {
     "plugin": [
       "oh-my-opencode-slim",
       "./plugins/token-meter.tsx",
       "./plugins/neuron-tui.tsx"
     ]
   }
   ```

4. **Restart OpenCode.** TUI plugins are listed in `tui.json` (not the
   server `plugin` array in `opencode.json`).

### Sync protocol (repo → active)

```powershell
Copy-Item .opencode\plugins\neuron-tui.tsx  ~/.config/opencode/plugins/neuron-tui.tsx -Force
Copy-Item .opencode\plugins\neuron-tui\logic.js ~/.config/opencode/plugins/neuron-tui/logic.js -Force
# then verify SHA256 parity of both files
```

## Architecture

```
neuron-tui.tsx          TUI module (target-exclusive: exports { id, tui } only)
  ├── polling (2.5 s status, 60 s models, 3 s timeouts, in-flight guards)
  ├── model/target/reservation resolution (delegated to logic.js)
  └── sidebar_content slot (main-session gate, collapsed/expanded render)

neuron-tui/logic.js     pure, framework-free ESM JavaScript — the testable core
  ├── modelCandidates / matchModelEntry / resolveTargetForModel
  ├── pickReservation
  ├── parseAllowedProviders / isProviderAllowed
  ├── stateLevel / formatCountdown / formatClock (12-hour)
  └── summarizeNeuron  → { collapsed, level, rows }

test/neuron-tui.test.js node:test suite (runs with zero loaders)
```

`logic.js` is plain JavaScript (not TypeScript) on purpose: `node --test`
imports it with no loader, and the TSX imports it directly. `summarizeNeuron`
is deterministic — `now` and every payload field come from the input — so all
display decisions are unit-tested.

## Development

```bash
npm run build      # node --check plugins/neuron.js + plugins/neuron-tui/logic.js
npm test           # node --test test/*.test.js (server + TUI logic suites)
npm run check:tui  # esbuild TSX parse check of neuron-tui.tsx
```

The TUI logic suite covers model resolution (litellm route names, aliases,
runtime model ids, target-prefix preference), reservation picking, the
provider filter, state levels, countdown/clock formatting, and every display
state of `summarizeNeuron`.

The TSX itself is verified by the esbuild parse check plus the live TUI
(restart and inspect the sidebar); rendering behavior is covered by the
visual preview instead of unit tests.
