# NeurOn Codex CLI adapter (`.codex/`)

NeurOn reservation gate for the [Codex CLI](https://github.com/openai/codex)
**0.93.0**: a launcher wrapper that reserves capacity for the launch model
*before* any model traffic, a detached **keeper** coprocess that keeps the
reservation alive while the codex process runs, and a deterministic
`neuron-extend` shell command for manual extension. On the current install
(Codex **0.151.0**) the same gate runs instead as Codex **lifecycle hooks** —
see [`.codex/README.md`](../.codex/README.md) for the full hook-mode reference;
this wrapper is retained as a documented fallback (it works on both versions).
All NeurOn logic lives in
one bundled Node CLI (`neuron-codex.js`); the PowerShell/POSIX launchers are
thin. The adapter shares `shared/neuron-core` with the
[server plugin](./neuron-server-plugin.md) — identical reservation semantics,
different process model. Install details: [`.codex/README.md`](../.codex/README.md)
(source of truth for install/config).

## What it does, in one paragraph

On Codex, **one session = one launch**. When you start `codex` with a model
NeurOn manages, the wrapper makes sure the matching capacity target is on and
healthy *before* codex starts, then a background keeper extends the
reservation on a fixed cadence for as long as the codex process is alive.
When codex exits, the keeper exits and the reservation is left to expire
naturally — there is no release call. Unmanaged models, an absent config, and
a control plane that is simply unreachable all degrade to "launch codex
anyway"; only a *known* reservation failure (rejection, timeout) blocks the
launch.

## Version constraint

Installed Codex is **0.151.0** (upgraded from 0.93.0 on 2026-08-30; the local
litellm provider now uses `wire_api = "responses"`). **Hook mode is the
installed primary mode:** `UserPromptSubmit` gate / `PostToolUse` keepalive /
`SessionStart` prewarm + the MCP `neuron_extend` tool (see [Upgrade
path](#upgrade-path) and [`.codex/README.md`](../.codex/README.md)). The
**0.93.0 wrapper launcher is retained as a documented fallback** — it works on
both versions; rollback = restore the config backup
(`~/.codex/backups/2026-08-30-pre-0151/`) + `npm i -g @openai/codex@0.93.0`.

## Why this architecture

0.93.0 exposes almost no deterministic extension surface:

- **No lifecycle hooks** (they landed 0.114–0.124) → no in-process per-turn
  gate is possible, so the gate moves to **launch time**, where it is fully
  deterministic: the wrapper decides before codex exists.
- **`notify` is not usable headless.** 0.93.0 accepts a top-level
  `notify` key (program + argv, JSON payload appended as a final argument),
  but headless `codex exec` does **not** invoke the notifier on
  `agent-turn-complete` — verified from the `rust-v0.93.0` source (the unit
  test is `#[cfg(not(target_os = "windows"))]` and drives the core API, not
  the `exec` binary) and empirically with two capture programs. It is
  documented in the `.codex` README and **not depended on**.
- **Activity is the process.** With no turn signals, *process-alive =
  session-active*: a detached keeper polls the codex PID and runs the shared
  keepalive policy.
- **Manual extend is a shell function** (`neuron-extend [N]`), not an LLM
  turn — deterministic, no model traffic.

## How it works

1. **Model resolution** (launcher, in order): `-m/--model <M>` argument →
   else `--profile <p>` → the `model` key of `~/.codex/<p>.config.toml` →
   else the `model` key of `~/.codex/config.toml`. Only the **top-level**
   `model` key is read (section keys such as `[windows] sandbox` or
   `[model_providers.*]` never shadow it; `model_provider` is not `model`).
   No model resolvable → exec codex immediately, no reservation.
2. **Managed gate** — `resolve --model M` (bounded, ≤3 s, `GET /api/models`):
   registry match by litellm route name, filtered by
   `NEURON_ALLOWED_PROVIDERS`. Unmanaged → exec codex immediately, zero
   reservation API calls.
3. **Ensure** — `ensure --model M`: **adopt** an active server-side
   reservation for the target, else **create** one (bounded retries for
   timeouts/429/5xx; permanent 4xx fails fast), then a **bounded healthy
   wait** (soft warning at 15 s, hard cap 40 s;
    `NEURON_WAIT_TIMEOUT_SECONDS` / `NEURON_WAIT_POLL_SECONDS` override). Adoption
   is not a pass: an adopted reservation goes through the same wait, so a
   cold adopted target is warmed exactly like a created one. Failure or
   timeout → `NeurOn: <reason>` on stderr, **exit 2, codex is not launched**.
   Control plane unreachable → warn on stderr, **exit 0, the launcher
   launches codex anyway** (fail-open).
4. **Lease + spawn** — the lease is written to
   `~/.codex/neuron/<reservationId>.json`
   (`reservationId`, `targetId`, `model`, `expiresAt`, `lifetimeMs`,
   `pid: null` placeholder, `createdAt`), atomically (tmp file + rename).
   Codex is spawned with the original arguments in the same console; on
   Windows the npm `codex` shim (a `.ps1`) is resolved to its real
   `node.exe` + `…\@openai\codex\bin\codex.js` because `Start-Process`
   cannot `CreateProcess` a `.ps1` ("%1 is not a valid Win32 application").
   The launcher stamps the codex PID into the lease, then starts the
   **keeper** detached (hidden window, redirected stdio) with the lease
   path + codex PID, and stays attached to codex until it exits — the
   terminal behaves exactly like plain `codex`.
5. **Keeper** — every 5 s (`NEURON_KEEPER_TICK_MS`): is the codex PID alive?
   No → log `keeper stop: codex pid=<p> exited`, exit 0. Else, when
   `now − lastExtend ≥ max(50% of lifetime, 30 s)` → **additive** extend
   (`fromNow: false`; the server computes `max(now, expiry) + N min`, so a
   refresh never shortens the expiry), rewrite the lease, and log the new
   wall-clock expiry. A 4xx extend rejection → log, exit 1. A 5xx/transport
   error → log and retry on the next tick (the deadline is not advanced).
   All lines go to `~/.codex/neuron/keeper.log` (best-effort; rotated at
   1 MiB to `keeper.log.1`).

## Install

`sync.ps1` (Windows) / `sync.sh` (POSIX) from `.codex/` runs the
build → install → verify pipeline: esbuild bundle of `src/neuron-codex.js`
(+ `shared/neuron-core`) to `dist/neuron-codex.js`, copy of the bundle +
launchers + `neuron-extend` helpers (+ a `{"type":"module"}` marker so node
never emits the ESM reparse warning) into `~/.codex/neuron/`, a **SHA256
parity gate** (installed bundle must hash identically to the repo bundle),
and `node --check` on the installed bundle:

```
~/.codex/neuron/
  neuron-codex.js            the bundle (what the launchers invoke)
  package.json               {"type":"module"} marker
  launcher/neuron-codex.ps1 / .sh
  neuron-extend.ps1 / .sh
```

Then add shell functions once — `$PROFILE` (PowerShell 7+):

```powershell
function neuron-codex  { & "$env:USERPROFILE\.codex\neuron\launcher\neuron-codex.ps1" @args }
function neuron-extend { & "$env:USERPROFILE\.codex\neuron\neuron-extend.ps1" @args }
```

`~/.zshrc` / `~/.bashrc`:

```sh
neuron-codex()  { "$HOME/.codex/neuron/launcher/neuron-codex.sh" "$@"; }
neuron-extend() { "$HOME/.codex/neuron/neuron-extend.sh" "$@"; }
```

`neuron-codex` is then a drop-in for `codex` (same args, same console).

## Configuration

All configuration is via environment variables read at CLI init.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEURON_API_BASE_URL` | — (required) | Control-plane base URL. |
| `NEURON_API_KEY` | — (required) | `sk-neuron-...` key, sent as `Authorization: Bearer`. |
| `NEURON_ALLOWED_PROVIDERS` | — | Comma-separated provider filter; models outside the list are never gated. |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | Create/extend duration (1–720). |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `40` | Hard cap on the healthy wait, in seconds (soft warning at 15 s). In hook mode the effective cap is `min(value, 290)`, always under the 300 s UserPromptSubmit hook timeout. |
| `NEURON_WAIT_POLL_SECONDS` | `5` | Healthy-wait poll interval. |
| `NEURON_KEEPER_TICK_MS` | `5000` | Keeper PID/keepalive tick. |
| `NEURON_STATE_DIR` | `~/.codex/neuron` | Lease/keeper state directory. |
| `NEURON_CODEX_CLI` | — | Explicit CLI bundle path (overrides launcher discovery). |
| `NEURON_CODEX_HOME` | `~/.codex` | Codex config home (profile/config toml lookup). |

## CLI reference (`node …/neuron-codex.js`)

| Command | Effect |
| --- | --- |
| `resolve --model M [--profile P]` | `{managed, targetId?, reason?}` JSON; bounded ≤3 s. |
| `ensure --model M [--profile P] [--lease-file F]` | Adopt/create + bounded wait; writes lease; prints lease path; exit 0 (incl. fail-open) / 2. |
| `keeper --lease-file F --pid P` | Keepalive loop; started by the launcher, not by hand. |
| `extend [minutes] [--minutes N] [--lease-id I]` | Manual additive extend of the latest active lease (1–720). |
| `status` | JSON: local leases + control-plane status (unreachable is reported, not fatal). |
| `leases` | JSON: local lease files (no network). |

`neuron-extend [N]` (installed shell function, no LLM): `N` defaults to
`NEURON_RESERVATION_DURATION_MINUTES`; bad input → usage, exit 2; success
prints `NeurOn: reservation <id> extended to <HH:MM:SS AM/PM> (+N min)`.

Exit codes: `0` ok (including fail-open) · `1` usage/operational ·
`2` reservation failure (the launcher must not launch codex).

## Semantics and edge cases

- **Fail-open at the edges** — control plane unreachable at launch (resolve
  or ensure) → warn on stderr and launch codex anyway; availability over
  safety, matching the OpenCode plugin.
- **Fail-closed at the gate** — a *known* reservation failure (creation
  rejection, healthy-wait timeout) → `NeurOn: <reason>` on stderr, exit 2,
  codex is **not** launched.
- **Unmanaged model** → immediate launch, zero reservation API calls.
- **No release calls** — the keeper never releases; when it exits the
  reservation expires naturally and the server releases the target. Server
  expiry is authoritative; stale local lease files are harmless (only
  *active* reservations are adopted). Delete
  `~/.codex/neuron/*.json` to reset local state.
- **Session-granular reservation** — the model is fixed at launch;
  switching models means relaunching with another profile or `-m`
  (the user's existing one-model-per-launch pattern).
- **No per-turn gate** — between two keeper ticks the reservation is always
  ≥ ~30 s from expiry (the extend floor), so mid-turn expiry is effectively
  impossible.

## Notable log lines

`~/.codex/neuron/keeper.log` (ISO-8601 prefixed):

- `keeper start: pid=<p> reservation=<id> target=<t> lease=<path>`
- `keepalive: reservation=<id> extended to <HH:MM:SS AM/PM> (+N min, fromNow:false)`
- `keepalive error (will retry next tick): <msg>`
- `keeper stop: codex pid=<p> exited`
- `keeper stop: extend rejected (HTTP <code>): <server body>`
- `keeper stop: reservation <id> already expired`

Launcher/CLI stderr:

- `NeurOn: warming up — waiting up to <N>s for the target to become healthy` (soft, once)
- `NeurOn: timed out after <N>s waiting for NeurOn reservation <id> to become healthy (<target:state, …>)` (exit 2)
- `NeurOn: reservation <id> created|adopted for target <t> (expires <HH:MM:SS AM/PM>)`
- `NeurOn: control plane unreachable (<msg>) — no reservation secured; the launcher decides how to proceed` (fail-open)
- `NeurOn: control plane unreachable — launching codex without a reservation (fail-open)`
- `NeurOn: model resolution failed (exit <n>) — launching codex without a reservation`
- `NeurOn: could not find neuron-codex.js (set NEURON_CODEX_CLI) — launching codex without a reservation`
- `NeurOn: failed to launch codex: <msg>` (exit 1)
- `NeurOn: could not stamp the codex PID into the lease file` / `NeurOn: could not start the keeper coprocess: <msg>` (warnings)
- `NeurOn: reservation <id> extended to <HH:MM:SS AM/PM> (+N min)` (`neuron-extend`)

## Development

```bash
cd .codex
npx esbuild src/neuron-codex.js --bundle --format=esm --platform=node --outfile=dist/neuron-codex.js
node --check dist/neuron-codex.js   # syntax smoke
npm test                            # from .opencode/ — node --test test/*.test.js (full suite)
```

The Codex adapter suite is `.opencode/test/neuron-codex.test.js` (45 tests,
part of the 178-test suite): toml model resolution (args/profile/config,
section-key shadowing), `parseArgs`, the ensure flow (adopt/create, bounded
wait, fail-open, exit codes), keeper ticks with fake timers (extend due,
4xx stop, retry, PID death), lease atomicity, and `extend` validation
(including the positional form). All API traffic is a fake fetch; nothing
touches the network.

## Upgrade path

Done (2026-08-30): Codex was upgraded to **0.151.0** and the lifecycle-hooks
design now runs in place of the wrapper: `UserPromptSubmit` → cold-start gate (can
block the turn, **300 s** hook timeout; internal bounded wait capped at
`min(NEURON_WAIT_TIMEOUT_SECONDS, 290)`), `PostToolUse` → activity signal
(**10 s** budget), `SessionStart` → optional prewarm (**60 s**), and
`/neuron-extend` → MCP `neuron_extend` tool (minutes 1–720) — all delegating
to the same helper subcommands (`resolve`/`ensure`/`extend`/…) this design
ships, unchanged. `sync.ps1`/`sync.sh` install `~/.codex/hooks.json`,
pre-seed the three `trusted_hash` values, and register `[mcp_servers.neuron]`
in the user config. Full hook-mode reference:
[`.codex/README.md`](../.codex/README.md). The 0.144.5-verified design
(payloads, trust model, stdout contract) is recorded in plan 003, Appendix A
(`.opencode/docs/plans/2026-08-29-003-neuron-codex-pi-port-plan.md`) and
implemented in plan 004
(`.opencode/docs/plans/2026-08-30-004-neuron-codex-latest-hooks-upgrade-plan.md`).

See also: [server plugin (OpenCode)](./neuron-server-plugin.md) ·
[TUI panel plugin](./neuron-tui-plugin.md) ·
[pi extension](./neuron-pi-plugin.md)
