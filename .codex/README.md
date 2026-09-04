# NeurOn × Codex CLI — reservation gate + keeper (0.93.0 wrapper / ≥0.148 hooks)

Keeps a NeurOn model reservation alive for the lifetime of a `codex`
session. All NeurOn logic lives in one bundled Node CLI.

Two operating modes share the same bundle (plan 004):

- **Wrapper mode (installed Codex 0.93.0)** — the `neuron-codex` alias runs
  the launcher, which secures the reservation *before* any model traffic,
  spawns codex, and starts a detached **keeper** coprocess that extends the
  reservation while the codex PID is alive.
- **Hook mode (Codex ≥ 0.148, e.g. 0.151.0)** — plain `codex`, no alias.
  Codex's lifecycle hooks call `neuron-codex.js hook <Event>` (the
  UserPromptSubmit hook is the gate), and an MCP server
  (`[mcp_servers.neuron]`) exposes `neuron_extend` to the model.

Target for wrapper mode: installed Codex CLI **0.93.0** (no upgrades — see
plan 003 §3.8). Hook mode was built and verified against **0.151.0** source
(trust-hash canonicalization, hook payloads, MCP stdio). Shares
`shared/neuron-core` with the OpenCode plugin (identical reservation
semantics) and the pi extension.

## Layout

```
.codex/
  src/neuron-codex.js        source (adapter; bundles shared/neuron-core)
  dist/neuron-codex.js       esbuild bundle (gitignored; built, not committed)
  launcher/neuron-codex.ps1  Windows launcher (alias target)
  launcher/neuron-codex.sh   POSIX launcher
  neuron-extend.ps1          manual extend helper (Windows)
  neuron-extend.sh           manual extend helper (POSIX)
  neuron-done.ps1            manual end helper (Windows)
  neuron-done.sh             manual end helper (POSIX)
  hooks.json                 lifecycle-hook template (hook mode; <INSTALL> placeholder)
  sync.ps1 / sync.sh         build + install + SHA256 parity + hook/MCP seeding
  README.md
```

## Build

From this directory (esbuild, no other dependencies):

```powershell
npx esbuild src/neuron-codex.js --bundle --format=esm --platform=node --outfile=dist/neuron-codex.js
node --check dist\neuron-codex.js   # syntax smoke
```

## Install

`sync.ps1` (Windows) / `sync.sh` (POSIX) builds and installs to
`~/.codex/neuron/` with SHA256 parity between the repo bundle and the
installed copy. It is **idempotent** (a second run reports
`already current` and rewrites nothing) and ends with step 5, which seeds
hook mode: install `~/.codex/hooks.json` (real install path substituted),
pre-seed the three `[hooks.state."…"] trusted_hash` entries in
`~/.codex/config.toml` (computed from the *installed* bundle, so the hashes
always match what runs), and register `[mcp_servers.neuron]`. The config
splice is surgical: only the seeded blocks/lines are touched, existing
content and line endings are preserved byte-for-byte, and an existing
`[mcp_servers.neuron]` section is never overwritten:

```
~/.codex/neuron/
  neuron-codex.js            the bundle (what the launchers invoke)
  package.json               {"type":"module"} — keeps node's ESM resolution warning-free
  launcher/neuron-codex.ps1 / .sh
  neuron-extend.ps1 / .sh
```

Then add the shell functions once (PowerShell profile / `~/.zshrc`):

```powershell
# $PROFILE (PowerShell 7+)
function neuron-codex  { & "$env:USERPROFILE\.codex\neuron\launcher\neuron-codex.ps1" @args }
function neuron-extend { & "$env:USERPROFILE\.codex\neuron\neuron-extend.ps1" @args }
function neuron-done   { & "$env:USERPROFILE\.codex\neuron\neuron-done.ps1" @args }
```

```sh
# ~/.zshrc / ~/.bashrc
neuron-codex()  { "$HOME/.codex/neuron/launcher/neuron-codex.sh" "$@"; }
neuron-extend() { "$HOME/.codex/neuron/neuron-extend.sh" "$@"; }
neuron-done()   { "$HOME/.codex/neuron/neuron-done.sh" "$@"; }
```

From then on, `neuron-codex` is a drop-in for `codex` (same args, same
console), `neuron-extend [N]` manually extends the active lease, and
`neuron-done` ends it (same as the web UI "I'm Done" button).

## How it works

1. **Model resolution** — launcher: `-m/--model <M>` → else `--profile <p>` →
   `~/.codex/<p>.config.toml` `model` → else `~/.codex/config.toml` `model`
   (top-level key only; `model_provider`/section keys never shadow it).
   No model resolvable → exec codex immediately, no reservation.
2. **Managed gate** — `resolve --model M` (bounded, ≤3 s,
   `GET /api/models`; registry match by route name + provider filter).
   Unmanaged → exec codex immediately, zero API calls.
3. **Ensure** — `ensure --model M`: adopt an active reservation for the
   target, else create; bounded wait for the target to become healthy
   (soft 15 s / hard 40 s; `NEURON_WAIT_TIMEOUT_SECONDS` overrides the hard
   cap, `NEURON_WAIT_POLL_SECONDS` the poll interval). Failure/timeout →
   `NeurOn: <reason>` on stderr, **exit 2, codex is NOT launched**.
   A reservation created by this invocation is ended best-effort when the
   healthy wait fails (no orphan capacity held until TTL); adopted
   reservations are never touched. Control plane unreachable → warn on
   stderr, proceed anyway (fail-open, matches the OpenCode plugin).
   **Owner-scoped adoption.** The adapter resolves the authenticated
   username once per process (`GET /api/me`, memoized; `NEURON_USERNAME`
   pins it) and only adopts active reservations owned by that user — the
   server-side extend/done APIs are owner-scoped, so a foreign lease would
   only produce 404 churn. An admin key adopts freely (the server allows it
   by design). When the username cannot be resolved (older control plane
   without `/api/me`, network blip) the adapter fails open and adopts as
   before.
4. **Lease + spawn** — lease file `~/.codex/neuron/<reservationId>.json`
   (reservationId, targetId, model, sessionId (hook mode), expiresAt,
   lifetimeMs, pid, processName). Codex is spawned with the original args in
   the same console (the npm `codex` shim is resolved to its real `node.exe`
   + entry point — `Start-Process` cannot `CreateProcess` a `.ps1`), then
   the **keeper** starts detached with the lease path + codex PID. The
   keeper records the process name at start so it can detect PID reuse. In
   hook mode the lease also records the session id from the hook payload,
   so PostToolUse keepalive extends THIS session's lease (then falls back to
   the turn's model, then the latest active lease) instead of accidentally
   extending a different codex session's reservation.
5. **Keeper** — every 5 s (`NEURON_KEEPER_TICK_MS`): is the codex PID
   alive *and* is it still the expected process? no → `keeper stop: codex
   pid=<p> exited` (or `pid=<p> reused by <name> (expected <expected>)` on
   PID reuse), exit 0. Else, when
   `now − lastExtend ≥ max(0.5·lifetime, 30 s)` → additive extend
   (`fromNow:false`, server computes `max(now, expiry) + N min`), rewrite
   the lease, log `keepalive: … extended to <clock> (+N min)`. A 4xx
   extend rejection → `keeper stop: extend rejected (HTTP …)`, exit 1.
   All lines go to `~/.codex/neuron/keeper.log` (best-effort, rotated at
   1 MiB to `keeper.log.1`).

## Hook mode (Codex ≥ 0.148, verified on 0.151.0)

If the installed codex is upgraded (≥ 0.148), no alias is needed: plain
`codex` is gated by lifecycle hooks registered in `~/.codex/hooks.json`
(installed by sync, step 5):

| Hook | Handler | Timeout | Effect |
| --- | --- | --- | --- |
| `UserPromptSubmit` | `neuron-codex.js hook UserPromptSubmit` | 300 s | **the gate.** Resolves the prompt's model → managed? ensure/adopt a reservation (bounded wait) → healthy: silent pass (exit 0, empty stdout); failed/timed out: stdout `{"decision":"block","reason":"NeurOn: …"}` and the turn is blocked. Unmanaged model or unreachable control plane → fail-open pass. |
| `PostToolUse` | `neuron-codex.js hook PostToolUse` | 10 s | keepalive activity: marks `lastActivityAt` on the matching lease and extend-when-due (same floor as the keeper). Never blocks. |
| `SessionStart` | `neuron-codex.js hook SessionStart` | 60 s | no-op; reservations begin only at `UserPromptSubmit`. |

Gate wait budget: `min(NEURON_WAIT_TIMEOUT_SECONDS, 290)` seconds — always
below the 300 s hook timeout, so codex never kills the hook mid-decision
(codex would treat that as fail-open). The 300 s hook timeout covers slow
cold starts (the target instance takes 60–73 s to reach healthy). Hook diagnostics go to
`~/.codex/neuron/hook.log` (rotated at 1 MiB).

**Trust hashes.** Codex refuses to run a hook whose file changed since it
was trusted. Sync pre-seeds the `[hooks.state."~/.codex/hooks.json:<event>:0:0"]`
`trusted_hash` values by computing the exact 0.151.0 canonicalization
(normalized handler → TOML → key-sorted compact JSON → SHA-256) from the
installed bundle, so the first prompt runs without an interactive trust
prompt. **If you ever edit a hook's command/timeout in `hooks.json`, re-run
sync** (or trust it interactively via the `/hooks` TUI).

**MCP server.** `[mcp_servers.neuron]` → `node …/neuron-codex.js mcp`
(stdio JSON-RPC, no dependencies): exposes one tool, `neuron_extend
{minutes: 1–720}`, which additively extends the latest active lease — the
model can top up its own reservation.

**Disabling hook mode:** move `~/.codex/hooks.json` aside (trust state is
harmless leftover) or set `features.hooks = false` in `~/.codex/config.toml`.
Hook mode and wrapper mode must not be mixed on one install (the wrapper
would double-gate); the installed 0.93.0 binary stays wrapper-mode until
upgraded.

## CLI reference (`node …/neuron-codex.js`)

| Command | Effect |
| --- | --- |
| `resolve --model M [--profile P]` | `{managed, targetId?, reason?}` JSON |
| `ensure --model M [--profile P] [--lease-file F]` | adopt/create + bounded wait; writes lease; prints lease path; exit 0/2 |
| `keeper --lease-file F --pid P` | keepalive loop (run by the launcher, not by hand) |
| `extend [minutes] [--minutes N] [--lease-id I]` | manual additive extend of the latest active lease (1–720) |
| `status` | JSON: local leases + control-plane status |
| `leases` | JSON: local lease files |
| `hook <UserPromptSubmit\|PostToolUse\|SessionStart>` | lifecycle-hook entry point (stdin payload; hook-mode only) |
| `hook trust <event_snake> <command> <timeout_sec>` | print the 0.151.0 `trusted_hash` for a hook definition |
| `mcp` | stdio JSON-RPC MCP server (`neuron_extend` tool); run by codex, not by hand |

Exit codes: `0` ok (including fail-open) · `1` usage/operational ·
`2` reservation failure (launcher must not launch codex). Hook exit `1`
means *our* unexpected error → codex fails open (documented, intended).

State: `~/.codex/neuron/` (`NEURON_STATE_DIR` overrides).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEURON_API_BASE_URL` | — | control-plane base URL |
| `NEURON_API_KEY` | — | API key (`sk-neuron-…`) |
| `NEURON_ALLOWED_PROVIDERS` | — | comma-separated provider filter |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | create/extend duration (1–720) |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `40` | hard cap for the healthy-wait (seconds; same variable as the OpenCode plugin). In hook mode the effective cap is `min(value, 290)` — always under the 300 s UserPromptSubmit hook timeout |
| `NEURON_CODEX_PREWARM` | ignored | retained for compatibility; SessionStart never reserves |
| `NEURON_WAIT_POLL_SECONDS` | `5` | healthy-wait poll interval |
| `NEURON_KEEPER_TICK_MS` | `5000` | keeper tick |
| `NEURON_STATE_DIR` | `~/.codex/neuron` | lease/keeper state dir |
| `NEURON_CODEX_CLI` | — | explicit CLI bundle path (overrides discovery) |
| `NEURON_CODEX_HOME` | `~/.codex` | codex config home |
| `NEURON_USERNAME` | — | pin the authenticated username for adoption scoping (otherwise resolved once via `GET /api/me`) |

## `neuron-extend`

Deterministic manual extend — no LLM. `neuron-extend 5` extends the latest
active lease by 5 minutes (additive: the server never shortens an expiry)
and prints `NeurOn: reservation <id> extended to <HH:MM:SS AM/PM> (+5 min)`.
No argument → the configured default duration. Bad input → usage, exit 2.

## `neuron-done`

Deterministic manual end — no LLM. `neuron-done` marks the latest active
lease done server-side (same as the web UI "I'm Done" button) and prints
`NeurOn: reservation <id> ended`. Marks the lease file inactive so the keeper
stops polling. Accepts an optional lease-id argument to target a specific
lease. No active lease → error, exit 2.

## Optional: `notify` (unverified on 0.93.0 — do not depend on it)

Codex 0.93.0 accepts a top-level `notify` key in the **user**
`config.toml` (ignored in project-local `.codex/config.toml`):

```toml
notify = ["C:/Program Files/nodejs/node.exe", "C:/path/to/handler.mjs"]
```

When it fires, the program is spawned (fire-and-forget) with a **single
JSON argument** appended to the configured argv:

```json
{
  "type": "agent-turn-complete",
  "thread-id": "<uuid>",
  "turn-id": "<turn id>",
  "cwd": "<working directory>",
  "input-messages": ["<user message>"],
  "last-assistant-message": "<last assistant message>"
}
```

(payload shape from the `rust-v0.93.0` source + its unit test;
`serde` kebab-case tag `type`, event `agent-turn-complete`).

**Spike A finding (this machine, 0.93.0, Windows):** headless
`codex exec` did **not** invoke the notifier on turn completion — verified
with two different capture programs (immediate-write Node script and a
`.cmd`), full stderr captured, no `failed to spawn notifier` warning, clean
`exit 0` every run. The 0.93.0 unit test for this feature is
`#[cfg(not(target_os = "windows"))]` and drives the core API directly
rather than the `exec` binary. Conclusion: treat `notify` as **unreliable
in headless exec on 0.93.0**. v1 does not depend on it — the keeper's
process-alive signal already covers session activity.

## Known v1 limitations

- **Session-granular reservation.** The model is fixed at launch;
  switching models means relaunching with another profile (the existing
  user pattern: `-m <route>` or `--profile <p>`).
- **Wrapper mode: no per-turn gate** (session-granular). Between two keeper
  ticks (5 s) the reservation is always ≥ ~30 s from expiry (the extend
  floor), so mid-turn expiry is effectively impossible. Hook mode *does*
  gate every prompt (UserPromptSubmit) plus PostToolUse keepalive.
- **`notify` unverified on 0.93.0** (spike A above); v1 does not use it.

## Troubleshooting

- **`NeurOn: node not found in PATH`** — the Windows launcher couldn't find
  `node`. The gate is skipped (fail-open) and codex launches directly.
  Install Node.js or add it to PATH to enable the reservation gate.
- **`%1 is not a valid Win32 application`** — you tried to `Start-Process`
  the npm `codex` shim (a `.ps1`). The bundled launcher already resolves
  the shim to `node.exe` + `…\@openai\codex\bin\codex.js`; don't spawn the
  shim yourself.
- **`NeurOn: … exit 2` before codex starts** — the reservation gate failed
  (duration/timeout/control-plane rejection). Codex deliberately did not
  launch. Check `NEURON_API_BASE_URL`/`NEURON_API_KEY` and the target's
  healthy state (`node …/neuron-codex.js status`).
- **`NeurOn: warming up — waiting up to Ns …`** — normal; the managed
   target is starting. The hard cap is `NEURON_WAIT_TIMEOUT_SECONDS`
   (default 40 s). Raise it (e.g. `300`) for slow cold starts; lower
  `NEURON_WAIT_POLL_SECONDS` (e.g. `5`) for faster detection.
- **`deprecated: Support for the "chat" wire API …`** — expected noise on
  0.93.0 + the local litellm provider; harmless.
- **File writes "blocked by policy"** — `codex exec` defaults to a
  read-only sandbox on this setup; use a profile/permission change for
  write tasks (independent of NeurOn).
- **Where is the log?** `~/.codex/neuron/keeper.log` (start / keepalive /
  stop lines) and `~/.codex/neuron/hook.log` (hook-mode gate/keepalive
  decisions). `leases` / `status` subcommands show live lease state.
- **Hook mode: turn blocked with `NeurOn: …`** — the UserPromptSubmit gate
  found the managed target unhealthy/stopped (or the wait budget ran out).
  Check the target's state (`node …/neuron-codex.js status`), raise
  `NEURON_WAIT_TIMEOUT_SECONDS` for slow cold starts, or start the EC2
  target. An unmanaged model never blocks (fail-open).
- **Hook mode: codex asks to trust the hook** — the hook definition no
  longer matches the seeded `trusted_hash` (you edited `hooks.json`).
  Re-run sync, or approve via the `/hooks` TUI.
- **Two stale lease files** — leases are per-reservation; expired ones are
  harmless (the CLI only adopts *active* reservations). Delete
  `~/.codex/neuron/*.json` to reset local state; server expiry is
  authoritative either way.
