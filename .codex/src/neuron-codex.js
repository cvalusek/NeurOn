// NeurOn Codex CLI — the Codex CLI adapter over the shared NeurOn core.
//
// Bundled by esbuild (from .codex/: `npx --yes esbuild src/neuron-codex.js
// --bundle --format=esm --platform=node --outfile=dist/neuron-codex.js`) into
// the single-file artifact installed at ~/.codex/neuron/neuron-codex.js.
//
// Dual mode (plan 003 §4.1 + plan 004 §4):
//   - wrapper mode (Codex 0.93.0, no lifecycle hooks): the launcher resolves
//     the launch model and calls `ensure` BEFORE spawning codex (cold-start
//     gate; fail-open when the control plane is unreachable); the keeper
//     coprocess polls the codex PID and runs the core keepalive policy tick
//     (extend when due, ADDITIVE fromNow:false) every 5 s;
//   - hook mode (Codex ≥0.148, target 0.151.0): plain `codex` runs; the
//     `hook` subcommand is the lifecycle-hook gate (UserPromptSubmit blocks
//     the first prompt until the reservation is healthy; PostToolUse marks
//     activity + conditional keepalive; SessionStart is a no-op),
//     and `mcp` serves the neuron_extend MCP tool over stdio.
//   - `neuron-extend [minutes]` (shell function) drives `extend` — no LLM.
//
// Subcommands: resolve / ensure / keeper / extend / status / leases /
// hook / mcp.
// Exit codes: 0 success (including the fail-open paths), 1 usage/operational
// error, 2 reservation failure (the launcher must NOT launch codex).
// Hook-mode stdout discipline (contract-critical): on success the hook prints
// NOTHING to stdout (plain text would be injected into the model context);
// an explicit block prints exactly {"decision":"block","reason":"NeurOn: …"};
// an unexpected error goes to stderr with exit 1 (codex fails open).
//
// `main()` runs only when this file is executed directly; the pure helpers
// are exported for the node --test suite (imported from the source entry,
// exactly like the OpenCode adapter tests).

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  NeurOnClient,
  NeurOnApiError,
  loadConfig,
  matchesAllowedProvider,
  canonicalizeModel,
  matchLiteLlmModel,
  findTargetStatus,
  isTransientError,
  isExtendDue,
  formatClock,
  sleep,
  positiveNumber,
  resolveUsername,
  isOwnReservation
} from "../../shared/neuron-core/index.js";

// Re-exported for the test suite (the adapter's public surface includes the
// core's API error type — keepers/commands classify on it).
export { NeurOnApiError };

// ── Constants ─────────────────────────────────────────────

export const HARNESS_LABEL = "Codex";

// Bounded cold-start wait: soft threshold (one "warming up" warning) and the
// hard failure deadline, both in milliseconds. The hard deadline is read
// from the same established variable the core and the OpenCode plugin use —
// NEURON_WAIT_TIMEOUT_SECONDS (seconds; fractional allowed) — with a
// harness-specific 40 s default (documented design deviation: the Codex
// gate fails fast rather than blocking for the core's 10-minute budget).
export const DEFAULT_WAIT_TIMEOUT_S = 40;
export const SOFT_WAIT_TIMEOUT_MS = 15000;

// The models read uses a tight 3 s budget so a dead control plane can never
// stall the launcher (plan §4.1: "bounded GET /api/models ≤3 s").
export const RESOLVE_REQUEST_TIMEOUT_MS = 3000;

// Keeper tick cadence (plan §4.1: "loop every 5 s").
export const DEFAULT_KEEPER_TICK_MS = 5000;

// Hook-mode wait cap: the UserPromptSubmit hook runs with a 300 s timeout
// (plan 004 §4, design restore 2026-08-30: the target instance takes 60–73 s
// to reach healthy, so a shorter cap blocked every cold start), so the gate's
// internal bounded wait is capped at 290 s (default 40 s, the core default) —
// the hook always finishes in time with an explicit decision instead of being
// killed mid-wait.
export const HOOK_WAIT_CAP_S = 290;

// 0.151.0 output-spill default token limit (codex-rs/hooks output_spill.rs):
// an additionalContextLimit of exactly this value is normalized away (omitted
// from the trust identity) — must match or the trust hash is wrong.
export const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;

// Flags that always consume the next argv token as their value.
const VALUE_FLAGS = new Set(["model", "profile", "lease-file", "pid", "minutes", "lease-id", "session-id"]);

// ── Config / paths ────────────────────────────────────────

// Codex's bounded wait reads the same established variable as the core —
// NEURON_WAIT_TIMEOUT_SECONDS, in seconds — with the harness-specific 40 s
// default (soft 15 s / hard 40 s); everything else keeps the OpenCode
// plugin's env names/semantics.
export function loadCodexConfig(env = process.env) {
  const config = loadConfig(env, HARNESS_LABEL);
  config.waitTimeoutMs = positiveNumber(env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_S) * 1000;
  return config;
}

// ~/.codex — overridable for tests (NEURON_CODEX_HOME).
export function codexHomeFromEnv(env = process.env) {
  const home = env.USERPROFILE || env.HOME || ".";
  return env.NEURON_CODEX_HOME || path.join(home, ".codex");
}

// Lease/keeper state dir: ~/.codex/neuron (plan §4.1). NEURON_STATE_DIR
// overrides the whole directory so tests never touch the real one.
export function stateDirFromEnv(env = process.env) {
  if (env.NEURON_STATE_DIR) return env.NEURON_STATE_DIR;
  return path.join(codexHomeFromEnv(env), "neuron");
}

// Hook-mode wait cap in seconds: min(NEURON_WAIT_TIMEOUT_SECONDS ?? 40, 290)
// — always under the 300 s UserPromptSubmit hook timeout (plan 004 §4).
export function hookWaitSeconds(env = process.env) {
  return Math.min(positiveNumber(env.NEURON_WAIT_TIMEOUT_SECONDS, 40), HOOK_WAIT_CAP_S);
}

// ── Hook trust hash (0.151.0 normalization) ───────────────
// Mirrors the 0.151.0 trust-hash pipeline EXACTLY (a wrong hash means the
// hook is silently skipped):
//   discovery.rs hook_hash(): NormalizedHookIdentity { event_name (snake),
//     #[flatten] group: MatcherGroup { matcher?, hooks: [normalized] } } where
//     the normalized Command handler is { command (commandWindows-preferred),
//     command_windows: None, timeout_sec: Some(n), async, status_message,
//     additional_context_limit: filtered(== 2500 → None) };
//   fingerprint.rs version_for_toml(): TomlValue::try_from(identity) →
//     serde_json::to_value → canonical_json (recursively sorted keys) →
//     compact to_vec → SHA-256 → "sha256:<64hex>".
// The toml step matters: toml's SerializeMap::serialize_value drops map
// values that serialize to None (ErrorInner::UnsupportedNone → key omitted),
// so absent options (matcher, commandWindows, statusMessage,
// additionalContextLimit) are ABSENT keys — never null — in the hashed table.

// Recursively key-sorted compact JSON (== serde_json canonical_json + to_vec
// for object/array/primitive values).
export function canonicalJsonString(value) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

// sha256:<64hex> of the canonical JSON of the normalized 0.151.0 hook
// identity for one sync command handler. `command` must be the EXACT command
// string the hook will run (on Windows, commandWindows ?? command — we ship
// no commandWindows override, so the plain command).
export function hookTrustHash({
  eventName,
  command,
  timeoutSec,
  matcher,
  statusMessage,
  commandWindows,
  additionalContextLimit,
  async: runsAsync = false
}) {
  const handler = { type: "command", command };
  if (commandWindows) handler.commandWindows = commandWindows;
  handler.timeout = timeoutSec;
  handler.async = runsAsync;
  if (statusMessage) handler.statusMessage = statusMessage;
  if (
    additionalContextLimit !== undefined &&
    additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT
  ) {
    handler.additionalContextLimit = additionalContextLimit;
  }
  const identity = { event_name: eventName };
  if (matcher) identity.matcher = matcher;
  identity.hooks = [handler];
  return `sha256:${createHash("sha256").update(canonicalJsonString(identity), "utf8").digest("hex")}`;
}

// Escapes a value for use inside a TOML basic string ("..."). Filesystem
// paths only ever need `\` and `"` escaped, but every TOML escape sequence
// is handled so any value is safe. Regression context: the install path was
// once escaped directory-by-directory and the filename was appended raw,
// leaving a bare `\neuron-codex.js` that TOML parsed as a NEWLINE escape and
// mangled the path (MODULE_NOT_FOUND with a literal LF in it). Always escape
// the FULL value in one pass — via the `toml-escape` subcommand, which both
// sync scripts call so there is a single, unit-tested implementation.
export function tomlEscape(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += ch;
    }
  }
  return out;
}

// Reads a stream to EOF as utf8 (the hook payload arrives on the child's
// stdin; injected in tests).
export function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.setEncoding("utf8");
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

// ── argv parsing ──────────────────────────────────────────

// Thin --flag/--flag=value parser; unknown tokens collect in args._.
export function parseArgs(argv) {
  const args = { _: [] };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = list[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined) {
        args[key] = next;
        i += 1;
      } else if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

// ── Codex launch-model resolution (pure; tested with toml fixtures) ──
// Precedence (plan §4.1): -m/--model arg > --profile <p> →
// ~/.codex/<p>.config.toml `model` key > ~/.codex/config.toml `model` key.
// The toml files here are flat `key = "value"` lines; extractTomlValue does
// an exact key match (so `model` never matches `model_provider` or
// `model_catalog_json`).

// Flat `key = "value"` lookup for the TOP-LEVEL lines (before the first
// [section] header) of a codex config/profile toml. Codex puts `model` and
// `model_provider` at the top of config.toml; section keys (e.g. `name`
// inside [model_providers.litellm] or `sandbox` inside [windows]) are
// ignored so a section can never shadow a top-level key.
export function extractTomlValue(tomlText, key) {
  if (!tomlText) return undefined;
  let inSection = false;
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = true;
      continue;
    }
    if (inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    if (k !== key) continue;
    const v = line.slice(eq + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      return v.slice(1, -1);
    }
    return undefined;
  }
  return undefined;
}

// readText must return undefined (not throw) for missing files.
function safeReadText(readText) {
  return (p) => {
    try {
      return readText(p);
    } catch {
      return undefined;
    }
  };
}

export function resolveCodexModel(args, { codexHome, readText } = {}) {
  const home = codexHome ?? codexHomeFromEnv(process.env);
  const read = safeReadText(readText ?? ((p) => readFileSync(p, "utf8")));
  const list = Array.isArray(args) ? args : [];

  let model;
  let source;
  let profile;
  // Scan the FULL argument list (no early break): an explicit --model wins
  // regardless of its position relative to --profile (documented precedence:
  // -m/--model → --profile → profile toml → base config toml).
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === "-m" || arg === "--model") {
      if (i + 1 < list.length) {
        model = list[i + 1];
        source = "arg";
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      source = "arg";
      continue;
    }
    if (arg === "-p" || arg === "--profile") {
      if (i + 1 < list.length) {
        profile = list[i + 1];
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
      continue;
    }
  }

  const profileText = profile !== undefined ? read(path.join(home, `${profile}.config.toml`)) : undefined;
  const configText = read(path.join(home, "config.toml"));

  if (!model && profile !== undefined) {
    const profileModel = extractTomlValue(profileText, "model");
    if (profileModel) {
      model = profileModel;
      source = `profile:${profile}`;
    }
  }
  if (!model) {
    const configModel = extractTomlValue(configText, "model");
    if (configModel) {
      model = configModel;
      source = "config";
    }
  }

  // Agent-side provider (for the NEURON_ALLOWED_PROVIDERS gate, same
  // semantics as the OpenCode plugin's model providerID): the profile
  // overrides, then the base config.
  const provider =
    extractTomlValue(profileText, "model_provider") ??
    extractTomlValue(configText, "model_provider");

  return { model, source, provider, profile };
}

// ── Model → target resolution against a live status (pure) ──

// Returns { managed: true, targetId, match } or { managed: false, reason }.
// The Codex model is a litellm route name (`<targetId>/<modelId>[/...]`), so
// it is canonicalized with the codex-side provider (config.toml
// model_provider, e.g. `litellm`) exactly like the OpenCode plugin — that
// keeps the target prefix as the targetIdHint instead of letting splitProvider
// mistake it for a provider (which would drop the dedicated-target preference
// and fall back to an arbitrary multi-model host). The allowed-provider
// filter is the same agent-side provider, NOT the control-plane capacity
// provider of the matched target.
export function resolveModelStatus(status, modelId, config, provider) {
  const normalized = canonicalizeModel(provider, modelId);
  const match = matchLiteLlmModel(
    status.capacityTargets ?? [],
    status.models ?? [],
    normalized.bareModelId,
    normalized.provider,
    config.strictProviderMatch
  );
  if (!match) {
    return { managed: false, reason: `not_managed: "${modelId}" is not in the NeurOn registry` };
  }
  if (match.error) {
    return { managed: false, reason: `not_managed: ${match.error}: ${match.detail}` };
  }
  const targetId = match.targetIds[0];
  const target = findTargetStatus(status.capacityTargets ?? [], targetId);
  if (!matchesAllowedProvider(provider, modelId, config.allowedProviders, () => {})) {
    return {
      managed: false,
      reason: `provider_not_allowed: provider=${provider ?? "unknown"} allowed=${config.allowedProviders.join(",") || "(none)"}`
    };
  }
  return { managed: true, targetId, match, target };
}

// The first ACTIVE reservation (server status) covering targetId, if any.
// The first ACTIVE reservation (server status) covering targetId, if any.
// When `scope` carries a resolved username (non-admin) only that user's
// reservations match — the server-side reservation APIs are owner-scoped, so
// adopting a foreign reservation would only produce 404 churn on every
// extend. Without a username (older control plane / discovery failed) this
// fails open and matches as before.
export function findActiveReservationForTarget(status, targetId, scope) {
  const active = [
    ...(status.activeReservations ?? []),
    ...(status.reservations ?? [])
  ];
  for (const res of active) {
    if (res.status !== "active") continue;
    if (scope && !isOwnReservation(res, scope)) continue;
    const targets = res.targets ?? [];
    for (const t of targets) {
      if ((t.id ?? t) === targetId) return res;
    }
  }
  return null;
}

// ── Lease files (atomic write: mkdir + lock + tmp + rename) ──

async function withStateLock(stateDir, fn) {
  const lockPath = path.join(stateDir, ".lock");
  const LOCK_STALE_MS = 10000;
  for (let attempt = 0; attempt < 50; attempt++) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Stale lock (crashed writer) — remove and retry. Primary signal: the
      // writer's PID recorded in the lock file; if that process is gone the
      // lock is stale immediately (no mtime wait). On filesystems with coarse
      // mtime granularity (networked/virtualized) mtime alone lags, so the
      // 10 s mtime threshold remains only as a fallback for when the PID
      // can't be parsed or liveness can't be determined (isPidAlive → null).
      const st = await fs.stat(lockPath).catch(() => null);
      let stale = false;
      if (st) {
        let lockPid = null;
        try {
          const content = await fs.readFile(lockPath, "utf8");
          const parsed = content.trim().split(":");
          lockPid = parseInt(parsed[0], 10);
        } catch {
          /* fall through to the mtime check below */
        }
        if (lockPid) {
          const alive = await isPidAlive(lockPid);
          if (alive === false) {
            stale = true;
          } else if (alive === null) {
            stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
          }
          // alive === true → the holder is still running; do NOT steal.
        } else {
          // No parseable PID (foreign/corrupt lock) — mtime fallback.
          stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        }
      }
      if (stale) {
        await fs.unlink(lockPath).catch(() => {});
      }
      await sleep(20 + Math.floor(Math.random() * 30));
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`could not acquire the NeurOn state lock (${lockPath})`);
}

// Atomically write <dir>/<fileName>: create the dir, serialize writers via
// the dir's .lock, write a same-directory tmp file, rename into place.
export async function writeLeaseAtomic(dir, lease, fileName) {
  const name = fileName ?? `${lease.reservationId}.json`;
  const finalPath = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await withStateLock(dir, async () => {
    const tmp = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await fs.rename(tmp, finalPath);
  });
  return finalPath;
}

// Parsed lease list for a state dir (corrupt files are skipped).
export async function listLeases(stateDir) {
  let entries;
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return [];
  }
  const now = Date.now();
  const leases = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stateDir, name);
    let lease;
    try {
      lease = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    // Only real leases count: a string reservationId plus a parseable
    // expiry. Foreign JSON in the state dir (the ESM marker package.json
    // that sync installs, or any non-lease file) is skipped — never listed
    // with null fields.
    if (!lease || typeof lease !== "object" || typeof lease.reservationId !== "string") {
      continue;
    }
    const expiresAtMs = Date.parse(lease.expiresAt ?? "");
    if (!Number.isFinite(expiresAtMs)) continue;
    leases.push({
      file,
      reservationId: lease.reservationId ?? null,
      targetId: lease.targetId ?? null,
      model: lease.model ?? null,
      sessionId: lease.sessionId ?? null,
      pid: lease.pid ?? null,
      expiresAt: lease.expiresAt ?? null,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
      lifetimeMs: lease.lifetimeMs ?? null,
      active: Number.isFinite(expiresAtMs) && expiresAtMs > now
    });
  }
  return leases;
}

// The latest lease whose expiry is in the future (manual-extend default).
export async function pickLatestActiveLease(stateDir) {
  const leases = (await listLeases(stateDir)).filter((l) => l.active);
  if (!leases.length) return null;
  return leases.reduce((best, l) => (l.expiresAtMs > best.expiresAtMs ? l : best));
}

// ── PID liveness ──────────────────────────────────────────
// Windows: tasklist (a hard-killed codex disappears from the table);
// POSIX: signal-0 probe (EPERM means alive but not ours). A transport
// failure returns null = "unknown", which callers treat as alive (log and
// keep polling) so a slow tasklist can never kill the keeper early.

export async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(
          "tasklist",
          ["/NH", "/FI", `PID eq ${pid}`, "/FO", "CSV"],
          { timeout: 5000, windowsHide: true },
          (error, stdout) => (error ? reject(error) : resolve({ stdout }))
        );
      });
      // CSV row for a live task: "name","<pid>",... — match the exact field.
      return new RegExp(`(^|,)\\s*"${pid}"\\s*,`).test(stdout ?? "");
    } catch {
      return null;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM" ? true : false;
  }
}

// The process name (image name / command name) of a live PID, or null when the
// PID is not found. A transport failure (tasklist/ps unavailable, /proc
// missing) also returns null — callers must treat "unknown" as "cannot
// verify" and fall back to PID-only liveness (never stop the keeper).
// This is the identity layer on top of isPidAlive: a reused PID belongs to a
// DIFFERENT name, so the keeper can tell the original process is gone.
export async function getProcessName(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    // tasklist CSV row for a live task: "image.exe","<pid>",... — the first
    // field is the image name.
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(
          "tasklist",
          ["/NH", "/FI", `PID eq ${pid}`, "/FO", "CSV"],
          { timeout: 5000, windowsHide: true },
          (error, stdout) => (error ? reject(error) : resolve({ stdout }))
        );
      });
      const line = (stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      if (!line) return null;
      const m = line.match(/^"([^"]+)"/);
      if (!m) return null;
      const name = m[1];
      // "No tasks are running which match the specified criteria." is
      // tasklist's no-match row — it has no quoted image field, so a match
      // here would be a genuine process.
      return name && !name.startsWith("No tasks") ? name : null;
    } catch {
      return null;
    }
  }
  // POSIX: ps comm (portable); /proc/<pid>/comm works on Linux too.
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile("ps", ["-p", String(pid), "-o", "comm="], { timeout: 5000 }, (error, stdout) =>
        error ? reject(error) : resolve({ stdout })
      );
    });
    const name = (stdout ?? "").trim();
    return name || null;
  } catch {
    return null;
  }
}

// ── Keepalive policy tick loop (the keeper) ───────────────
// Extends the lease's reservation when the core policy says it is due:
// at least half the effective lifetime since the last extend (30 s floor),
// ADDITIVE (fromNow:false, server: expiry = max(now, currentExpiry) + N).
// "Activity" in Codex = process-alive (plan §3.3), so there is no activity
// gate; the loop simply stops when the codex PID dies and the reservation
// expires naturally on the server. A reused PID (the OS reassigns the number
// to an unrelated process between ticks) is caught by the process-name
// verification below: it stops the keeper when the live PID's name no longer
// matches the one recorded in the lease at start.

export async function keeperLoop({
  lease,
  pid,
  client,
  config,
  tickMs,
  stateDir,
  leaseFile,
  now = () => Date.now(),
  sleepFn = sleep,
  isPidAlive: aliveFn = isPidAlive,
  getProcessName: processNameFn = getProcessName,
  log = () => {},
  writeLease = writeLeaseAtomic,
  maxTicks = Infinity
}) {
  let lastExtendAt = now();
  let lifetimeMs =
    typeof lease.lifetimeMs === "number" && lease.lifetimeMs > 0
      ? lease.lifetimeMs
      : Math.max(0, Date.parse(lease.expiresAt ?? "") - now());
  let currentLease = { ...lease };
  let ticks = 0;
  // The process name recorded at start. Absent (pre-fix lease or the
  // launcher could not read it) → the name check is skipped and the keeper
  // falls back to PID-only liveness (backward compatible).
  const expectedName = typeof lease.processName === "string" && lease.processName ? lease.processName : null;
  // `log` may be async (appendKeeperLog): every log call below is awaited so
  // the final line is on disk before the loop returns — the direct-run gate
  // process.exit()s as soon as main() resolves, so an un-awaited append would
  // be killed mid-flight and the stop line would be silently lost.
  const say = (line) => Promise.resolve(log(line));
  for (;;) {
    ticks += 1;
    const alive = await aliveFn(pid);
    if (alive === false) {
      await say(`keeper stop: codex pid=${pid} exited`);
      return 0;
    }
    // PID-reuse guard: the PID is in use, but is it still OUR process?
    // (alive === null = "unknown" → skip verification, keep polling; a
    // slow tasklist/ps can never kill the keeper early, matching
    // isPidAlive's contract.)
    if (alive === true && expectedName !== null) {
      const actualName = await processNameFn(pid);
      if (actualName === null) {
        // The process vanished between the alive check and the name check
        // (or the name could not be read) — the PID is dead.
        await say(`keeper stop: codex pid=${pid} exited`);
        return 0;
      }
      if (actualName.toLowerCase() !== expectedName.toLowerCase()) {
        await say(`keeper stop: pid=${pid} reused by ${actualName} (expected ${expectedName})`);
        return 0;
      }
    }
    const t = now();
    if (isExtendDue(t, lastExtendAt, lifetimeMs)) {
      let extended;
      try {
        extended = await client.extendReservation(lease.reservationId, config.durationMinutes, { fromNow: false });
      } catch (e) {
        if (e instanceof NeurOnApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          await say(`keeper stop: extend rejected (HTTP ${e.status}): ${e.body ?? e.message}`);
          return 1;
        }
        await say(`keepalive error (will retry next tick): ${e?.message ?? e}`);
      }
      if (extended) {
        lastExtendAt = t;
        lifetimeMs = Math.max(0, Date.parse(extended.expiresAt ?? "") - t);
        currentLease = { ...currentLease, expiresAt: extended.expiresAt, lifetimeMs, lastExtendAt: new Date(t).toISOString() };
        try {
          await writeLease(stateDir, currentLease, path.basename(leaseFile));
        } catch (e) {
          await say(`lease update failed: ${e?.message ?? e}`);
        }
        await say(
          `keepalive: reservation=${lease.reservationId} extended to ${formatClock(extended.expiresAt)} (+${config.durationMinutes} min, fromNow:false)`
        );
      }
    }
    if (ticks >= maxTicks) return 0;
    await sleepFn(tickMs);
  }
}

// ── Shared command plumbing ───────────────────────────────

const defaultIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`)
};

function makeClient(config, overrides = {}) {
  return new NeurOnClient({ ...config, ...overrides });
}

// Bounded retry with jitter for transient control-plane errors (timeouts,
// 429, 5xx) — the CLI has no persistent retry state, so this is a local
// loop over the core's isTransientError classification.
async function withTransientRetries(fn, config) {
  const maxAttempts = Math.max(1, config.retryMaxAttempts ?? 3);
  const baseMs = config.retryBaseMs ?? 1000;
  const maxMs = config.retryMaxMs ?? 8000;
  let delay = baseMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientError(e) || attempt >= maxAttempts) throw e;
      await sleep(Math.min(delay + Math.random() * delay, maxMs));
      delay = Math.min(delay * 2, maxMs);
    }
  }
}

// Bounded wait for the reservation's targets to report healthy, with the
// soft warning (default 15 s) and the hard deadline
// (NEURON_WAIT_TIMEOUT_SECONDS, default 40 s). Mirrors the core's
// waitForHealthy failure semantics (a
// failed target aborts immediately; the deadline throws a states summary).
async function waitHealthyWithSoftWarn({ client, reservationId, config, now = Date.now, sleepFn = sleep, warn = () => {} }) {
  const hardMs = config.waitTimeoutMs;
  const softMs = Math.min(SOFT_WAIT_TIMEOUT_MS, Math.floor(hardMs / 2));
  const hardLabel = hardMs < 1000 ? `${hardMs}ms` : `${Math.floor(hardMs / 1000)}s`;
  const startedAt = now();
  let softWarned = false;
  let lastStates = "";
  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= hardMs) {
      throw new Error(
        `timed out after ${hardLabel} waiting for NeurOn reservation ${reservationId} to become healthy${lastStates ? ` (${lastStates})` : ""}`
      );
    }
    let resStatus;
    try {
      resStatus = await client.request(`/api/reservations/${encodeURIComponent(reservationId)}/status`);
    } catch (e) {
      // A poll failure is not a reservation failure — keep waiting until
      // the hard deadline (the control plane may be flapping).
      lastStates = "status poll failed";
      await sleepFn(config.pollMs);
      continue;
    }
    const targets = resStatus.targets ?? [];
    const failed = targets.find((t) => t.observed === "failed");
    if (failed) throw new Error(`NeurOn target ${failed.id} failed: ${failed.message ?? "unknown"}`);
    if (targets.length > 0 && targets.every((t) => t.observed === "healthy")) return resStatus;
    lastStates = targets.map((t) => `${t.id}:${t.observed}`).join(", ");
    if (!softWarned && elapsed >= softMs) {
      softWarned = true;
      warn(`warming up — waiting up to ${hardLabel} for the target to become healthy`);
    }
    await sleepFn(config.pollMs);
  }
}

// ── Commands ──────────────────────────────────────────────

// `resolve --model M [--profile P]` → JSON {managed, targetId?, reason?}
// Bounded (≤3 s) — the launcher uses this to decide: managed → ensure;
// not managed → launch codex immediately; unreachable → warn + launch.
export async function cmdResolve({ args, env = process.env, io = defaultIo, client, codexHome, readText }) {
  const model = args.model;
  if (!model || model === true) {
    io.err("NeurOn: usage: neuron-codex resolve --model <model> [--profile <name>]");
    return 2;
  }
  let config;
  try {
    config = loadCodexConfig(env);
  } catch (e) {
    io.err(`NeurOn: ${e.message}`);
    return 2;
  }
  const { provider } = resolveCodexModel(
    args.profile ? ["--profile", String(args.profile)] : [],
    { codexHome: codexHome ?? codexHomeFromEnv(env), readText }
  );
  const activeClient = client ?? makeClient(config, { requestTimeoutMs: RESOLVE_REQUEST_TIMEOUT_MS });
  try {
    const status = await activeClient.getStatus();
    const result = resolveModelStatus(status, model, config, provider);
    const output = result.managed
      ? { managed: true, targetId: result.targetId }
      : { managed: false, reason: result.reason };
    io.out(JSON.stringify(output, null, 2));
    return 0;
  } catch (e) {
    io.out(JSON.stringify({ managed: false, reason: `control_plane_unreachable: ${e.message}` }, null, 2));
    return 0;
  }
}

// `ensure --model M [--lease-file F]` → adopt-or-create + bounded wait,
// then the atomic lease write. stdout carries the lease path on success
// (the launcher hands it to the keeper). Exit 2 on reservation failure,
// 0 with a stderr warning when the control plane is unreachable (fail-open;
// the launcher decides whether to launch codex).
export async function cmdEnsure({ args, env = process.env, io = defaultIo, stateDir, client, codexHome, readText, sleep: sleepFn }) {
  const model = args.model;
  if (!model || model === true) {
    io.err("NeurOn: usage: neuron-codex ensure --model <model> [--lease-file <file>]");
    return 2;
  }
  let config;
  try {
    config = loadCodexConfig(env);
  } catch (e) {
    io.err(`NeurOn: ${e.message}`);
    return 2;
  }
  const dir = stateDir ?? stateDirFromEnv(env);
  const activeClient = client ?? makeClient(config);

  let status;
  try {
    status = await activeClient.getStatus();
  } catch (e) {
    io.err(
      `NeurOn: control plane unreachable (${e.message}) — no reservation secured; the launcher decides how to proceed`
    );
    return 0; // fail-open
  }

  const { provider } = resolveCodexModel(
    args.profile ? ["--profile", String(args.profile)] : [],
    { codexHome: codexHome ?? codexHomeFromEnv(env), readText }
  );
  const resolution = resolveModelStatus(status, model, config, provider);
  if (!resolution.managed) {
    io.err(`NeurOn: ${resolution.reason}`);
    return 2;
  }
  const targetId = resolution.targetId;

  // Username discovery (one GET /api/me, memoized on the injected scope) so
  // adoption only ever picks up this user's reservations — the server-side
  // reservation APIs are owner-scoped.
  const scope = { username: undefined, isAdmin: false };
  await resolveUsername(activeClient, scope, (m) => io.err(`NeurOn: ${m}`));

  // Adopt an active reservation for the target, else create one. The prompt
  // hook performs the healthy/no-reservation pass-through before invoking this
  // command; the standalone `ensure` command retains its explicit semantics.
  let reservation = findActiveReservationForTarget(status, targetId, scope);
  let adopted = reservation !== null;
  if (!reservation) {
    try {
      reservation = await withTransientRetries(
        () => activeClient.createReservation({ modelIds: resolution.match.modelIds, targetIds: resolution.match.targetIds }),
        config
      );
    } catch (e) {
      io.err(`NeurOn: reservation creation failed: ${e?.message ?? e}`);
      return 2;
    }
  }
  const reservationId = reservation.reservationId;

  try {
    await waitHealthyWithSoftWarn({
      client: activeClient,
      reservationId,
      config,
      sleepFn: sleepFn ?? sleep,
      warn: (msg) => io.err(`NeurOn: ${msg}`)
    });
  } catch (e) {
    io.err(`NeurOn: ${e?.message ?? e}`);
    // A reservation WE just created must not be left holding capacity until
    // TTL expiry when the target never became healthy — end it best-effort.
    // Adopted reservations are never touched here (other sessions/users may
    // still need them; the server rejects foreign ends anyway).
    if (!adopted) {
      try {
        await activeClient.markReservationDone(reservationId);
        io.err(`NeurOn: reservation ${reservationId} ended (warmup failed)`);
      } catch {
        /* best effort — the reservation lapses at TTL */
      }
    }
    return 2;
  }

  const expiresAt = reservation.expiresAt;
  const lifetimeMs = Math.max(0, Date.parse(expiresAt ?? "") - Date.now());
  const lease = {
    reservationId,
    targetId,
    model,
    expiresAt,
    lifetimeMs,
    sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
    pid: null, // placeholder — the launcher stamps the codex PID after spawn
    createdAt: new Date().toISOString(),
    lastExtendAt: new Date().toISOString()
  };
  const leaseFile = typeof args["lease-file"] === "string" ? args["lease-file"] : path.join(dir, `${reservationId}.json`);
  try {
    await writeLeaseAtomic(path.dirname(leaseFile), lease, path.basename(leaseFile));
  } catch (e) {
    io.err(`NeurOn: failed to write lease file ${leaseFile}: ${e?.message ?? e}`);
    return 2;
  }
  io.err(
    `NeurOn: reservation ${reservationId} ${adopted ? "adopted" : "created"} for target ${targetId} (expires ${formatClock(expiresAt)})`
  );
  io.out(leaseFile);
  return 0;
}

// `keeper --lease-file F --pid P` — the detached coprocess: 5 s loop of
// PID-liveness + core keepalive policy tick; logs to <stateDir>/keeper.log.
export async function cmdKeeper({ args, env = process.env, io = defaultIo, stateDir, client, isPidAlive: aliveFn, sleep: sleepFn, now, log, tickMs, writeLease, maxTicks }) {
  const leaseFile = args["lease-file"];
  const pidArg = args.pid;
  if (!leaseFile || leaseFile === true || !pidArg || pidArg === true) {
    io.err("NeurOn: usage: neuron-codex keeper --lease-file <file> --pid <pid>");
    return 1;
  }
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) {
    io.err(`NeurOn: invalid pid: ${pidArg}`);
    return 1;
  }
  let config;
  try {
    config = loadCodexConfig(env);
  } catch (e) {
    io.err(`NeurOn: ${e.message}`);
    return 1;
  }
  const dir = stateDir ?? stateDirFromEnv(env);
  const activeClient = client ?? makeClient(config);

  let lease;
  try {
    lease = JSON.parse(await fs.readFile(leaseFile, "utf8"));
  } catch (e) {
    io.err(`NeurOn: cannot read lease file ${leaseFile}: ${e.message}`);
    return 1;
  }
  if (!lease.reservationId) {
    io.err(`NeurOn: lease file ${leaseFile} is missing reservationId`);
    return 1;
  }

  const logFn = log ?? ((line) => appendKeeperLog(dir, line));

  // Stamp the codex PID into the lease (best effort — the keeper is the
  // process that knows both the lease path and the PID). The process name
  // is recorded alongside: the keeper loop uses it on every tick to detect
  // PID reuse (a reused number now belongs to a different image name).
  lease.pid = pid;
  const processNameFn = args.getProcessName ?? getProcessName;
  const processName = await processNameFn(pid);
  if (processName) lease.processName = processName;
  try {
    await writeLeaseAtomic(path.dirname(leaseFile), { ...lease }, path.basename(leaseFile));
  } catch {
    /* best effort */
  }

  // Awaiting the stop log matters: the direct-run gate process.exit()s as
  // soon as main() resolves, so an un-awaited append would be lost.
  await Promise.resolve(
    logFn(`keeper start: pid=${pid} reservation=${lease.reservationId} target=${lease.targetId ?? "?"} lease=${leaseFile}`)
  );
  if (lease.expiresAt && Date.parse(lease.expiresAt) < Date.now()) {
    await Promise.resolve(logFn(`keeper stop: reservation ${lease.reservationId} already expired`));
    return 1;
  }

  return keeperLoop({
    lease,
    pid,
    client: activeClient,
    config,
    tickMs: tickMs ?? positiveNumber(env.NEURON_KEEPER_TICK_MS, DEFAULT_KEEPER_TICK_MS),
    stateDir: path.dirname(leaseFile),
    leaseFile,
    now: now ?? (() => Date.now()),
    sleepFn: sleepFn ?? sleep,
    isPidAlive: aliveFn ?? isPidAlive,
    getProcessName: processNameFn,
    log: logFn,
    writeLease: writeLease ?? writeLeaseAtomic,
    maxTicks
  });
}

// Append one ISO-8601-prefixed line (best-effort, rotated at 1 MiB to
// <file>.1). keeper.log and hook.log share this.
async function appendLog(file, line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const st = await fs.stat(file).catch(() => null);
    if (st && st.size > 1024 * 1024) {
      await fs.rename(file, `${file}.1`).catch(() => {});
    }
    await fs.appendFile(file, entry, "utf8");
  } catch {
    /* the log is best-effort; never let it kill the keeper/hook */
  }
}

async function appendKeeperLog(stateDir, line) {
  return appendLog(path.join(stateDir, "keeper.log"), line);
}

// The one shared ADDITIVE extend (fromNow:false): extend the reservation,
// best-effort rewrite the lease file with the advanced expiry + lastExtendAt,
// and return the human-readable result line. Used by `extend`, the MCP tool,
// and the PostToolUse keepalive tick.
async function doExtend({ client, dir, lease, minutes }) {
  const extended = await client.extendReservation(lease.reservationId, minutes, { fromNow: false });
  const leaseFile = path.join(dir, `${lease.reservationId}.json`);
  try {
    // Merge over the RAW lease file (not the enumerated entry) so original
    // fields (createdAt, lastActivityAt, …) survive the rewrite.
    let raw = lease;
    try {
      const disk = JSON.parse(await fs.readFile(leaseFile, "utf8"));
      // Validate: the file on disk must be for the SAME reservation we intend
      // to extend. If it was replaced between pick (e.g. by a concurrent
      // keeper writing a different lease to the same path), merging over it
      // would advance the wrong reservation's lease — fall back to the
      // in-memory lease we were given.
      if (disk.reservationId === lease.reservationId) {
        raw = { ...disk };
      } else {
        process.stderr.write(
          `neuron-codex: lease file mismatch (disk=${disk.reservationId ?? "null"}, expected=${lease.reservationId}), using in-memory\n`
        );
      }
    } catch {
      /* fall back to the entry we were given */
    }
    await writeLeaseAtomic(dir, {
      ...raw,
      expiresAt: extended.expiresAt,
      lifetimeMs: Math.max(0, Date.parse(extended.expiresAt ?? "") - Date.now()),
      lastExtendAt: new Date().toISOString()
    }, path.basename(leaseFile));
  } catch {
    /* best effort */
  }
  return `NeurOn: reservation ${extended.reservationId ?? lease.reservationId} extended to ${formatClock(extended.expiresAt)} (+${minutes} min)`;
}

// `extend --minutes N [--lease-id ID]` — the manual path (no LLM). Additive
// (fromNow:false); prints `NeurOn: reservation <id> extended to <clock> (+N min)`.
export async function cmdExtend({ args, env = process.env, io = defaultIo, stateDir, client }) {
  let config;
  try {
    config = loadCodexConfig(env);
  } catch (e) {
    io.err(`NeurOn: ${e.message}`);
    return 2;
  }
  const dir = stateDir ?? stateDirFromEnv(env);
  const activeClient = client ?? makeClient(config);

  // Minutes may be positional (`extend 5`, matching the /neuron-extend N
  // habit) or `--minutes N`; both fall back to the configured default.
  const minutes = parseMinutes(args._?.[1] ?? args.minutes, config.durationMinutes);

  let lease;
  if (typeof args["lease-id"] === "string") {
    if (!validateLeaseId(args["lease-id"])) {
      io.err(`NeurOn: invalid --lease-id ${args["lease-id"]} (expected a reservation id)`);
      return 2;
    }
    const file = path.join(dir, `${args["lease-id"]}.json`);
    try {
      lease = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      io.err(`NeurOn: no lease file for --lease-id ${args["lease-id"]} in ${dir}`);
      return 2;
    }
  } else {
    lease = await pickLatestActiveLease(dir);
    if (!lease) {
      io.err(`NeurOn: no active lease found in ${dir}`);
      return 2;
    }
  }
  if (!lease.reservationId) {
    io.err(`NeurOn: lease file has no reservationId`);
    return 2;
  }

  try {
    // doExtend also keeps the lease file current (best effort) so
    // `leases`/`status` and a later keeper see the advanced expiry.
    io.out(await doExtend({ client: activeClient, dir, lease, minutes }));
    return 0;
  } catch (e) {
    if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
      io.err(`NeurOn: extend rejected — ${e.body || e.message}`);
    } else {
      io.err(`NeurOn: control plane unreachable — try again (${e?.message ?? e})`);
    }
    return 2;
  }
}

// `done [--lease-id ID]` — mark the active reservation done (same as the web
// UI "I'm Done" button). No arguments needed; picks the latest active lease.
// Marks the lease file inactive so the keeper stops polling it.
export async function cmdDone({ args, env = process.env, io = defaultIo, stateDir, client }) {
  let config;
  try {
    config = loadCodexConfig(env);
  } catch (e) {
    io.err(`NeurOn: ${e.message}`);
    return 2;
  }
  const dir = stateDir ?? stateDirFromEnv(env);
  const activeClient = client ?? makeClient(config);

  let lease;
  if (typeof args["lease-id"] === "string") {
    if (!validateLeaseId(args["lease-id"])) {
      io.err(`NeurOn: invalid --lease-id ${args["lease-id"]} (expected a reservation id)`);
      return 2;
    }
    const file = path.join(dir, `${args["lease-id"]}.json`);
    try {
      lease = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      io.err(`NeurOn: no lease file for --lease-id ${args["lease-id"]} in ${dir}`);
      return 2;
    }
  } else {
    lease = await pickLatestActiveLease(dir);
    if (!lease) {
      io.err(`NeurOn: no active lease found in ${dir}`);
      return 2;
    }
  }
  if (!lease.reservationId) {
    io.err(`NeurOn: lease file has no reservationId`);
    return 2;
  }

  try {
    const result = await activeClient.markReservationDone(lease.reservationId);
    // Mark the lease file inactive (best effort) so the keeper stops polling.
    const leaseFile = path.join(dir, `${lease.reservationId}.json`);
    try {
      let raw = lease;
      try {
        const disk = JSON.parse(await fs.readFile(leaseFile, "utf8"));
        if (disk.reservationId === lease.reservationId) {
          raw = { ...disk };
        }
      } catch { /* fall back to the entry we were given */ }
      await writeLeaseAtomic(dir, {
        ...raw,
        active: false,
        endedAt: new Date().toISOString()
      }, path.basename(leaseFile));
    } catch { /* best effort */ }
    io.out(`NeurOn: reservation ${result?.reservationId ?? lease.reservationId} ended`);
    return 0;
  } catch (e) {
    if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
      io.err(`NeurOn: end rejected — ${e.body || e.message}`);
    } else {
      io.err(`NeurOn: control plane unreachable — try again (${e?.message ?? e})`);
    }
    return 2;
  }
}

// Validate a `--lease-id` before it is interpolated into a state-dir path.
// Lease files are <stateDir>/<reservationId>.json, so a legal id can never
// contain a path separator, NUL, or "."-traversal. Rejects everything else
// up front instead of relying on the downstream read failing.
export function validateLeaseId(leaseId) {
  return typeof leaseId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(leaseId);
}

// Minutes: the argument when given (must be an integer 1-720), else the
// configured default (NEURON_RESERVATION_DURATION_MINUTES, default 2).
export function parseMinutes(raw, fallback) {
  const s = String(raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 720) return n;
  return fallback;
}

// `leases` → JSON summary of the local lease files (no network).
export async function cmdLeases({ env = process.env, io = defaultIo, stateDir }) {
  const dir = stateDir ?? stateDirFromEnv(env);
  const leases = await listLeases(dir);
  io.out(JSON.stringify({ stateDir: dir, count: leases.length, leases }, null, 2));
  return 0;
}

// `status` → JSON: local leases + the control-plane status (bounded; an
// unreachable control plane is reported, not fatal).
export async function cmdStatus({ env = process.env, io = defaultIo, stateDir, client }) {
  const dir = stateDir ?? stateDirFromEnv(env);
  const leases = await listLeases(dir);
  let controlPlane = null;
  try {
    const config = loadCodexConfig(env);
    const activeClient = client ?? makeClient(config);
    controlPlane = await activeClient.getStatus();
  } catch (e) {
    controlPlane = { reachable: false, error: e?.message ?? String(e) };
  }
  io.out(JSON.stringify({ stateDir: dir, count: leases.length, leases, controlPlane }, null, 2));
  return 0;
}

// ── Lifecycle-hook gate (`hook` subcommand; Codex ≥0.148) ──
// Codex spawns `node <install>\neuron-codex.js hook <event>`, writes the
// event payload JSON to our stdin (then closes it), and reads our stdout:
//   UserPromptSubmit — the gate. model from payload.model (fallback: the
//     config model) → bounded resolve (≤3 s) → ensure (adopt/create + bounded
 //     healthy wait, capped at min(NEURON_WAIT_TIMEOUT_SECONDS, 290) s —
 //     always under the 300 s hook timeout so the hook emits an explicit
 //     decision instead of being killed). Success: EMPTY stdout, exit 0
//     (plain text on stdout is injected into the model context). Expected
//     reservation failure: stdout exactly {"decision":"block",
//     "reason":"NeurOn: …"}, exit 0 (reason required by codex).
//   PostToolUse — activity mark + conditional keepalive extend (only past
//     the extend floor). NEVER blocks: a keepalive failure must not stop an
//     agent turn.
//   SessionStart — always a no-op; reservations begin at UserPromptSubmit.
//   `hook trust <event_snake> <command> <timeout>` — prints the 0.151.0
//     trust hash of the normalized hook identity (sync.ps1/.sh use it to
//     pre-seed [hooks.state."…"] trusted_hash).
// All diagnostics go to the hook log (NEURON_LOG_FILE, default
// <stateDir>/hook.log, rotated). Unexpected error → stderr + exit 1 →
// codex fails open (documented; matches the wrapper's fail-open behavior).

// The UserPromptSubmit gate. `say` is the awaited
// hook-log writer; `io.out` is used ONLY for the explicit block decision.
async function promptSubmitGate({ env, dir, client, payload, io, say, codexHome, readText, sleepFn }) {
  const home = codexHome ?? codexHomeFromEnv(env);
  let model = typeof payload.model === "string" && payload.model ? payload.model : undefined;
  if (!model) model = resolveCodexModel([], { codexHome: home, readText }).model;
  if (!model) {
    await say("gate: no model resolvable (payload.model missing, no config model) — pass");
    return 0;
  }

  // Bounded resolve (≤3 s): a dead control plane can never stall the hook.
  const config = loadCodexConfig(env);
  const gateClient = client ?? makeClient(config, { requestTimeoutMs: RESOLVE_REQUEST_TIMEOUT_MS });
  let status;
  try {
    status = await gateClient.getStatus();
  } catch (e) {
    await say(`gate: control plane unreachable (${e.message}) — pass (fail-open)`);
    return 0;
  }
  const resolution = resolveModelStatus(
    status,
    model,
    config,
    resolveCodexModel([], { codexHome: home, readText }).provider
  );
  if (!resolution.managed) {
    await say(`gate: ${resolution.reason} — pass`);
    return 0;
  }
  const target = (status.capacityTargets ?? []).find((candidate) => candidate.id === resolution.targetId);
  if (target?.observed === "healthy" && !findActiveReservationForTarget(status, resolution.targetId)) {
    await say("gate: target healthy with no reservation — pass");
    return 0;
  }

  // Ensure with the hook wait cap: min(env, 290) s < the 300 s hook timeout,
  // so the hook ALWAYS finishes in time with an explicit decision. The poll
  // interval is also capped at half the wait so a short cap stays responsive.
  const waitSeconds = hookWaitSeconds(env);
  const hookEnv = {
    ...env,
    NEURON_WAIT_TIMEOUT_SECONDS: String(waitSeconds),
    NEURON_WAIT_POLL_SECONDS: String(
      Math.min(positiveNumber(env.NEURON_WAIT_POLL_SECONDS, 5), Math.max(0.05, waitSeconds / 2))
    )
  };
  // Capture cmdEnsure's output so the lease path never reaches the hook's
  // real stdout (stdout discipline) and so we can tell success (lease path
  // printed) apart from the fail-open path (warning only).
  const captured = { out: [], err: [] };
  const code = await cmdEnsure({
    args: { model },
    env: hookEnv,
    io: { out: (s) => captured.out.push(s), err: (s) => captured.err.push(s) },
    stateDir: dir,
    client: gateClient,
    codexHome: home,
    readText,
    sleep: sleepFn
  });
  for (const line of captured.err) await say(line.replace(/^NeurOn: /, ""));
  if (code === 0) {
    if (captured.out.length > 0) {
      await say(`gate: reservation secured (lease ${captured.out[captured.out.length - 1]})`);
      return 0; // success — EMPTY stdout, exit 0
    }
    await say("gate: control plane unreachable during ensure — pass (fail-open)");
    return 0;
  }
  // Expected reservation failure (create rejected / healthy-wait timeout /
  // failed target / lease write) → explicit block (reason required by codex).
  const reason = captured.err[captured.err.length - 1] ?? "NeurOn: reservation failure";
  await say(`gate: blocking the turn — ${reason}`);
  io.out(JSON.stringify({ decision: "block", reason }));
  return 0;
}

// PostToolUse activity: mark the local lease and extend when the core policy
// says it is due (≥ max(50% lifetime, 30 s) since the last extend). Additive
// (fromNow:false) via the shared doExtend. Never blocks, never fails the
// turn — the reservation simply expires naturally if the control plane
// cannot be reached.
async function postToolUseActivity({ env, dir, client, payload, say, now }) {
  const config = loadCodexConfig(env);
  const activeLeases = (await listLeases(dir)).filter((l) => l.active);
  if (activeLeases.length === 0) {
    await say("PostToolUse: no active lease — nothing to keep alive");
    return 0;
  }
  // Prefer THIS session's lease (sessionId from the hook payload), then the
  // lease for this turn's model (payload.model), then fall back to the latest
  // active lease. Without the session match, activity in one codex session
  // could extend another session's reservation.
  const sessionId =
    (typeof payload.sessionId === "string" && payload.sessionId) ||
    (typeof payload.session_id === "string" && payload.session_id) ||
    (typeof payload.threadId === "string" && payload.threadId) ||
    undefined;
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const entry =
    (sessionId && activeLeases.find((l) => l.sessionId === sessionId)) ||
    (model && activeLeases.find((l) => l.model === model)) ||
    activeLeases.reduce((a, b) => (b.expiresAtMs > a.expiresAtMs ? b : a));
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(entry.file, "utf8"));
  } catch (e) {
    await say(`PostToolUse: cannot read lease ${entry.file} (${e.message}) — skip`);
    return 0;
  }

  const leaseClient = client ?? makeClient(config, { requestTimeoutMs: 5000 });
  const lifetimeMs = Math.max(0, Date.parse(raw.expiresAt ?? "") - now());
  const lastExtendMs = Date.parse(raw.lastExtendAt ?? raw.createdAt ?? "");
  raw.lastActivityAt = new Date(now()).toISOString();

  // Persist the activity mark FIRST: a subsequent extend re-reads and merges
  // the file, so it must already contain lastActivityAt.
  try {
    await writeLeaseAtomic(dir, raw, path.basename(entry.file));
  } catch (e) {
    await say(`PostToolUse: lease update failed: ${e?.message ?? e}`);
  }

  if (Number.isFinite(lastExtendMs) && isExtendDue(now(), lastExtendMs, lifetimeMs)) {
    try {
      const text = await doExtend({ client: leaseClient, dir, lease: raw, minutes: config.durationMinutes });
      await say(text.replace(/^NeurOn: /, ""));
    } catch (e) {
      await say(`PostToolUse: keepalive extend failed (will retry on the next tool use): ${e?.message ?? e}`);
    }
  } else {
    await say(`PostToolUse: activity marked for reservation=${raw.reservationId ?? entry.reservationId} (extend not due)`);
  }
  return 0;
}

export async function cmdHook({
  args,
  env = process.env,
  io = defaultIo,
  stateDir,
  client,
  codexHome,
  readText,
  readStdin,
  sleep: sleepFn,
  now = () => Date.now(),
  log: logOverride
}) {
  const event = args._?.[1];

  // `hook trust` — the trust-hash helper used by sync.ps1/.sh.
  if (event === "trust") {
    const [eventName, command, timeoutRaw] = [args._?.[2], args._?.[3], args._?.[4]];
    const timeoutSec = Number(timeoutRaw);
    if (!eventName || !command || !Number.isInteger(timeoutSec) || timeoutSec < 1) {
      io.err("NeurOn: usage: neuron-codex hook trust <event_snake> <command> <timeout_sec>");
      return 1;
    }
    io.out(hookTrustHash({ eventName, command, timeoutSec }));
    return 0;
  }
  if (event !== "UserPromptSubmit" && event !== "PostToolUse" && event !== "SessionStart") {
    io.err(`NeurOn: usage: neuron-codex hook <UserPromptSubmit|PostToolUse|SessionStart|trust>`);
    return 1;
  }

  const dir = stateDir ?? stateDirFromEnv(env);
  const logFn = logOverride ?? ((line) => appendLog(env.NEURON_LOG_FILE || path.join(dir, "hook.log"), line));
  const say = (line) => Promise.resolve(logFn(line));

  // The event payload arrives on stdin (codex writes the JSON, then closes).
  let payload = {};
  try {
    const text = await (readStdin ?? ((s) => readStream(s)))(process.stdin);
    if (text && text.trim()) payload = JSON.parse(text);
  } catch (e) {
    io.err(`NeurOn: hook ${event} failed: unreadable payload on stdin (${e?.message ?? e})`);
    await say(`${event} failed: unreadable payload (${e?.message ?? e})`);
    return 1; // codex fails open
  }

  try {
    if (event === "PostToolUse") {
      return await postToolUseActivity({ env, dir, client, payload, say, now });
    }
    if (event === "SessionStart") {
      await say("SessionStart: no-op (reservations start only on UserPromptSubmit)");
      return 0;
    }
    return await promptSubmitGate({ env, dir, client, payload, io, say, codexHome, readText, sleepFn });
  } catch (e) {
    // Unexpected error (our bug, not a reservation failure): stderr + exit 1.
    // Codex treats a non-zero exit as Failed = fail-open (the turn proceeds) —
    // the intended, documented behavior, matching the wrapper.
    io.err(`NeurOn: hook ${event} failed: ${e?.stack ?? e}`);
    await say(`${event} failed: ${e?.message ?? e}`);
    return 1;
  }
}

// ── MCP stdio server (`mcp` subcommand) ───────────────────
// Hand-rolled JSON-RPC 2.0 over stdio (no dependencies). Handles initialize,
// ping, notifications (ignored), tools/list, tools/call. Exactly one tool:
// neuron_extend { minutes: integer 1-720 } → the shared additive extend of
// the latest active lease. Newline-delimited messages.

const NEURON_EXTEND_TOOL = {
  name: "neuron_extend",
  description:
    "Extend the active NeurOn reservation (the latest active local lease) by N minutes. " +
    "Additive: the server computes expiry = max(now, current expiry) + N. Pass an integer 1-720.",
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "integer", minimum: 1, maximum: 720, description: "Minutes to add (1-720)" }
    },
    required: ["minutes"],
    additionalProperties: false
  }
};

// One JSON-RPC line → response object, a Promise of one, or null (no
// response: notification / undecodable line). Exported for deterministic
// tests (no stdio needed).
export function handleMcpMessage(line, ctx) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification — never respond
  const reply = (resultOrError) => ({ jsonrpc: "2.0", id, ...resultOrError });
  switch (method) {
    case "initialize": {
      const protocolVersion =
        params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return reply({
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "neuron", version: "1.0.0" }
        }
      });
    }
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: [NEURON_EXTEND_TOOL] } });
    case "tools/call":
      return (async () => {
        const text = (s) => ({ content: [{ type: "text", text: s }] });
        if (params?.name !== "neuron_extend") {
          return reply({ result: { ...text(`NeurOn: unknown tool "${params?.name}"`), isError: true } });
        }
        const minutes = params?.arguments?.minutes;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
          return reply({
            result: { ...text(`NeurOn: minutes must be an integer 1-720 (got ${JSON.stringify(minutes)})`), isError: true }
          });
        }
        let setup;
        try {
          setup = await ctx.setup();
        } catch (e) {
          return reply({ result: { ...text(`NeurOn: ${e?.message ?? e}`), isError: true } });
        }
        const lease = await pickLatestActiveLease(setup.dir);
        if (!lease) {
          return reply({ result: { ...text(`NeurOn: no active lease found in ${setup.dir}`), isError: true } });
        }
        try {
          const out = await doExtend({ client: setup.client, dir: setup.dir, lease, minutes });
          return reply({ result: { ...text(out), isError: false } });
        } catch (e) {
          return reply({ result: { ...text(`NeurOn: extend rejected — ${(e?.body || e?.message) ?? String(e)}`), isError: true } });
        }
      })();
    default:
      return reply({ error: { code: -32601, message: `method not found: ${method}` } });
  }
}

// The stdio loop: newline-delimited JSON-RPC, processed sequentially.
export async function runMcpServer({ input = process.stdin, output = process.stdout, env = process.env, stateDir, client } = {}) {
  const setup = async () => {
    const config = loadCodexConfig(env);
    return { config, client: client ?? makeClient(config), dir: stateDir ?? stateDirFromEnv(env) };
  };
  const ctx = { setup };
  let chain = Promise.resolve();
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    // Cap the buffer: a malformed client sending a huge line without a
    // newline could grow the buffer unboundedly. 1 MB is well above any
    // legitimate JSON-RPC line. Discard it (no response: the line was never
    // newline-terminated, so no id was ever seen) rather than OOM.
    if (buffer.length > 1000000) {
      process.stderr.write("neuron-codex mcp: input line exceeds 1MB cap, discarding buffer\n");
      buffer = "";
      return;
    }
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        const response = handleMcpMessage(line, ctx);
        if (response === null) return;
        const finalResponse = await response;
        if (finalResponse) output.write(`${JSON.stringify(finalResponse)}\n`);
      });
    }
  });
  await new Promise((resolve, reject) => {
    input.on("end", resolve);
    input.on("error", reject);
  });
  await chain;
  return 0; // clean exit on stdin EOF (codex closes the pipe on shutdown)
}

// ── Entry point ───────────────────────────────────────────

export function printUsage(stream = process.stdout) {
  stream.write(`NeurOn Codex CLI — reservation gate + keeper for the Codex CLI
(wrapper mode 0.93.0; lifecycle-hook mode ≥0.148, target 0.151.0)

Usage: neuron-codex <command> [options]

Commands:
  resolve --model M [--profile P]    Print {managed, targetId?, reason?} JSON (bounded, ≤3 s)
  ensure --model M [--lease-file F]  Adopt-or-create the reservation, bounded wait
                                       (soft 15 s / hard 40 s, NEURON_WAIT_TIMEOUT_SECONDS), write the
                                      lease file; prints the lease path on success
  keeper --lease-file F --pid P      Keep the lease alive while the codex PID is alive
                                      (5 s tick, additive extend fromNow:false, logs to
                                      <stateDir>/keeper.log)
  extend [minutes] [--minutes N] [--lease-id I]
                                      Manually extend a lease (integer 1-720, additive,
                                      default NEURON_RESERVATION_DURATION_MINUTES)
  status                             JSON: local leases + control-plane status
  leases                             JSON: local lease files
  hook <event>                       Lifecycle-hook gate (Codex ≥0.148): reads the
                                       event payload on stdin.
                                       UserPromptSubmit — gate the first prompt
                                       (empty stdout on success; explicit
                                       {"decision":"block",...} on reservation
                                        failure; wait capped at min(
                                        NEURON_WAIT_TIMEOUT_SECONDS, 290) s)
                                       PostToolUse — activity mark + conditional
                                       keepalive (never blocks)
                                       SessionStart — no-op; reservations begin on prompts
                                       hook trust <event_snake> <command> <timeout>
                                       — print the 0.151.0 trust hash
  mcp                                stdio JSON-RPC MCP server: one tool,
                                        neuron_extend { minutes: integer 1-720 }
  toml-escape <value>                Print <value> escaped for a TOML basic
                                        string (single pass over the FULL
                                        value; used by sync to splice
                                        ~/.codex/config.toml)

Exit codes: 0 ok (including fail-open), 1 usage/operational error,
2 reservation failure (the launcher must not launch codex).

State: ~/.codex/neuron/<lease-id>.json (NEURON_STATE_DIR overrides).
Env: NEURON_API_BASE_URL, NEURON_API_KEY, NEURON_ALLOWED_PROVIDERS,
NEURON_RESERVATION_DURATION_MINUTES, NEURON_WAIT_TIMEOUT_SECONDS, NEURON_WAIT_POLL_SECONDS,
NEURON_LOG_FILE (hook log); NEURON_CODEX_PREWARM is ignored for compatibility.
`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  const command = parsed._[0];
  if (!command || parsed.help || command === "help") {
    printUsage(process.stderr);
    return command ? 0 : 1;
  }
  const io = defaultIo;
  switch (command) {
    case "resolve":
      return cmdResolve({ args: parsed, env, io });
    case "ensure":
      return cmdEnsure({ args: parsed, env, io });
    case "keeper":
      return cmdKeeper({ args: parsed, env, io });
    case "extend":
      return cmdExtend({ args: parsed, env, io });
    case "done":
      return cmdDone({ args: parsed, env, io });
    case "status":
      return cmdStatus({ args: parsed, env, io });
    case "leases":
      return cmdLeases({ args: parsed, env, io });
    case "hook":
      return cmdHook({ args: parsed, env, io });
    case "mcp":
      return runMcpServer({ env });
    case "toml-escape": {
      const value = parsed._[1];
      if (value === undefined) {
        io.err("NeurOn: usage: neuron-codex toml-escape <value>");
        return 1;
      }
      // Machine-consumed output: exactly the escaped text, no trailing
      // newline (callers capture stdout and Trim() defensively).
      process.stdout.write(tomlEscape(value));
      return 0;
    }
    default:
      process.stderr.write(`NeurOn: unknown command "${command}"\n`);
      printUsage(process.stderr);
      return 1;
  }
}

// Direct-run gate: the bundled artifact is launched by the launcher as
// `node neuron-codex.js <command>`; when imported by tests, main() must not
// run and the process must not exit on import.
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then((code) => process.exit(code), (e) => {
      process.stderr.write(`NeurOn: unexpected error: ${e?.stack ?? e}\n`);
      process.exit(1);
    });
}
