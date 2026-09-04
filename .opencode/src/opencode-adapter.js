// OpenCode adapter for the shared NeurOn core (../../shared/neuron-core).
// Manages reservation lifecycle: cold-start detection → reservation → warmup wait → healthy
// Config via env: NEURON_API_BASE_URL, NEURON_API_KEY, NEURON_ALLOWED_PROVIDERS (optional provider filter)
//
// This source is bundled by `npm run build` (esbuild) into ../plugins/neuron.js
// — the single-file installed artifact that OpenCode auto-loads. Harness
// concerns (OpenCode events, TUI toasts, keepalive setInterval timers, the
// log file) live here; the reservation client + policy live in the core.

import fs from "node:fs/promises";
import {
  NeurOnClient,
  NeurOnApiError,
  loadConfig,
  matchesAllowedProvider,
  splitProvider,
  canonicalizeModel,
  matchLiteLlmModel,
  getCachedStatus,
  getLiveStatus,
  getTargetStateNow,
  getTargetStateLive,
  shouldBlockForWarmup,
  ensureReservation,
  resolveTargetForModel,
  adoptExistingReservation,
  saveReservation,
  currentSessionGeneration,
  isSessionGenerationCurrent,
  invalidateSessionGeneration,
  markActivity,
  isSessionActive,
  effectiveKeepaliveMinutes,
  keepaliveIntervalMs,
  formatClock,
  formatWarmupTimeoutMs
} from "../../shared/neuron-core/index.js";

const NEURON_LOG_FILE = process.env.NEURON_LOG_FILE ||
  (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\neuron-plugin.log` : `${process.env.HOME || "."}/neuron-plugin.log`);
const NEURON_LOG_MAX_BYTES = (() => {
  const v = Number(process.env.NEURON_LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024; // 5 MB default
})();
let _logSize = 0;
let _rotating = false;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  _logSize += Buffer.byteLength(line, "utf8");
  if (_logSize > NEURON_LOG_MAX_BYTES && !_rotating) {
    // Re-entrancy guard: concurrent async log() calls can interleave between
    // the size check and the rename, corrupting _logSize. The flag ensures
    // only one rotation runs at a time; concurrent calls skip rotation and
    // just append (rotation happens on the next tick).
    _rotating = true;
    fs.rename(NEURON_LOG_FILE, `${NEURON_LOG_FILE}.1`)
      .catch(() => {})
      .finally(() => {
        _logSize = 0;
        _rotating = false;
      });
  }
  fs.appendFile(NEURON_LOG_FILE, line).catch(() => {});
}

// SINGLE-INSTANCE INVARIANT: The maps below are module-level, shared by
// every plugin instance created in this process. OpenCode is expected to
// create at most one NeurOnPlugin instance per process. The
// `Symbol.for("neuron.opencode.active-instance")` machinery below disposes
// the prior instance's hooks (timers, etc.) when a new one is constructed,
// but the module-level state maps are NOT isolated per instance — a second
// live instance would read/write the same maps. If OpenCode ever supports
// concurrent plugin instances, move these into the factory closure.
const state = {
  reservations: new Map(),
  inflight: new Map(),
  inflightTarget: new Map(),
  retryState: new Map(),
  keepaliveTimers: new Map(),
  sessionActivity: new Map(), // sessionID → last real agent-work timestamp (ms)
  sessionGenerations: new Map(), // sessionID → int, bumped on session.deleted
  statusCache: { value: null, at: 0, inflight: null } // shared status cache (core status reads)
};
const transportFailures = new Map(); // sessionID → timestamp
const warmupLocks = new Map(); // targetId → { promise }
const lastFailure = new Map(); // sessionID → { at, name, message?, status?, source }
const lastSwitchToastAt = new Map(); // sessionID → timestamp of last model-switch toast
const lastExtendAt = new Map(); // sessionID → timestamp of last /neuron-extend API call
const lastDoneAt = new Map(); // sessionID → timestamp of last /neuron-done API call
const extendInFlight = new Set(); // sessionIDs with an extend call currently in flight
const doneInFlight = new Set(); // sessionIDs with a done call currently in flight
const COMMAND_DEBOUNCE_MS = 2000; // suppress duplicate command calls within this window

// A recorded failure is "recent" for explaining a model switch if it happened
// within this window before the switch was observed.
const FAILURE_CONTEXT_WINDOW_MS = 120000;
// Cooldown between model-switch toasts for the same session (flap guard).
const MODEL_SWITCH_TOAST_COOLDOWN_MS = 60000;
const FAILURE_MESSAGE_MAX_CHARS = 120;

// Adapter-owned callbacks handed to the core: the log writer and the
// keepalive timer arm (setInterval lives here — the core is timer-free).
const coreDeps = {
  log,
  armKeepalive: (resKey, targetId, sessionID, client, generation, restart, remainingMs) =>
    armKeepaliveTimer(resKey, targetId, sessionID, client, generation, restart, remainingMs)
};

// Acquire a shared warmup lock for a target. The first caller becomes the
// "leader" and executes fn() (which should create the reservation and wait
// for healthy). Subsequent callers on the same targetId await the leader's
// promise. On success or failure the lock is released and any queued callers
// proceed.
async function acquireWarmupLock(targetId, fn) {
  const existing = warmupLocks.get(targetId);
  if (existing) {
    log(`warmup lock acquired (queued): targetId=${targetId}`);
    return existing.promise;
  }

  log(`warmup lock acquired (leader): targetId=${targetId}`);
  const promise = fn().finally(() => {
    warmupLocks.delete(targetId);
  });
  warmupLocks.set(targetId, { promise });
  return promise;
}

// Acquire the warmup lock AND ensure this session has its own local reservation
// after the leader's warmup completes. Followers skip their own reservation
// work (the target is already healthy) but still need a local entry so
// keepalive and subsequent refreshes work correctly.
async function acquireWarmupAndEnsure(client, modelId, sessionID, lockTargetId) {
  // Capture the session generation for the post-lock ensure step. The leader's
  // ensureReservation inside the lock captures its own (equal) generation, so
  // both the leader's and this session's state writes are guard-checked.
  const generation = currentSessionGeneration(state, sessionID);
  await acquireWarmupLock(lockTargetId, () =>
    ensureReservation(client, state, modelId, sessionID, coreDeps)
  );
  const resKey = `${sessionID}::${lockTargetId}`;
  if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
    log(`acquireWarmupAndEnsure skipped (session stale): targetId=${lockTargetId} session=${sessionID}`);
    return;
  }
  if (!state.reservations.has(resKey)) {
    await ensureReservation(client, state, modelId, sessionID, coreDeps);
  }
}

// Activity-gated keepalive interval for a reservation. Extends the
// reservation at 50% of the effective lifetime, but ONLY while this session
// has had real agent work within the last keepaliveMinutes (activity grace
// window = config.keepaliveMinutes). When the session is idle the timer stops
// WITHOUT a refresh call; the local reservation entry is retained so the next
// real activity (re-establish or timer re-arm) can pick up where it left off.
//
// restart=true  (saveReservation after a create/adopt/extend): the countdown
//               restarts from 50% of the (new) lifetime.
// restart=false (activity paths — user message, tool, busy status): arm only
//               if no timer is currently running; a live countdown is never
//               reset by activity.
function armKeepaliveTimer(resKey, targetId, sessionID, client, generation, restart, remainingMs) {
  if (restart) {
    stopKeepaliveTimer(resKey);
  } else if (state.keepaliveTimers.has(resKey)) {
    return;
  }
  const current = state.reservations.get(resKey);
  if (!current || !client || !client.config) return;
  // When adopting an existing reservation, use the remaining lifetime for the
  // keepalive interval instead of the full duration. This prevents timer
  // inflation: the keepalive fires at half-remaining, not half-full.
  const lifeMinutes = remainingMs != null
    ? remainingMs / 60000
    : effectiveKeepaliveMinutes(current.reservation);
  const refreshMs = keepaliveIntervalMs(lifeMinutes);
  const timer = setInterval(() => {
    const tickEntry = state.reservations.get(resKey);
    if (!tickEntry) {
      stopKeepaliveTimer(resKey);
      return;
    }
    if (!isSessionActive(state, sessionID, client)) {
      // Idle beyond the activity grace window — stop the timer without a
      // refresh call. Log once per stop, never per tick.
      // Design intent: the grace window (keepaliveMinutes) is intentionally
      // one full lifetime. A session that goes silent for just past the grace
      // (e.g. 121 s with a 120 s grace) will have its reservation expire
      // naturally — this is the "idle → release" behavior, not a bug. Long-
      // quiet sessions are expected to release capacity.
      log(`keepalive stopped (inactive): targetId=${targetId} session=${sessionID}`);
      stopKeepaliveTimer(resKey);
      return;
    }
    client.refreshReservation(tickEntry.reservation.reservationId)
      .then((refreshed) => {
        // Stale guard: do not publish refresh results for a session that was
        // deleted (or re-created) while the extend call was in flight.
        if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
          log(`keepalive refresh ignored (session stale): targetId=${targetId} session=${sessionID}`);
          return;
        }
        const tickEntryNow = state.reservations.get(resKey);
        if (!tickEntryNow) return;
        const mins = effectiveKeepaliveMinutes(refreshed);
        tickEntryNow.reservation = refreshed;
        tickEntryNow.expiresAt = Date.now() + mins * 60 * 1000;
        log(`keepalive refresh: targetId=${targetId} session=${sessionID} reservationId=${refreshed.reservationId}`);
      })
      .catch((e) => {
        log(`keepalive refresh fail: targetId=${targetId} session=${sessionID} error=${e?.message ?? e}`);
        if (e instanceof NeurOnApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          if (isSessionGenerationCurrent(state, sessionID, generation, log)) {
            state.reservations.delete(resKey);
          }
          stopKeepaliveTimer(resKey);
        }
      });
  }, refreshMs);
  timer.unref?.();
  state.keepaliveTimers.set(resKey, timer);
}

function stopKeepaliveTimer(resKey) {
  const timer = state.keepaliveTimers.get(resKey);
  if (timer) {
    clearInterval(timer);
    state.keepaliveTimers.delete(resKey);
  }
}

// Extract the OpenCode session identifier from any event or hook input.
// Handles both the camelCase `sessionID` (primary; confirmed against OpenCode's
// Event schema and hook input types) and camelCase-lower `sessionId` fallbacks.
function extractSessionID(event) {
  return (
    event?.sessionID ??
    event?.sessionId ??
    event?.properties?.sessionID ??
    event?.properties?.sessionId ??
    undefined
  );
}

// OpenCode uses different model shapes for live and resumed hook inputs. Keep
// session hydration resilient when session.created is not replayed.
function extractModelIdentity(input) {
  const candidates = [
    input?.info?.model,
    input?.model,
    input?.properties?.info?.model,
    input?.properties?.model
  ];
  for (const model of candidates) {
    if (!model || typeof model !== "object") continue;
    const id = model.id ?? model.modelID ?? model.modelId;
    if (!id) continue;
    return canonicalizeModel(
      model.providerID ?? model.providerId ?? model.provider,
      id
    );
  }
  return undefined;
}

// Release every piece of per-session state for a given sessionID. Prevents the
// sessionModels map (and any stale reservations/inflight entries) from leaking
// across the lifetime of a long-running TUI that opens and closes many sessions.
function scrubSession(sessionID, sessionModels) {
  if (!sessionID) return;
  // Bump the generation FIRST, before any cleanup, so in-flight async work
  // (reservation creation, warmup, keepalive refresh) launched earlier for
  // this session aborts before writing state once it resumes.
  invalidateSessionGeneration(state, sessionID);
  const prefix = `${sessionID}::`;
  for (const key of [...state.reservations.keys()])
    if (key.startsWith(prefix)) state.reservations.delete(key);
  for (const key of [...state.inflight.keys()])
    if (key.startsWith(prefix)) state.inflight.delete(key);
  for (const key of [...state.inflightTarget.keys()])
    if (key.startsWith(prefix)) state.inflightTarget.delete(key);
  for (const key of [...state.retryState.keys()])
    if (key.startsWith(prefix)) state.retryState.delete(key);
  for (const key of [...state.keepaliveTimers.keys()])
    stopKeepaliveTimer(key);
  // warmupLocks are keyed by targetId (not sessionID) so they survive session scrub;
  // they self-clean via .finally() once the leader's warmup succeeds or fails.
  sessionModels?.delete(sessionID);
  state.sessionActivity.delete(sessionID);
  transportFailures.delete(sessionID);
  lastFailure.delete(sessionID);
  lastSwitchToastAt.delete(sessionID);
}

// ── Background reservation (non-blocking) ─────────────────

function backgroundReserve(client, modelId, sessionID, sessionModels, ctx) {
  log(`background reserve start: model=${modelId} session=${sessionID}`);
  // Capture the generation before the async work starts; ensureReservation
  // re-checks it after each await and aborts if the session was deleted.
  const generation = currentSessionGeneration(state, sessionID);
  (async () => {
    if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
      log(`background reserve skipped (session stale): model=${modelId} session=${sessionID}`);
      return;
    }
    try {
      await ensureReservation(client, state, modelId, sessionID, coreDeps);
      log(`background reserve success: model=${modelId} session=${sessionID}`);
      // Orphaned-reservation tradeoff: if the session was deleted between
      // ensureReservation completing and the local save, the generation guard
      // inside saveReservation skips the write — the server-side reservation
      // exists but has no local keepalive to extend it. This is accepted: the
      // server's own TTL will release it. Do not "fix" by removing the
      // generation guard; the orphan is safer than resurrecting state for a
      // deleted session.
      const info = sessionModels.get(sessionID);
      if (info && ctx.client?.tui?.showToast) {
        info.warmupNotified = false;
        info.errorNotified = false;
        ctx.client.tui.showToast({
          body: {
            message: `NeurOn: model ready`,
            variant: "success"
          }
        });
      }
    } catch (e) {
      log(`background reserve failure: model=${modelId} session=${sessionID} error=${e?.message ?? e}`);
      // Notify user only once per session — classify the failure type
      const info = sessionModels.get(sessionID);
      if (!info || !ctx.client?.tui?.showToast) return;

      if (e.message?.includes("NeurOn:")) {
        if (!info.errorNotified) {
          info.errorNotified = true;
          ctx.client.tui.showToast({
            body: { message: e.message, variant: "error" }
          });
        }
        return;
      }

      if (e instanceof NeurOnApiError) {
        if (e.status === 0) {
          // Timeout/unreachable — fail open silently
          return;
        }
        if (!info.errorNotified) {
          info.errorNotified = true;
          let msg = `NeurOn: reservation failed`;
          if (e.status === 401 || e.status === 403) msg += ' (authentication error)';
          else if (e.status === 429) msg += ' (rate limited — wait and retry)';
          else if (e.status >= 500) msg += ' (server error)';
          else msg += ` (HTTP ${e.status})`;
          ctx.client.tui.showToast({
            body: { message: msg, variant: "error" }
          });
        }
        return;
      }

      // Generic cold/stopped warmup notification — only for truly cold states
      if (!info.warmupNotified) {
        info.warmupNotified = true;
        ctx.client.tui.showToast({
          body: {
            message: `NeurOn: warming up… please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`,
            variant: "warning"
          }
        });
      }
    }
  })();
}

// ── Model-switch explanation toasts ───────────────────────
// OpenCode does not expose a dedicated "fallback" event: a mid-session model
// change is observable only by comparing the model on successive events. When
// such a switch is detected, explain it with the most recent failure the plugin
// recorded for the session (session.error or a session.status retry event) and,
// for a previously NeurOn-managed model, the last observed target state. This
// answers "the server looks up on the site — why did my request fall back?".

function recordSessionFailure(sessionID, failure) {
  if (!sessionID) return;
  lastFailure.set(sessionID, { at: Date.now(), ...failure });
}

function describeFailure(failure) {
  let text = failure?.name || "Error";
  if (failure?.status) text += ` ${failure.status}`;
  if (failure?.message) {
    let msg = String(failure.message).replace(/\s+/g, " ").trim();
    if (msg.length > FAILURE_MESSAGE_MAX_CHARS)
      msg = `${msg.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}…`;
    text += `: ${msg}`;
  }
  return text;
}

function notifyModelSwitch(
  client,
  allowedProviders,
  sessionID,
  ctx,
  oldFullModel,
  newFullModel,
  oldProvider,
  newProvider
) {
  const oldManaged = matchesAllowedProvider(oldProvider, oldFullModel, allowedProviders, log);
  const newManaged = matchesAllowedProvider(newProvider, newFullModel, allowedProviders, log);
  const failure = lastFailure.get(sessionID);
  const recent = failure && Date.now() - failure.at <= FAILURE_CONTEXT_WINDOW_MS;
  // Log the explanation context even when no toast is shown, so switches can
  // be diagnosed from the persistent log (toasts are transient).
  log(`model switch: session=${sessionID} from=${oldFullModel} to=${newFullModel} oldManaged=${oldManaged} newManaged=${newManaged} recentFailure=${recent ? describeFailure(failure) : "none"}`);
  // Switches between two non-NeurOn models are not this plugin's concern.
  if (!oldManaged && !newManaged) return;

  const lastToastAt = lastSwitchToastAt.get(sessionID) ?? 0;
  if (Date.now() - lastToastAt <= MODEL_SWITCH_TOAST_COOLDOWN_MS) return;
  lastSwitchToastAt.set(sessionID, Date.now());

  let message;
  if (recent) {
    message = `NeurOn: model switched ${oldFullModel} → ${newFullModel} — last failure: ${describeFailure(failure)}`;
    if (oldManaged) {
      // Cached-only: the switch path must not await live I/O.
      const targetState = getTargetStateNow(state.statusCache, client, oldFullModel);
      if (targetState !== "unknown") message += ` (target was ${targetState})`;
    }
  } else {
    message = `NeurOn: model switched ${oldFullModel} → ${newFullModel} (no recorded failure)`;
  }
  if (ctx.client?.tui?.showToast) {
    ctx.client.tui.showToast({ body: { message, variant: "warning" } });
  }
}

// ── /neuron-extend command (native, no LLM round-trip) ────
// The custom command `/neuron-extend [minutes]` is handled natively by the
// `command.execute.before` hook: it extends this session's active reservation
// for its model and replaces the command's parts with a single status line.
// Semantics are ADDITIVE (fromNow: false) — the server computes
// expiry = max(now, currentExpiry) + N, so the command never shrinks the
// remaining time. Running the command counts as activity: the refreshed
// reservation is saved locally, which re-arms the keepalive timer; if the
// session then goes idle, the reservation still expires naturally.

// Replace the command's output parts in place (OpenCode reads output.parts
// after the hook returns) with a single text part. Part shape per the
// installed @opencode-ai/plugin contract: { type: "text", text } — OpenCode
// fills in the id/sessionID/messageID fields itself.
function setCommandParts(output, text) {
  if (!output || !Array.isArray(output.parts)) return;
  output.parts.length = 0;
  output.parts.push({ type: "text", text });
}

// OpenCode always runs an LLM turn after command.execute.before (the hook can
// mutate parts but never cancel the turn), so the replaced parts reach the
// session model as a user message. Frame every emitted part as an automated
// notification so the model acknowledges it instead of interpreting it as a
// request. The framing lives here, at every emit site.
function notificationPart(msg) {
  return `NeurOn notification (automated — no action needed, reply with a one-line acknowledgement only): ${msg}`;
}

async function handleNeuronExtend(client, allowedProviders, sessionModels, sessionID, rawArguments, output) {
  if (!client?.config?.apiKey) {
    setCommandParts(output, notificationPart("NeurOn: plugin not configured"));
    return;
  }

  // Minutes: the argument if given (must be an integer 1-720), else the
  // configured default. Bad input → usage line, no API call.
  const arg = (rawArguments ?? "").trim();
  const minutes = arg === "" ? client.config.durationMinutes : Number(arg);
  if (
    !Number.isFinite(minutes) ||
    minutes < 1 ||
    minutes > 720 ||
    (arg !== "" && !Number.isInteger(minutes))
  ) {
    setCommandParts(output, notificationPart("NeurOn: usage: /neuron-extend [minutes 1-720]"));
    return;
  }

  const cachedModel = sessionModels.get(sessionID);
  const model = cachedModel?.id;
  if (!model) {
    setCommandParts(output, notificationPart("NeurOn: no session model recorded yet"));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=no_model`);
    return;
  }
  const provider = cachedModel?.provider;
  const fullModel = provider ? `${provider}/${model}` : model;
  if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) {
    setCommandParts(output, notificationPart(`NeurOn: ${fullModel} is not managed`));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=not_managed`);
    return;
  }

  // Capture the session generation before any await so a session deleted
  // mid-flight can't receive state writes from this slow extend.
  const generation = currentSessionGeneration(state, sessionID);

  // Same model→target resolution the message path uses (the provider gate
  // above is the same NEURON_ALLOWED_PROVIDERS check the event hooks apply).
  let targetId;
  try {
    const resolved = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
    targetId = resolved.targetId;
  } catch (e) {
    // Mapping failures throw "NeurOn ..." errors; anything else (a fetch
    // failure or a status-0 timeout from the status read) is a transport
    // problem, not "unmanaged".
    const mappingFailure = e instanceof Error && /^NeurOn /.test(e.message ?? "");
    if (!mappingFailure) {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
      log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=unreachable`);
      return;
    }
    setCommandParts(output, notificationPart(`NeurOn: ${fullModel} is not managed`));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=not_managed`);
    return;
  }
  if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
    log(`command extend skipped (session stale): session=${sessionID}`);
    return;
  }

  // Bounded live status read (preflight budget), then the shared
  // active-reservation lookup (adoption also stores it locally).
  const status = await getLiveStatus(state.statusCache, client);
  if (!status) {
    setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=unreachable`);
    return;
  }
  const res = await adoptExistingReservation(client, state, targetId, status, sessionID, generation, coreDeps);
  if (!res?.reservationId) {
    setCommandParts(output, notificationPart("NeurOn: no active reservation — send a message to start one"));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=no_active_reservation`);
    return;
  }

  // Double-fire guard: OpenCode fires command.execute.before twice for a
  // single user invocation. The two calls may be concurrent (both pass a
  // time check before either sets the timestamp) OR sequential (first
  // completes, including its finally cleanup, before the second starts —
  // ~200ms apart). Two guards cover both cases:
  //  1. In-flight Set: catches concurrent calls (synchronous add, second
  //     sees it and bails before the first's finally cleanup runs).
  //  2. Time-based debounce (COMMAND_DEBOUNCE_MS): catches sequential
  //     calls that land within the window after the first completes.
  const now = Date.now();
  if (extendInFlight.has(sessionID)) {
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=in_flight`);
    return;
  }
  const lastExt = lastExtendAt.get(sessionID) ?? 0;
  if (now - lastExt < COMMAND_DEBOUNCE_MS) {
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=debounced (${now - lastExt}ms)`);
    return;
  }
  extendInFlight.add(sessionID);
  lastExtendAt.set(sessionID, now);

  try {
    const refreshed = await client.extendReservation(res.reservationId, minutes, { fromNow: false });
    // saveReservation re-checks the generation: a session deleted while the
    // extend was in flight gets no local state write and no timer re-arm.
    saveReservation(client, state, targetId, refreshed, sessionID, generation, coreDeps);
    setCommandParts(
      output,
      notificationPart(`NeurOn: reservation ${refreshed?.reservationId ?? res.reservationId} extended to ${formatClock(refreshed?.expiresAt)} (+${minutes} min)`)
    );
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=ok`);
  } catch (e) {
    if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
      setCommandParts(output, notificationPart(`NeurOn: extend rejected — ${e.body || e.message}`));
      log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=rejected_${e.status}`);
    } else {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
      log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=unreachable`);
    }
  } finally {
    extendInFlight.delete(sessionID);
  }
}

// ── /neuron-done command (native, no LLM round-trip) ─────
// The custom command `/neuron-done` is handled natively by the
// `command.execute.before` hook: it marks this session's active reservation
// done (the same endpoint the web UI "I'm Done" button calls) and clears all
// local reservation state + keepalive timers for the session. Unlike extend
// (which re-arms keepalive), done disarms it — the reservation is over.

async function handleNeuronDone(client, allowedProviders, sessionModels, sessionID, output) {
  if (!client?.config?.apiKey) {
    setCommandParts(output, notificationPart("NeurOn: plugin not configured"));
    return;
  }

  const cachedModel = sessionModels.get(sessionID);
  const model = cachedModel?.id;
  if (!model) {
    setCommandParts(output, notificationPart("NeurOn: no session model recorded yet"));
    log(`command done: session=${sessionID} result=no_model`);
    return;
  }
  const provider = cachedModel?.provider;
  const fullModel = provider ? `${provider}/${model}` : model;
  if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) {
    setCommandParts(output, notificationPart(`NeurOn: ${fullModel} is not managed`));
    log(`command done: session=${sessionID} result=not_managed`);
    return;
  }

  const generation = currentSessionGeneration(state, sessionID);

  let targetId;
  try {
    const resolved = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
    targetId = resolved.targetId;
  } catch (e) {
    const mappingFailure = e instanceof Error && /^NeurOn /.test(e.message ?? "");
    if (!mappingFailure) {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
      log(`command done: session=${sessionID} result=unreachable`);
      return;
    }
    setCommandParts(output, notificationPart(`NeurOn: ${fullModel} is not managed`));
    log(`command done: session=${sessionID} result=not_managed`);
    return;
  }
  if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
    log(`command done skipped (session stale): session=${sessionID}`);
    return;
  }

  const status = await getLiveStatus(state.statusCache, client);
  if (!status) {
    setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
    log(`command done: session=${sessionID} result=unreachable`);
    return;
  }
  const res = await adoptExistingReservation(client, state, targetId, status, sessionID, generation, coreDeps);
  if (!res?.reservationId) {
    setCommandParts(output, notificationPart("NeurOn: no active reservation to end"));
    log(`command done: session=${sessionID} result=no_active_reservation`);
    return;
  }

  // Double-fire guard: same two-layer guard as /neuron-extend.
  const nowDone = Date.now();
  if (doneInFlight.has(sessionID)) {
    log(`command done: session=${sessionID} result=in_flight`);
    return;
  }
  const lastDone = lastDoneAt.get(sessionID) ?? 0;
  if (nowDone - lastDone < COMMAND_DEBOUNCE_MS) {
    log(`command done: session=${sessionID} result=debounced (${nowDone - lastDone}ms)`);
    return;
  }
  doneInFlight.add(sessionID);
  lastDoneAt.set(sessionID, nowDone);

  try {
    await client.markReservationDone(res.reservationId);
    // Clear local state: stop keepalive, delete reservation entries, clear
    // inflight keys so a subsequent cold message can create a fresh reservation.
    const resKey = `${sessionID}::${targetId}`;
    stopKeepaliveTimer(resKey);
    state.reservations.delete(resKey);
    const inflightKey = `${sessionID}::${targetId}`;
    state.inflight.delete(inflightKey);
    state.inflightTarget.delete(inflightKey);
    setCommandParts(output, notificationPart(`NeurOn: reservation ${res.reservationId} ended`));
    log(`command done: session=${sessionID} reservationId=${res.reservationId} result=ok`);
  } catch (e) {
    if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
      setCommandParts(output, notificationPart(`NeurOn: end rejected — ${e.body || e.message}`));
      log(`command done: session=${sessionID} reservationId=${res.reservationId} result=rejected_${e.status}`);
    } else {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable — try again"));
      log(`command done: session=${sessionID} reservationId=${res.reservationId} result=unreachable`);
    }
  } finally {
    doneInFlight.delete(sessionID);
  }
}

// ── OpenCode plugin entry ─────────────────────────────────

export const NeurOnPlugin = async function NeurOnPlugin(ctx) {
  let client;
  let allowedProviders;
  try {
    client = new NeurOnClient(loadConfig());
    allowedProviders = client.config.allowedProviders;
    log(`plugin init: allowedProviders=${allowedProviders.join(",")} strictProviderMatch=${client.config.strictProviderMatch} blockOnColdMessage=${client.config.blockOnColdMessage} warmupLockTimeoutMs=${client.config.warmupLockTimeoutMs} baseUrl=${client.config.apiBaseUrl}`);
  } catch (e) {
    log(`plugin init failure: error=${e?.message ?? e}`);
    if (ctx.client?.tui?.showToast) {
      ctx.client.tui.showToast({
        body: { message: `NeurOn: plugin failed to init — ${e?.message ?? e}. Check env vars (NEURON_API_BASE_URL, NEURON_API_KEY).`, variant: "error" }
      });
    }
    return {
      event: () => {},
      "tool.execute.before": () => {},
      // Config failed to load — /neuron-extend and /neuron-done cannot work;
      // report it instead of letting the command template reach the LLM.
      "command.execute.before": async (input, output) => {
        if (input?.command === "neuron-extend" || input?.command === "neuron-done") {
          setCommandParts(output, notificationPart("NeurOn: plugin not configured"));
        }
      },
      dispose: async () => {}
    };
  }

  // Track session -> model mapping from session.created events
  const sessionModels = new Map();
  const instanceKey = Symbol.for("neuron.opencode.active-instance");
  const instanceId = Math.random().toString(36).slice(2, 10);
    const previousInstance = globalThis[instanceKey];
    if (previousInstance?.dispose) {
      try {
        await previousInstance.dispose();
      } catch {
        /* best-effort: a failed prior dispose must not break plugin init */
      }
    }

  const hooks = {
    event: async ({ event }) => {
      const type = event.type;
      const props = event?.properties || {};
      // Prefer camelCase `sessionID`; fall back to `sessionId` defensively.
      const sessionID = extractSessionID(event);
      if (!sessionID) return;

      if (type === "plugin.added") return;

      // Record request failures early, before any model/provider filtering:
      // a failure on any model can explain a later mid-session model switch
      // (fallback) in either direction.
      if (type === "session.error" && props?.error?.name) {
        recordSessionFailure(sessionID, {
          name: props.error.name,
          message: props.error.data?.message,
          status: props.error.data?.statusCode,
          source: "session.error"
        });
      }

      // Real agent work → record activity so the activity-gated keepalive
      // continues. NOTE: session.created and session.idle are deliberately NOT
      // activity — liveness alone must not renew reservations.
      if (
        type === "message.updated" ||
        type === "message.part.updated" ||
        type === "message.part.delta"
      ) {
        markActivity(state, sessionID);
        if (type === "message.part.delta") return;
      }
      if (type === "session.status" && props?.status?.type === "busy") {
        markActivity(state, sessionID);
        // Work starting — re-arm any keepalive timer that idleness stopped,
        // for this session's live reservations. No reservation extend.
        const busyPrefix = `${sessionID}::`;
        for (const [resKey, entry] of state.reservations) {
          if (!resKey.startsWith(busyPrefix)) continue;
          if (entry.expiresAt < Date.now()) continue;
          armKeepaliveTimer(
            resKey,
            resKey.slice(busyPrefix.length),
            sessionID,
            client,
            currentSessionGeneration(state, sessionID),
            false
          );
        }
        return;
      }
      // A retry signal means an LLM request just failed. Record it so a later
      // mid-session model switch can explain itself with this error. Retries
      // are not "real agent work" — do not mark activity.
      if (type === "session.status" && props?.status?.type === "retry") {
        recordSessionFailure(sessionID, {
          name: props.status.attempt ? `Retry ${props.status.attempt}` : "Retry",
          message: props.status.message,
          source: "session.status"
        });
        return;
      }

      // Release all per-session state only on true terminal events.
      // session.compacted keeps the session alive (model/reservation state remains valid).
      if (type === "session.deleted") {
        scrubSession(sessionID, sessionModels);
        return;
      }

      // CAPTURE model from session.created
      if (type === "session.created" && props.info?.model) {
        const m = props.info.model;
        const normalized = canonicalizeModel(m.providerID, m.id);
        // Clean up any stale state from a previous model on this sessionID
        // (handles session re-creation with a different model).
        const prevModel = sessionModels.get(sessionID);
        if (prevModel && (prevModel.id !== normalized.bareModelId || prevModel.provider !== normalized.provider)) {
          // Clean up the previous model's reservation state in the background.
          // Session creation must not wait on stale target resolution.
          const generation = currentSessionGeneration(state, sessionID);
          const oldFullModel = prevModel.provider ? `${prevModel.provider}/${prevModel.id}` : prevModel.id;
          (async () => {
            if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
              log(`session.created old-model cleanup skipped (session stale): session=${sessionID}`);
              return;
            }
            try {
              const oldTarget = await resolveTargetForModel(client, state, oldFullModel, sessionID, generation, coreDeps);
              if (!isSessionGenerationCurrent(state, sessionID, generation, log)) return;
              // Same-target race guard: if the session's current model now
              // maps to the same target the old model resolved to (e.g. a
              // different alias of the same model), the new model's warmup
              // may have already adopted/created a reservation under the
              // same resKey. Deleting it here would orphan the fresh
              // reservation. Only clean up if the session still points at
              // the old model.
              const currentModel = sessionModels.get(sessionID);
              const sameTarget =
                currentModel &&
                (currentModel.id === oldFullModel || currentModel.provider === prevModel.provider) &&
                oldTarget.resKey !== undefined;
              if (sameTarget && currentModel && (currentModel.id !== prevModel.id || currentModel.provider !== prevModel.provider)) {
                log(`session.created old-model cleanup skipped (same target as new model): session=${sessionID} target=${oldTarget.resKey}`);
                return;
              }
              stopKeepaliveTimer(oldTarget.resKey);
              state.reservations.delete(oldTarget.resKey);
            } catch (e) { /* ignore cleanup errors */ }
          })();
        }
        sessionModels.set(sessionID, {
          id: normalized.bareModelId,
          provider: normalized.provider
        });
        log(`session.created: session=${sessionID} model=${normalized.bareModelId} provider=${normalized.provider ?? "none"}`);

        // Model selection only records the model. Reservation creation is
        // intentionally deferred until a message observes a cold target.
        return;
      }

      // Prefer model from current event (handles model switching within same session)
      const eventModel = props?.info?.model;
      const cachedModel = sessionModels.get(sessionID);
      const rawModel = eventModel?.id ?? cachedModel?.id ?? event?.model;
      if (!rawModel) return;

      const normalizedCurrent = canonicalizeModel(
        eventModel?.providerID ?? cachedModel?.provider,
        rawModel
      );
      const model = normalizedCurrent.bareModelId;
      const provider = normalizedCurrent.provider;
      const fullModel = normalizedCurrent.fullModel;

      // Guard: prevent NeurOn from reserving its own traffic (recursive routing)
      if (provider) {
        const p = provider.toLowerCase();
        if (p === 'neuron' || p === 'neuron-bridge' || p === 'opencode-neuron') return;
      }

      if (eventModel?.id) {
        const normalizedEvent = canonicalizeModel(eventModel.providerID, eventModel.id);
        if (normalizedEvent.bareModelId !== cachedModel?.id || normalizedEvent.provider !== cachedModel?.provider) {
          // Mid-session model change: if it involves a NeurOn-managed model,
          // explain it (most recent recorded failure + last cached target
          // state). The switch path itself stays synchronous and cheap.
          if (cachedModel) {
            const oldFullModel = cachedModel.provider
              ? `${cachedModel.provider}/${cachedModel.id}`
              : cachedModel.id;
            notifyModelSwitch(
              client,
              allowedProviders,
              sessionID,
              ctx,
              oldFullModel,
              normalizedEvent.fullModel,
              cachedModel.provider,
              normalizedEvent.provider
            );
          }
          // Clean up the previous model's reservation state in the background.
          // Model switching must not wait on stale target resolution.
          const generation = currentSessionGeneration(state, sessionID);
          const oldFullModel = cachedModel?.provider
            ? `${cachedModel.provider}/${cachedModel.id}`
            : cachedModel?.id;
          if (oldFullModel) {
            (async () => {
              if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
                log(`model-switch old-model cleanup skipped (session stale): session=${sessionID}`);
                return;
              }
              try {
                const oldTarget = await resolveTargetForModel(client, state, oldFullModel, sessionID, generation, coreDeps);
                if (!isSessionGenerationCurrent(state, sessionID, generation, log)) return;
                stopKeepaliveTimer(oldTarget.resKey);
                state.reservations.delete(oldTarget.resKey);
              } catch (e) { /* ignore cleanup errors */ }
            })();
          }

          sessionModels.set(sessionID, {
            id: normalizedEvent.bareModelId,
            provider: normalizedEvent.provider
          });
        }
      }

      const role =
        event.role ?? event.properties?.info?.role ?? event.properties?.role;

      // Pre-request: check target health on user message
      if (type === "message.updated" && role === "user") {
        if (client.config.bypassMessageHook) return;
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;

        // Bounded preflight: a fresh status cache is used with zero I/O; a
        // stale/empty cache triggers one bounded live check so a cold target is
        // caught before the request races it. Unknown/unreachable states
        // fail open; only a cold/stopped/stopping state enters the
        // cold-start block.
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);

        if (targetState === "healthy") {
          // Target already running — keepalive only, in the background. Do NOT
          // block the message path for network I/O, and do NOT extend the
          // reservation per message: a live reservation just keeps the activity
          // grace window alive and re-arms the keepalive timer if idleness
          // stopped it. Missing local state does not create a reservation while
          // the target is healthy.
          const info = sessionModels.get(sessionID);
          if (info) info.stoppingNotified = false;
          // Capture the generation so the async block aborts if the session is
          // deleted (or re-created) while the resolve await is in flight.
          const generation = currentSessionGeneration(state, sessionID);
          (async () => {
            if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
              log(`message.updated background skipped (session stale): session=${sessionID}`);
              return;
            }
            try {
              const result = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
              if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
                log(`message.updated background skipped (session stale): session=${sessionID}`);
                return;
              }
              const entry = state.reservations.get(result.resKey);
              if (entry && entry.expiresAt >= Date.now()) {
                // Keepalive only — never extend per message. New activity keeps
                // the grace window alive and restarts the keepalive timer if it
                // was stopped by idleness (without resetting a live countdown).
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`message.updated keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) { /* ignore */ }
          })();
          return;
        }

        // NeurOn API unreachable — fail open, no toast, no warmup trigger
        if (targetState === "unreachable") return;

        // Only cold / stopped / stopping targets may block this message (R2).
        // Any other unexpected state fails open.
        if (!shouldBlockForWarmup(targetState)) return;

        // Cold start is the only intentional blocking path: reserve/adopt/create
        // as needed, show ONE warmup warning, wait for healthy, then continue.
        const info = sessionModels.get(sessionID);
        if (targetState === "stopping") {
          // Target is shutting down — clear stale reservation so the restart
          // re-adopts fresh state, and use a dedicated one-shot warning.
          try {
            const result = await resolveTargetForModel(client, state, fullModel, sessionID);
            stopKeepaliveTimer(result.resKey);
            state.reservations.delete(result.resKey);
          } catch (e) {
            /* ignore */
          }
          if (info && !info.stoppingNotified) {
            info.stoppingNotified = true;
            if (ctx.client?.tui?.showToast) {
              ctx.client.tui.showToast({
                body: { message: `NeurOn: target stopping, restarting… please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`, variant: "warning" }
              });
            }
          }
        } else if (info && !info.warmupNotified) {
          info.warmupNotified = true;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: { message: `NeurOn: warming up… please wait, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`, variant: "warning" }
            });
          }
        }

        // Fast-abort mode: signal the cold start in the background and throw
        // immediately so the caller can retry once warmup completes.
        if (client.config.blockOnColdMessage) {
          backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
          throw new Error(`NeurOn: target is ${targetState}, warming up — please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`);
        }

        // Default mode: acquire the shared warmup lock and block until the
        // target becomes healthy. This is the cooperative warmup behavior —
        // multiple sessions queue behind a single leader.
        // Resolve the targetId for the lock key — fetch status once and reuse.
        const status = await getCachedStatus(state.statusCache, client);
        const splitResult = splitProvider(fullModel);
        const match = matchLiteLlmModel(
          status.capacityTargets ?? [],
          status.models ?? [],
          splitResult.bareModelId,
          splitResult.provider,
          client.config.strictProviderMatch
        );
        const lockTargetId = match?.targetIds?.[0];

        if (lockTargetId) {
          try {
            await acquireWarmupAndEnsure(client, fullModel, sessionID, lockTargetId);
            log(`warmup lock released (healthy): targetId=${lockTargetId} session=${sessionID}`);
            return;
          } catch (e) {
            log(`warmup lock failed: targetId=${lockTargetId} session=${sessionID} error=${e?.message ?? e}`);
            // Lock already cleaned up by finally(). Caller can retry or fallback.
          }
        }

        // Fallback: if we couldn't resolve a targetId, fire background reserve
        // and let the orchestrator handle the failure normally.
        backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
        return;
      }

      if (type === "session.error") {
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;
        // Request failures do not reserve. A subsequent user message owns the
        // cold-target reservation flow.
      }

      // Idle = no agent work: stop this session's keepalive timers WITHOUT a
      // refresh call. The reservation is not extended — it expires naturally
      // and the target is released. New activity (user message, tool, busy
      // status) re-arms the timer if the reservation is still live.
      if (type === "session.idle") {
        const idlePrefix = `${sessionID}::`;
        for (const key of [...state.keepaliveTimers.keys()]) {
          if (key.startsWith(idlePrefix)) {
            log(`keepalive stopped (idle): session=${sessionID} key=${key}`);
            stopKeepaliveTimer(key);
          }
        }
        return;
      }
    },

    "tool.execute.before": async (input) => {
      try {
        const props = input;
        // sessionID arrives at the top level of the hook input in OpenCode's
        // documented signature; use it directly (no `event` wrapper here).
        const sessionID = input.sessionID;
        if (!sessionID) return;

        // Tool execution = real agent work.
        markActivity(state, sessionID);

        // A tool may execute before the session.created event is processed, so
        // hydrate from the event's own model info when the cache is empty.
        let cachedModel = sessionModels.get(sessionID);
        if (!cachedModel && props?.info?.model) {
          const normalized = canonicalizeModel(props.info.model.providerID, props.info.model.id);
          cachedModel = {
            id: normalized.bareModelId,
            provider: normalized.provider
          };
          sessionModels.set(sessionID, cachedModel);
        }
        const model = cachedModel?.id;
        if (!model) return;

        const provider = cachedModel?.provider;
        const fullModel = provider ? `${provider}/${model}` : model;
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;

        // Fail-open cooldown: skip health check if recent transport failure.
        const lastFailureTs = transportFailures.get(sessionID) ?? 0;
        if (Date.now() - lastFailureTs < client.config.cooldownPeriodMs) {
          log(`tool.execute.before fail-open: session=${sessionID} model=${fullModel} reason=transport_cooldown`);
          return;
        }

        // Bounded preflight: a fresh status cache is used with zero I/O; a
        // stale/empty cache triggers one bounded live check so a cold target is
        // caught before the tool runs. Unknown/unreachable states fail
        // open; only a cold/stopped/stopping state enters the cold-start
        // block.
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);
        if (targetState === "healthy") {
          // Target is healthy and a tool run is real agent work: keepalive
          // only. A live reservation just keeps the activity grace window
          // alive and re-arms the keepalive timer if idleness stopped it —
          // never extend per tool run. Background + fail-open, like the
          // message path — never block tool execution.
          const generation = currentSessionGeneration(state, sessionID);
          (async () => {
            if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
              log(`tool.execute.before background skipped (session stale): session=${sessionID}`);
              return;
            }
            try {
              const result = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
              if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
                log(`tool.execute.before background skipped (session stale): session=${sessionID}`);
                return;
              }
              const entry = state.reservations.get(result.resKey);
              if (entry && entry.expiresAt >= Date.now()) {
                // Keepalive only — never extend per tool run.
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`tool.execute.before keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) { /* fail open */ }
          })();
          return; // target is healthy — allow tool execution
        }
        if (targetState === "unreachable") {
          // API unreachable — set transport-failure timestamp so cooldown activates
          transportFailures.set(sessionID, Date.now());
          log(`tool.execute.before fail-open: session=${sessionID} model=${fullModel} reason=unreachable`);
          return;
        }
        // Only cold / stopped / stopping targets may block tool execution (R3).
        // "healthy" returned above and "unreachable" failed open above, so guard
        // defensively here: any other unexpected state fails open, never blocks.
        if (!shouldBlockForWarmup(targetState)) return;
        {
          // Tool execution never starts reservations. The request gate owns
          // cold-start reservation and must have run before tools are invoked.
          log(`tool.execute.before cold target: session=${sessionID} model=${fullModel} targetState=${targetState}`);
          return;
        }
      } catch (e) {
        if (e.message?.includes("NeurOn:")) throw e;
        // API unreachable — fail open to avoid blocking tool execution
        log(`tool.execute.before fail-open: error=${e?.message ?? e}`);
      }
    },

    // ── Request gate: block the LLM call until the target is warm ──
    // OpenCode AWAITS this hook before sending the chat completion, unlike the
    // `event` hook (which is fire-and-forget). This is what makes cold-start
    // gating actually hold the request instead of racing the warmup.
    // We never mutate output.parts, so KV cache / message content is untouched.
    "chat.message": async (input, output) => {
      try {
        const sessionID =
          input?.sessionID ?? input?.sessionId ?? input?.properties?.sessionID;
        if (!sessionID) return;
        if (client.config.bypassMessageHook) return;

        // Outgoing LLM request = real agent work.
        markActivity(state, sessionID);

        // Hydrate the session→model mapping if the event hook hasn't yet
        // (defensive: chat.message can occasionally lead session.created).
        let cached = sessionModels.get(sessionID);
        const inputModel = extractModelIdentity(input);
        if (!cached && inputModel) {
          const normalized = inputModel;
          cached = { id: normalized.bareModelId, provider: normalized.provider };
          sessionModels.set(sessionID, cached);
        }
        if (!cached) return; // can't resolve target without a known model
        const model = cached.id;
        const provider = cached.provider;
        const fullModel = provider ? `${provider}/${model}` : model;
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;

        // Resolve the neuron target from a single bounded status read: a
        // fresh cache is used with zero I/O; a stale/empty cache triggers
        // one bounded live check (failure/timeout → not a gateable model for
        // this request → fail open) so a cold target is still caught before
        // the request races it.
        let lockTargetId;
        const preflightStatus = await getLiveStatus(state.statusCache, client);
        if (preflightStatus) {
          const splitResult = splitProvider(fullModel);
          const match = matchLiteLlmModel(
            preflightStatus.capacityTargets ?? [],
            preflightStatus.models ?? [],
            splitResult.bareModelId,
            splitResult.provider,
            client.config.strictProviderMatch
          );
          lockTargetId = match?.targetIds?.[0];
        }
        if (!lockTargetId) return; // not a neuron-managed model — don't gate

        // Bounded preflight: if we got here the bounded read above succeeded
        // and the cache is fresh (zero I/O). Unknown/unreachable states fail
        // open; only a cold/stopped/stopping state enters the cold-start
        // block.
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);

        if (targetState === "healthy") {
          // Already warm — keepalive only in the background, never block the
          // request, and never extend per request. A live reservation just
          // keeps the activity grace window alive and re-arms the keepalive
          // timer if idleness stopped it. Capture the generation so the async
          // block aborts if the session is deleted (or re-created) while the
          // resolve await is in flight.
          const generation = currentSessionGeneration(state, sessionID);
          (async () => {
            if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
              log(`chat.message background skipped (session stale): session=${sessionID}`);
              return;
            }
            try {
              const result = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
              if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
                log(`chat.message background skipped (session stale): session=${sessionID}`);
                return;
              }
              const entry = state.reservations.get(result.resKey);
              if (entry && entry.expiresAt >= Date.now()) {
                // Keepalive only — never extend per request.
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`chat.message keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) { /* ignore */ }
          })();
          return;
        }

        if (targetState === "unreachable") return;

        // Only cold / stopped / stopping targets may block this request.
        // Any other unexpected state fails open (R1).
        if (!shouldBlockForWarmup(targetState)) return;

        // Cold start is the only intentional blocking path: toast once, then
        // BLOCK until healthy (up to 10m). A follower waiting on the leader's
        // warmup lock can be held for the leader's full wait with no feedback,
        // so a heartbeat toast fires every 30 s while the block is active.
        const info = sessionModels.get(sessionID);
        if (info && !info.warmupNotified) {
          info.warmupNotified = true;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: {
                message: `NeurOn: warming up… please wait, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`,
                variant: "warning"
              }
            });
          }
        }

        // Heartbeat: a progress toast every 30 s while the warmup block is
        // active, so a follower held behind the leader's lock gets feedback
        // instead of a silent 10-minute wait.
        let heartbeatDone = false;
        const heartbeat = setInterval(() => {
          if (heartbeatDone) return;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: {
                message: `NeurOn: still warming up…`,
                variant: "warning"
              }
            });
          }
        }, 30000);

        try {
          await acquireWarmupAndEnsure(client, fullModel, sessionID, lockTargetId);
          log(`chat.message warmup complete: targetId=${lockTargetId} session=${sessionID}`);
        } catch (e) {
          log(`chat.message warmup failed: targetId=${lockTargetId} session=${sessionID} error=${e?.message ?? e}`);
          // Warmup timed out / target failed — let the request proceed so OpenCode
          // surfaces the real error instead of hanging for the full timeout.
        } finally {
          clearInterval(heartbeat);
          heartbeatDone = true;
        }
      } catch (e) {
        // Never throw from this hook — throwing would abort the user's request.
        log(`chat.message gate error: ${e?.message ?? e}`);
      }
    },

    // ── /neuron-extend + /neuron-done: native command handling (no LLM round-trip) ──
    // OpenCode invokes this hook before executing a custom command; replacing
    // output.parts with a single text part is what the user sees. The hook
    // NEVER throws (an unexpected error would abort the command for the user):
    // for any other command it returns immediately without touching parts.
    "command.execute.before": async (input, output) => {
      try {
        if (input?.command === "neuron-extend") {
          await handleNeuronExtend(
            client,
            allowedProviders,
            sessionModels,
            input.sessionID,
            input.arguments,
            output
          );
          return;
        }
        if (input?.command === "neuron-done") {
          await handleNeuronDone(
            client,
            allowedProviders,
            sessionModels,
            input.sessionID,
            output
          );
          return;
        }
      } catch (e) {
        log(`command ${input?.command ?? "unknown"} failure: error=${e?.message ?? e}`);
        if (input?.command === "neuron-extend") {
          setCommandParts(output, notificationPart(`NeurOn: extend failed — ${e?.message ?? e}`));
        } else if (input?.command === "neuron-done") {
          setCommandParts(output, notificationPart(`NeurOn: done failed — ${e?.message ?? e}`));
        }
      }
    },

    // Release all per-session state on plugin shutdown so nothing lingers
    // between sessions in a long-running process.
    dispose: async () => {
      for (const timer of state.keepaliveTimers.values()) clearInterval(timer);
      state.reservations.clear();
      state.inflight.clear();
      state.inflightTarget.clear();
      state.retryState.clear();
      state.keepaliveTimers.clear();
      warmupLocks.clear();
      sessionModels.clear();
      state.sessionActivity.clear();
      state.sessionGenerations.clear();
      state.statusCache.value = null;
      state.statusCache.at = 0;
      state.statusCache.inflight = null;
      transportFailures.clear();
      lastFailure.clear();
      lastSwitchToastAt.clear();
      lastExtendAt.clear();
      lastDoneAt.clear();
      extendInFlight.clear();
      doneInFlight.clear();
      if (globalThis[instanceKey]?.id === instanceId) delete globalThis[instanceKey];
    }
  };
  globalThis[instanceKey] = { id: instanceId, dispose: hooks.dispose };
  return hooks;
};

/* Test-only helper to reset module-level state between test runs.
   IMPORTANT: must NOT be exported. OpenCode's plugin loader treats every
   exported function in an auto-loaded plugin file as a plugin and calls it;
   a non-plugin function returning undefined corrupts the hooks array and
   prevents OpenCode from starting. Tests should import this via a separate,
   non-auto-loaded module or reach it through a test harness.
  */
const __testResetGlobals = () => {
  state.reservations.clear();
  state.inflight.clear();
  state.inflightTarget.clear();
  state.retryState.clear();
  for (const timer of state.keepaliveTimers.values()) clearInterval(timer);
  state.keepaliveTimers.clear();
  state.sessionActivity.clear();
  state.sessionGenerations.clear();
  warmupLocks.clear();
  state.statusCache.value = null;
  state.statusCache.at = 0;
  state.statusCache.inflight = null;
  transportFailures.clear();
  lastFailure.clear();
  lastSwitchToastAt.clear();
};
