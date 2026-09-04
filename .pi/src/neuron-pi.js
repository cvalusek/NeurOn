// pi adapter for the shared NeurOn core (../../shared/neuron-core).
//
// Plain ESM module; the default export is the pi extension factory
// `function (pi) { … }` that pi 0.74.2 invokes at load time. The installed
// artifact is this file bundled by esbuild (see ../README.md): the pi
// extension dir (~/.pi/agent/extensions/neuron/) holds a thin index.ts that
// jiti transpiles on the fly and re-exports the sibling bundle (neuron-pi.js).
//
// Harness concerns (pi events, the 5 s keepalive interval, ui.notify, the
// native /neuron-extend command, the log file, in-memory per-session state)
// live here; the reservation client + policy live in the core. The core is
// timer- and storage-free: this adapter owns the setInterval and all process
// state.
//
// Fail-closed at the gate: unlike the OpenCode adapter (fail-open — the
// request may still race the warmup and surface its own error), pi's `input`
// hook is the only pre-LLM cancellation point. A turn that cannot be
// reserved is dropped ({action:"handled"}, zero LLM traffic) rather than
// silently bypassing a known-bad state.

import fs from "node:fs/promises";
import {
  NeurOnApiError,
  NeurOnClient,
  loadConfig,
  positiveNumber,
  matchesAllowedProvider,
  canonicalizeModel,
  splitProvider,
  matchLiteLlmModel,
  getLiveStatus,
  ensureReservation,
  adoptExistingReservation,
  saveReservation,
  isSessionGenerationCurrent,
  invalidateSessionGeneration,
  markActivity,
  isSessionActive,
  effectiveKeepaliveMinutes,
  isExtendDue,
  formatClock
} from "../../shared/neuron-core/index.js";

// The pi gate's bounded wait: one "still waiting" nudge at 15 s; the hard
// cap is the core's waitForHealthy deadline (NEURON_WAIT_TIMEOUT_SECONDS,
// default 40 s — dropping the turn after the core's 10-minute default
// would be worse than surfacing the failure).
const SOFT_WAIT_NOTIFY_MS = 15000;
const DEFAULT_HARD_WAIT_S = 40;
// Keepalive tick period. The core policy (isExtendDue + activity gates)
// decides when an extend actually happens.
const KEEPALIVE_TICK_MS = 5000;

// ── In-memory per-session state (pi: one process = one session) ─────────
// Core-owned maps (injected into the core) plus adapter-owned session
// entries. Everything is in memory: pi keeps the extension process alive
// for the whole TUI session, and session_shutdown scrubs per-session state.
const state = {
  reservations: new Map(), // resKey (sessionID::targetId) → { reservation, expiresAt }
  inflight: new Map(),
  inflightTarget: new Map(),
  retryState: new Map(),
  sessionActivity: new Map(), // sessionID → last real activity (ms) — core grace window
  sessionGenerations: new Map(),
  statusCache: { value: null, at: 0, inflight: null }
};
const sessions = new Map(); // sessionID → session entry

// Set by the extension factory (one per process in practice).
let client = null;
let allowedProviders = [];

// Diagnostics go to a log file, never the terminal: pi renders extension
// stderr between turns, and the per-message gate lines are noise there.
// Mirrors the OpenCode plugin's log-file + rotation (same env vars and
// semantics): default $HOME/neuron-pi.log (Unix) or
// %USERPROFILE%\neuron-pi.log (Windows); NEURON_LOG_FILE overrides the path,
// NEURON_LOG_MAX_BYTES the rotation size (5 MB default; old file → .1).
const NEURON_LOG_FILE =
  process.env.NEURON_LOG_FILE ||
  (process.env.USERPROFILE
    ? `${process.env.USERPROFILE}\\neuron-pi.log`
    : `${process.env.HOME || "."}/neuron-pi.log`);
const NEURON_LOG_MAX_BYTES = (() => {
  const v = Number(process.env.NEURON_LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024; // 5 MB default
})();
let _logSize = 0;

function log(msg) {
  const line = `${new Date().toISOString()} neuron-pi: ${msg}\n`;
  _logSize += Buffer.byteLength(line, "utf8");
  if (_logSize > NEURON_LOG_MAX_BYTES) {
    // Rotate: rename current log to .1 (overwriting any prior rotation)
    fs.rename(NEURON_LOG_FILE, `${NEURON_LOG_FILE}.1`).catch(() => {});
    _logSize = 0;
  }
  fs.appendFile(NEURON_LOG_FILE, line).catch(() => {});
}

function getSessionId(ctx, event) {
  try {
    return (
      ctx?.sessionManager?.getSessionId?.() ??
      event?.sessionId ??
      event?.session?.id ??
      "default"
    );
  } catch (e) {
    return "default";
  }
}

function getOrCreateSession(sessionId, ctx) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      ctx: null,
      model: null, // normalized { provider, bareModelId, fullModel }
      resKey: null, // sessionID::targetId of the live reservation
      targetId: null,
      lastActivityAt: 0,
      lastExtendAt: 0,
      settledAt: null, // set by agent_end / agent_settled (0.84.4+)
      timer: null, // 5 s keepalive interval handle
      notConfiguredNotified: false
    };
    sessions.set(sessionId, s);
  }
  if (ctx) s.ctx = ctx;
  return s;
}

// ui.notify guard: ctx.hasUI is false in headless contexts; a broken UI
// must never break the gate. In headless contexts (no UI to render into)
// the notice lands in the log file instead of the terminal.
function notify(ctx, message, variant = "info") {
  try {
    if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
      ctx.ui.notify(message, variant);
    } else {
      log(message);
    }
  } catch (e) {
    // ui.notify threw (e.g. UI teardown mid-shutdown): fall back to the log
    // file so the notice is never lost.
    log(message);
  }
}

function describeError(e) {
  const raw = e instanceof Error ? (e.message ?? String(e)) : String(e);
  if (/^NeurOn\b/.test(raw)) return raw;
  // Distinguish plugin-internal JS exceptions (bugs) from control-plane
  // errors so the user can tell which side failed.
  if (e instanceof TypeError || e instanceof RangeError) {
    return `NeurOn plugin error: ${raw}`;
  }
  return `NeurOn: ${raw}`;
}

// Registry mapping failures mean "this model is not NeurOn-managed" — the
// turn passes through (the model is served by its own provider). Transport
// failures, API errors, wait timeouts, and target failures are NOT this and
// drop the turn instead.
function isNotManagedError(e) {
  if (!(e instanceof Error)) return false;
  return /NeurOn (could not map|provider_mapping_error|ambiguous_model_mapping)/.test(
    e.message ?? ""
  );
}

// Adapter-owned callbacks handed to the core: the log writer and the
// keepalive pointer update (setInterval lives here — the core is timer-free).
// Unlike the OpenCode adapter (which arms a per-reservation countdown
// timer), the pi keepalive is one fixed 5 s interval per session: the tick
// consults the core policy (isExtendDue + activity gates) to decide.
const coreDeps = {
  log,
  armKeepalive: (resKey, targetId, sessionID, clientArg, generation, restart) => {
    // Stale-work guard: a session scrubbed while the async reservation work
    // ran must not get its keepalive pointer re-aimed.
    if (generation !== undefined && !isSessionGenerationCurrent(state, sessionID, generation, log)) {
      log(`armKeepalive skipped (session stale): targetId=${targetId} session=${sessionID}`);
      return;
    }
    const s = getOrCreateSession(sessionID, null);
    s.resKey = resKey;
    s.targetId = targetId;
    s.lastExtendAt = Date.now();
  }
};

// Release every piece of per-session state. Bumps the generation FIRST so
// in-flight async work (create/adopt/extend/keepalive) aborts before writing
// state for a deleted session.
function scrubSession(sessionId) {
  invalidateSessionGeneration(state, sessionId);
  const s = sessions.get(sessionId);
  if (s?.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  const prefix = `${sessionId}::`;
  for (const key of [...state.reservations.keys()])
    if (key.startsWith(prefix)) state.reservations.delete(key);
  for (const key of [...state.inflight.keys()])
    if (key.startsWith(prefix)) state.inflight.delete(key);
  for (const key of [...state.inflightTarget.keys()])
    if (key.startsWith(prefix)) state.inflightTarget.delete(key);
  for (const key of [...state.retryState.keys()])
    if (key.startsWith(prefix)) state.retryState.delete(key);
  state.sessionActivity.delete(sessionId);
  sessions.delete(sessionId);
}

// ── Keepalive (5 s tick, core policy decides) ───────────────────────────

function startKeepaliveTimer(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.timer) clearInterval(s.timer);
  s.timer = setInterval(() => {
    try {
      tickKeepalive(sessionId);
    } catch (e) {
      log(`keepalive tick error: session=${sessionId} error=${e?.message ?? e}`);
    }
  }, KEEPALIVE_TICK_MS);
  s.timer.unref?.();
}

function tickKeepalive(sessionId) {
  // The timer must not be armed in degraded mode (no client), but keep the
  // invariant explicit: a null client (config-load-failed) can never extend.
  if (!client || !client.config?.apiKey) return;
  const s = sessions.get(sessionId);
  if (!s || !s.resKey) return;
  const entry = state.reservations.get(s.resKey);
  if (!entry) return;
  const now = Date.now();
  if (entry.expiresAt < now) return; // locally expired — let it die naturally

  // Use the remaining lifetime (expiresAt - now) for the extend-due check so
  // an adopted reservation (with less remaining time than a fresh one)
  // triggers its first refresh proportionally earlier, not after half the
  // full duration has elapsed.
  const lifetimeMs = Math.max(entry.expiresAt - now, 30000);
  const activitySinceExtend = s.lastActivityAt > s.lastExtendAt;
  // Settle signal: the agent_settled event (pi ≥ 0.84.4) when present, else
  // agent_end + ctx.isIdle() polling. Settled with nothing new to justify an
  // extend → stop; the reservation expires naturally (no release calls).
  const settled =
    s.settledAt !== null ||
    (typeof s.ctx?.isIdle === "function" && s.ctx.isIdle() === true);
  if (settled && !activitySinceExtend) return;
  // Core policy: due once at least max(0.5·lifetime, 30 s) has elapsed since
  // the last extend, with real activity since that extend and still inside
  // the keepalive grace window.
  if (!isExtendDue(now, s.lastExtendAt, lifetimeMs)) return;
  if (!activitySinceExtend) return;
  if (!isSessionActive(state, sessionId, client)) return;

  const reservationId = entry.reservation.reservationId;
  const targetId = s.targetId;
  const resKey = s.resKey;
  log(`keepalive extend: session=${sessionId} reservationId=${reservationId} fromNow=false`);
  // ADDITIVE (fromNow:false): server computes expiry = max(now, currentExpiry)
  // + N — keepalive never shortens the remaining time.
  client
    .extendReservation(reservationId, client.config.durationMinutes, { fromNow: false })
    .then((refreshed) => {
      const sNow = sessions.get(sessionId);
      if (!sNow || sNow.resKey !== resKey) return; // session moved on
      saveReservation(client, state, targetId, refreshed, sessionId, undefined, coreDeps);
      sNow.lastExtendAt = Date.now();
    })
    .catch((e) => {
      log(`keepalive extend fail: session=${sessionId} error=${e?.message ?? e}`);
    });
}

// ── Activity stamping ───────────────────────────────────────────────────

function stampActivity(event, ctx) {
  try {
    const sessionId = getSessionId(ctx, event);
    const s = getOrCreateSession(sessionId, ctx);
    s.lastActivityAt = Date.now();
    s.settledAt = null;
    markActivity(state, sessionId);
  } catch (e) {
    log(`activity stamp error: ${e?.message ?? e}`);
  }
}

function markSettled(event, ctx) {
  try {
    const s = sessions.get(getSessionId(ctx, event));
    if (s) s.settledAt = Date.now();
  } catch (e) {
    /* never throw */
  }
}

// ── pi extension entry ──────────────────────────────────────────────────

export default function neuronPiExtension(pi) {
  try {
    const config = loadConfig();
    // pi's gate drops the turn on failure, so the bounded wait stays short:
    // NEURON_WAIT_TIMEOUT_SECONDS (seconds, the same established variable
    // as the core) overrides, default 40 s.
    config.waitTimeoutMs =
      positiveNumber(process.env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_HARD_WAIT_S) * 1000;
    client = new NeurOnClient(config);
  } catch (e) {
    // Distinguish *missing* config (no URL at all — legitimately inactive,
    // pass through silently with a one-time log notice) from *malformed*
    // config (URL present but not http(s) — a typo that silently disables the
    // gate). A misconfigured URL must be LOUD: ERROR log + one-time UI
    // notify on the first turn, so a typo can't degrade the plugin to a
    // silent no-op.
    const cfgError = e?.message ?? String(e);
    const missingUrl = !process.env.NEURON_API_BASE_URL;
    if (missingUrl) {
      log(
        `no NEURON_API_BASE_URL — plugin inactive, inputs pass through, /neuron-extend reports it`
      );
    } else {
      log(`CONFIG ERROR: ${cfgError} — gate is DISABLED. Fix NEURON_API_BASE_URL.`);
    }
    // Degraded mode: never throw, never call the API.
    let misconfigNotified = false;
    pi.on("input", async (event, ctx) => {
      if (!missingUrl && !misconfigNotified) {
        misconfigNotified = true;
        notify(ctx, `NeurOn: misconfigured (${cfgError}) — gate disabled. Fix NEURON_API_BASE_URL.`, "error");
      }
      return { action: "continue" };
    });
    pi.registerCommand("neuron-extend", {
      description: "Extend the active NeurOn reservation [minutes 1-720]",
      handler: (args, ctx) => {
        notify(ctx, missingUrl ? "NeurOn: plugin not configured" : `NeurOn: misconfigured — gate disabled (${cfgError})`, "error");
      }
    });
    return;
  }
  allowedProviders = client.config.allowedProviders;
  log(
    `loaded (baseUrl=${client.config.apiBaseUrl}, ` +
      `allowedProviders=[${allowedProviders.join(",")}] or all, ` +
      `hardWait=${client.config.waitTimeoutMs}ms)`
  );

  // ── input gate: the only pre-LLM cancellation point ───────────────────
  pi.on("input", async (event, ctx) => {
    try {
      // Internal pi plumbing (extension-generated input) never crosses the gate.
      if (event?.source === "extension") return { action: "continue" };

      const sessionId = getSessionId(ctx, event);
      const s = getOrCreateSession(sessionId, ctx);
      const now = Date.now();
      s.lastActivityAt = now;
      s.settledAt = null;
      markActivity(state, sessionId);

      const model = ctx?.model;
      if (!model?.id) return { action: "continue" }; // no model info — nothing to gate
      const normalized = canonicalizeModel(model.provider, model.id);
      s.model = normalized;
      const fullModel = normalized.fullModel;

      // Provider filter first: a disallowed provider is never queried (zero I/O).
      if (!matchesAllowedProvider(normalized.provider, fullModel, allowedProviders, log)) {
        return { action: "continue" };
      }
      // Unconfigured (no API key): the plugin is inactive — pass through with
      // a one-time notice instead of dropping every turn over a config the
      // user may not know about. (No API call is made either way.)
      if (!client.config.apiKey) {
        if (!s.notConfiguredNotified) {
          s.notConfiguredNotified = true;
          notify(ctx, "NeurOn: not configured (NEURON_API_KEY missing) — inputs pass through", "warning");
        }
        return { action: "continue" };
      }

      // Healthy targets pass through without creating a reservation. Resolve
      // first so an existing remote reservation can be adopted for keepalive;
      // only cold/in-flight targets enter ensureReservation.
      const status = await getLiveStatus(state.statusCache, client);
      const split = splitProvider(fullModel);
      const match = status && matchLiteLlmModel(
        status.capacityTargets ?? [],
        status.models ?? [],
        split.bareModelId,
        split.provider,
        client.config.strictProviderMatch
      );
      if (match && !match.error) {
        const target = (status.capacityTargets ?? []).find((t) =>
          (match.targetIds ?? []).includes(t.id)
        );
        if (target?.observed === "healthy") {
          try {
            await resolveTargetForModel(client, state, fullModel, sessionId, undefined, coreDeps);
          } catch (e) { /* healthy pass-through must remain fail-open */ }
          log(`input gate: healthy pass-through session=${sessionId} model=${fullModel}`);
          return { action: "continue" };
        }
      }

      // Cold/in-flight target → ensure an active reservation BEFORE the turn
      // may proceed (adopt-or-create + bounded healthy wait). One "still
      // waiting" nudge at 15 s; the hard cap is the core's waitForHealthy deadline.
      const softTimer = setTimeout(() => {
        notify(
          ctx,
          `NeurOn: still waiting for target capacity (up to ${Math.round(client.config.waitTimeoutMs / 1000)}s)`,
          "warning"
        );
      }, SOFT_WAIT_NOTIFY_MS);
      try {
        await ensureReservation(client, state, fullModel, sessionId, coreDeps);
        log(`input gate: ensured session=${sessionId} model=${fullModel}`);
        return { action: "continue" };
      } catch (e) {
        if (isNotManagedError(e)) {
          // The control plane is reachable and says this model is not its —
          // serve it via its own provider, no reservation.
          log(`input gate: not managed session=${sessionId} model=${fullModel} (${e.message})`);
          return { action: "continue" };
        }
        // Timeout / unreachable / API error / target failure → fail closed:
        // drop the turn (zero LLM traffic) and say why.
        const msg = describeError(e);
        log(`input gate: dropping turn session=${sessionId} model=${fullModel} error=${msg}`);
        notify(ctx, msg, "error");
        return { action: "handled" };
      } finally {
        clearTimeout(softTimer);
      }
    } catch (e) {
      // DELIBERATE: an uncaught throw in this handler is swallowed by pi and
      // the input would PASS THROUGH the gate — silently bypassing it.
      const msg = describeError(e);
      log(`input gate: unexpected error session=${getSessionId(ctx, event)} error=${msg}`);
      notify(ctx, msg, "error");
      return { action: "handled" };
    }
  });

  // ── lifecycle ─────────────────────────────────────────────────────────
  // session_start reasons: startup/reload/new/resume/fork — every one (re)arms
  // the keepalive interval for the session.
  pi.on("session_start", (event, ctx) => {
    try {
      const sessionId = getSessionId(ctx, event);
      const s = getOrCreateSession(sessionId, ctx);
      s.settledAt = null;
      startKeepaliveTimer(sessionId);
      log(`session_start: reason=${event?.reason ?? "?"} session=${sessionId}`);
    } catch (e) {
      log(`session_start error: ${e?.message ?? e}`);
    }
  });

  // session_shutdown reasons: startup/reload/new/resume/fork/quit — every one
  // clears the timer and scrubs the session (no release calls; the reservation
  // expires naturally server-side).
  pi.on("session_shutdown", (event, ctx) => {
    try {
      const sessionId = getSessionId(ctx, event);
      scrubSession(sessionId);
      log(`session_shutdown: reason=${event?.reason ?? "?"} session=${sessionId}`);
    } catch (e) {
      log(`session_shutdown error: ${e?.message ?? e}`);
    }
  });

  // ── model switches ────────────────────────────────────────────────────
  // Re-resolve the target for the new model ONLY (bounded status read). No
  // eager reservation: the next input gate adopts or creates.
  pi.on("model_select", (event, ctx) => {
    try {
      const sessionId = getSessionId(ctx, event);
      const m = event?.model;
      if (!m?.id) return;
      const normalized = canonicalizeModel(m.provider, m.id);
      const s = getOrCreateSession(sessionId, ctx);
      s.model = normalized;
      const fullModel = normalized.fullModel;
      if (!matchesAllowedProvider(normalized.provider, fullModel, allowedProviders, log)) {
        s.resKey = null;
        s.targetId = null;
        log(`model_select: not managed model=${fullModel}`);
        return;
      }
      (async () => {
        try {
          const status = await getLiveStatus(state.statusCache, client);
          const sNow = sessions.get(sessionId);
          if (!sNow || sNow.model !== normalized) return; // switched again meanwhile
          if (!status) {
            log(`model_select: status unavailable — will resolve on next input model=${fullModel}`);
            return;
          }
          const split = splitProvider(fullModel);
          const match = matchLiteLlmModel(
            status.capacityTargets ?? [],
            status.models ?? [],
            split.bareModelId,
            split.provider,
            client.config.strictProviderMatch
          );
          const sAfter = sessions.get(sessionId);
          if (!sAfter || sAfter.model !== normalized) return;
          if (!match || match.error) {
            const oldResKey = sAfter.resKey;
            sAfter.targetId = null;
            sAfter.resKey = null;
            // Drop the stale local entry: the old target is no longer the
            // live pointer for this session (server-side reservation expires
            // naturally).
            if (oldResKey) state.reservations.delete(oldResKey);
            log(`model_select: not managed model=${fullModel} reason=${match?.error ?? "no_match"}`);
            return;
          }
          const oldResKey = sAfter.resKey;
          sAfter.targetId = match.targetIds[0];
          sAfter.resKey = `${sessionId}::${sAfter.targetId}`;
          // Keep the local map tracking only the live pointer: a
          // managed→managed switch abandons the old target's local entry
          // (its server-side reservation expires naturally; the old key
          // would otherwise accumulate in state.reservations until
          // session_shutdown).
          if (oldResKey && oldResKey !== sAfter.resKey) {
            state.reservations.delete(oldResKey);
          }
          log(`model_select: target re-resolved model=${fullModel} targetId=${sAfter.targetId}`);
        } catch (e) {
          log(`model_select error: model=${fullModel} error=${e?.message ?? e}`);
        }
      })();
    } catch (e) {
      log(`model_select error: ${e?.message ?? e}`);
    }
  });

  // ── activity + settle signals ─────────────────────────────────────────
  pi.on("turn_start", stampActivity);
  pi.on("agent_start", stampActivity);
  pi.on("agent_end", markSettled);
  // Feature-detect agent_settled (present in pi ≥ 0.84.4, absent in
  // 0.73.1/0.74.2): registering is passive (the event simply never fires on
  // older pi) and a throw during registration is contained.
  try {
    pi.on("agent_settled", markSettled);
  } catch (e) {
    /* older pi — settle via agent_end + ctx.isIdle() polling */
  }

  // ── /neuron-extend: native command, no LLM round-trip ─────────────────
  pi.registerCommand("neuron-extend", {
    description:
      "Extend the active NeurOn reservation by N minutes (1-720; default NEURON_RESERVATION_DURATION_MINUTES). Additive — never shortens.",
    handler: async (args, ctx) => {
      try {
        if (!client?.config?.apiKey) {
          notify(ctx, "NeurOn: plugin not configured", "error");
          return;
        }
        const sessionId = getSessionId(ctx, undefined);
        const s = getOrCreateSession(sessionId, ctx);

        // Minutes: the argument if given (integer 1-720), else the configured
        // default. Bad input → usage line, no API call.
        const arg = (args ?? "").trim();
        const minutes = arg === "" ? client.config.durationMinutes : Number(arg);
        if (
          !Number.isFinite(minutes) ||
          minutes < 1 ||
          minutes > 720 ||
          (arg !== "" && !Number.isInteger(minutes))
        ) {
          notify(ctx, "NeurOn: usage: /neuron-extend [minutes 1-720]", "warning");
          return;
        }

        // Same gate as the input path: session model → provider filter.
        const model =
          s.model ??
          (ctx?.model?.id ? canonicalizeModel(ctx.model.provider, ctx.model.id) : null);
        if (!model) {
          notify(ctx, "NeurOn: no session model recorded yet", "warning");
          return;
        }
        const fullModel = model.fullModel;
        if (!matchesAllowedProvider(model.provider, fullModel, allowedProviders, log)) {
          notify(ctx, `NeurOn: ${fullModel} is not managed`, "warning");
          return;
        }

        // Bounded status read (preflight budget) + registry resolution.
        const status = await getLiveStatus(state.statusCache, client);
        if (!status) {
          notify(ctx, "NeurOn: control plane unreachable — try again", "error");
          return;
        }
        const sAfter = sessions.get(sessionId);
        if (!sAfter) return; // session shut down mid-flight
        const split = splitProvider(fullModel);
        const match = matchLiteLlmModel(
          status.capacityTargets ?? [],
          status.models ?? [],
          split.bareModelId,
          split.provider,
          client.config.strictProviderMatch
        );
        if (!match || match.error) {
          notify(ctx, `NeurOn: ${fullModel} is not managed`, "warning");
          return;
        }
        const targetId = match.targetIds[0];
        const resKey = `${sessionId}::${targetId}`;

        // Adopt the active reservation: the session's own local entry first,
        // then a server-side one (adoption stores it locally and re-aims the
        // keepalive tick via saveReservation → armKeepalive).
        let reservationId = state.reservations.get(resKey)?.reservation?.reservationId;
        if (!reservationId) {
          const adopted = await adoptExistingReservation(
            client, state, targetId, status, sessionId, undefined, coreDeps
          );
          reservationId = adopted?.reservationId;
        }
        if (!reservationId) {
          notify(ctx, "NeurOn: no active reservation — send a message to start one", "warning");
          return;
        }

        try {
          // ADDITIVE (fromNow:false): the server computes expiry =
          // max(now, currentExpiry) + N — the command never shortens the
          // remaining time.
          const refreshed = await client.extendReservation(reservationId, minutes, { fromNow: false });
          const sNow = sessions.get(sessionId);
          if (sNow) {
            saveReservation(client, state, targetId, refreshed, sessionId, undefined, coreDeps);
            // Running the command counts as activity (same as OpenCode).
            sNow.lastActivityAt = Date.now();
            markActivity(state, sessionId);
          }
          notify(
            ctx,
            `NeurOn: reservation ${refreshed?.reservationId ?? reservationId} extended to ${formatClock(refreshed?.expiresAt)} (+${minutes} min)`
          );
          log(`command extend: session=${sessionId} minutes=${minutes} fromNow=false result=ok`);
        } catch (e) {
          if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
            notify(ctx, `NeurOn: extend rejected — ${e.body || e.message}`, "error");
            log(`command extend: session=${sessionId} minutes=${minutes} fromNow=false result=rejected_${e.status}`);
          } else {
            notify(ctx, "NeurOn: control plane unreachable — try again", "error");
            log(`command extend: session=${sessionId} minutes=${minutes} fromNow=false result=unreachable`);
          }
        }
      } catch (e) {
        notify(ctx, `NeurOn: extend failed — ${e?.message ?? e}`, "error");
        log(`command extend failure: error=${e?.message ?? e}`);
      }
    }
  });

  // ── /neuron-done: native command, no LLM round-trip ─────────────────
  pi.registerCommand("neuron-done", {
    description:
      "End the active NeurOn reservation (same as the 'I'm Done' button). Clears local state and stops keepalive.",
    handler: async (args, ctx) => {
      try {
        if (!client?.config?.apiKey) {
          notify(ctx, "NeurOn: plugin not configured", "error");
          return;
        }
        const sessionId = getSessionId(ctx, undefined);
        const s = getOrCreateSession(sessionId, ctx);

        // Same gate as the input path: session model → provider filter.
        const model =
          s.model ??
          (ctx?.model?.id ? canonicalizeModel(ctx.model.provider, ctx.model.id) : null);
        if (!model) {
          notify(ctx, "NeurOn: no session model recorded yet", "warning");
          return;
        }
        const fullModel = model.fullModel;
        if (!matchesAllowedProvider(model.provider, fullModel, allowedProviders, log)) {
          notify(ctx, `NeurOn: ${fullModel} is not managed`, "warning");
          return;
        }

        // Bounded status read (preflight budget) + registry resolution.
        const status = await getLiveStatus(state.statusCache, client);
        if (!status) {
          notify(ctx, "NeurOn: control plane unreachable — try again", "error");
          return;
        }
        const sAfter = sessions.get(sessionId);
        if (!sAfter) return; // session shut down mid-flight
        const split = splitProvider(fullModel);
        const match = matchLiteLlmModel(
          status.capacityTargets ?? [],
          status.models ?? [],
          split.bareModelId,
          split.provider,
          client.config.strictProviderMatch
        );
        if (!match || match.error) {
          notify(ctx, `NeurOn: ${fullModel} is not managed`, "warning");
          return;
        }
        const targetId = match.targetIds[0];
        const resKey = `${sessionId}::${targetId}`;

        // Find the active reservation: the session's own local entry first,
        // then a server-side one.
        let reservationId = state.reservations.get(resKey)?.reservation?.reservationId;
        if (!reservationId) {
          const adopted = await adoptExistingReservation(
            client, state, targetId, status, sessionId, undefined, coreDeps
          );
          reservationId = adopted?.reservationId;
        }
        if (!reservationId) {
          notify(ctx, "NeurOn: no active reservation to end", "warning");
          return;
        }

        try {
          await client.markReservationDone(reservationId);
          // Clear local state: stop keepalive, delete reservation entry.
          state.reservations.delete(resKey);
          const sNow = sessions.get(sessionId);
          if (sNow?.timer) {
            clearInterval(sNow.timer);
            sNow.timer = null;
          }
          notify(ctx, `NeurOn: reservation ${reservationId} ended`);
          log(`command done: session=${sessionId} reservationId=${reservationId} result=ok`);
        } catch (e) {
          if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
            notify(ctx, `NeurOn: end rejected — ${e.body || e.message}`, "error");
            log(`command done: session=${sessionId} reservationId=${reservationId} result=rejected_${e.status}`);
          } else {
            notify(ctx, "NeurOn: control plane unreachable — try again", "error");
            log(`command done: session=${sessionId} reservationId=${reservationId} result=unreachable`);
          }
        }
      } catch (e) {
        notify(ctx, `NeurOn: done failed — ${e?.message ?? e}`, "error");
        log(`command done failure: error=${e?.message ?? e}`);
      }
    }
  });
}

/* Test-only hooks (harmless at runtime: pi only consumes the default
   export). The keepalive tick is driven directly in tests for
   determinism (no 5 s waits). */
export const __test = {
  reset() {
    for (const s of sessions.values()) if (s.timer) clearInterval(s.timer);
    sessions.clear();
    state.reservations.clear();
    state.inflight.clear();
    state.inflightTarget.clear();
    state.retryState.clear();
    state.sessionActivity.clear();
    state.sessionGenerations.clear();
    state.statusCache.value = null;
    state.statusCache.at = 0;
    state.statusCache.inflight = null;
    client = null;
    allowedProviders = [];
  },
  sessions,
  state,
  tick: (sessionId) => tickKeepalive(sessionId)
};
