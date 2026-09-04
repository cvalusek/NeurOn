// ── Reservation flow (keyed by model ID + target ID) ────────
// The ensure-reservation flow: resolve the model's target, then adopt an
// existing server-side reservation or create a new one (bounded retry
// backoff + jitter) and wait for healthy. All reservation state is injected
// (the adapter owns the `state` object); this module is timer-free and owns
// no process state of its own. `deps` carries the adapter's log and the
// keepalive timer arm callback (setInterval lives in the adapter).

import { DEFAULT_DURATION_MINUTES, harnessLabelOf } from "./config.js";
import { splitProvider, matchLiteLlmModel, findTargetStatus } from "./models.js";
import { getCachedStatus, getLiveStatus, invalidateStatusCache, resolveUsername } from "./status.js";
import { NeurOnApiError, sleep } from "./client.js";

// ── Session generation tokens (stale-work guards) ─────────
// A per-session generation number, bumped whenever the session is deleted.
// Async background work (reservation creation, warmup, adoption, keepalive
// refresh) captures the generation at launch and re-checks it after each
// await before touching reservation state or starting timers. If the session
// was deleted in the meantime (or a new session re-used the same ID with a
// fresh generation), the stale work aborts and leaves no state behind. A
// re-created session gets a higher generation and its work always passes.

export function currentSessionGeneration(state, sessionID) {
  return state.sessionGenerations.get(sessionID) ?? 0;
}

export function isSessionGenerationCurrent(state, sessionID, generation, log = () => {}) {
  // undefined is a programming error (the caller failed to capture a
  // generation) — log once per site and fail closed so a missed capture can
  // never write state for a deleted session.
  if (generation === undefined) {
    log(`isSessionGenerationCurrent: generation not captured (failing closed) session=${sessionID}`);
    return false;
  }
  return currentSessionGeneration(state, sessionID) === generation;
}

export function invalidateSessionGeneration(state, sessionID) {
  if (!sessionID) return;
  state.sessionGenerations.set(sessionID, (currentSessionGeneration(state, sessionID) ?? 0) + 1);
}

export async function resolveTargetForModel(client, state, modelId, sessionID, generation, deps) {
  // generation: the caller's captured session generation, when it is guarding
  // against stale work; undefined for synchronous live calls (adopt freely).
  // Initial status read is preflight-bounded (getLiveStatus races against
  // preflightTimeoutMs) so a slow or dead control plane can never stall the
  // gate's message/tool/chat path for the full requestTimeoutMs. A timeout or
  // fetch failure yields null here and surfaces as "unreachable" below
  // (fail-closed: the turn is dropped with a control-plane error, and the
  // in-flight fetch keeps running to refresh the cache for the next turn).
  let status;
  try {
    status = await getLiveStatus(state.statusCache, client);
  } catch (error) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} error=${error?.message ?? error}`);
    throw error;
  }
  if (!status) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} targetId=none reason=unreachable`);
    throw new Error(`NeurOn: control plane unreachable while resolving model "${modelId}"`);
  }
  const splitResult = splitProvider(modelId);

  // ── Server-driven matching ──
  const match = matchLiteLlmModel(
    status.capacityTargets ?? [],
    status.models ?? [],
    splitResult.bareModelId,
    splitResult.provider,
    client.config.strictProviderMatch
  );
  if (!match) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} targetId=none reason=no_match`);
    throw new Error(
      `NeurOn could not map ${harnessLabelOf(client.config)} model "${modelId}" to a capacity target`
    );
  }
  if (match.error) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} targetId=none reason=${match.error}`);
    throw new Error(`NeurOn ${match.error}: ${match.detail}`);
  }
  const targetId = match.targetIds[0];
  const targetInfo = findTargetStatus(status.capacityTargets ?? [], targetId);
  const targetHealthy = targetInfo?.observed === "healthy";
  const resKey = `${sessionID}::${targetId}`;

  // If target is healthy and this session has no local reservation, adopt the
  // server-side one. The caller's captured generation guards the adoption so
  // stale async work for a deleted session cannot write state.
  if (targetHealthy && !state.reservations.has(resKey)) {
    try {
      await adoptExistingReservation(client, state, targetId, status, sessionID, generation, deps);
    } catch (e) {
      /* ignore — we'll create a new reservation if needed */
    }
  }

  deps.log(`resolve target success: model=${modelId} session=${sessionID} targetId=${targetId} observed=${targetInfo?.observed ?? "unknown"}`);
  return { targetId, match, targetHealthy, resKey };
}

// Determine if an error is transient and worth retrying.
// Transient: timeout (status 0), rate-limited (429), server errors (5xx).
// Permanent (no retry): 4xx client errors, mapping/config errors.
export function isTransientError(err) {
  if (err instanceof NeurOnApiError) {
    // status 0 = timeout/network failure → transient
    if (err.status === 0) return true;
    // 429 rate limited → transient
    if (err.status === 429) return true;
    // 5xx server errors → transient
    if (err.status >= 500 && err.status < 600) return true;
    // All other 4xx are permanent — do not retry
    return false;
  }
  // Network/transport errors (non-NeurOnApiError) → assume transient
  return true;
}

// Bounded exponential backoff with jitter for reservation retries.
export async function retryWithBackoff(state, key, fn, maxAttempts, baseMs, maxMs) {
  const rs = state.retryState.get(key) ?? { attempts: 0, nextDelay: baseMs };
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      // Success — reset retry state immediately
      state.retryState.delete(key);
      return result;
    } catch (err) {
      lastErr = err;
      // Permanent errors — fail fast without further retries
      if (!isTransientError(err)) throw err;
      if (attempt < maxAttempts - 1) {
        const jitter = Math.random() * rs.nextDelay;
        const delay = rs.nextDelay + jitter;
        await sleep(Math.min(delay, maxMs));
        rs.nextDelay = Math.min(rs.nextDelay * 2, maxMs);
        rs.attempts = attempt + 1;
      }
    }
  }
  state.retryState.delete(key);
  throw lastErr;
}

export async function reserveOrRefreshTarget(client, state, targetId, match, sessionID, generation, deps) {
  const resKey = `${sessionID}::${targetId}`;
  const existingEntry = state.reservations.get(resKey);
  if (existingEntry) {
    if (existingEntry.expiresAt < Date.now()) {
      state.reservations.delete(resKey);
    } else {
      try {
        deps.log(`reservation decision: refresh local targetId=${targetId} session=${sessionID} reservationId=${existingEntry.reservation.reservationId}`);
        const refreshed = await client.refreshReservation(existingEntry.reservation.reservationId);
        if (!isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
          deps.log(`reserveOrRefreshTarget skipped save (session stale): targetId=${targetId} session=${sessionID}`);
          return refreshed;
        }
        return saveReservation(client, state, targetId, refreshed, sessionID, generation, deps);
      } catch (error) {
        state.reservations.delete(resKey);
      }
    }
  }

  // Before creating, check the server directly for a reservation another session made.
  const status = await getCachedStatus(state.statusCache, client);
  if (!isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
    deps.log(`reserveOrRefreshTarget skipped adopt (session stale): targetId=${targetId} session=${sessionID}`);
    return undefined;
  }
  const adopted = await adoptExistingReservation(client, state, targetId, status, sessionID, generation, deps);
  if (adopted) {
    deps.log(`reservation decision: adopt remote+refresh targetId=${targetId} session=${sessionID} reservationId=${adopted.reservationId}`);
    const refreshed = await client.refreshReservation(adopted.reservationId);
    if (!isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
      deps.log(`reserveOrRefreshTarget skipped save (session stale): targetId=${targetId} session=${sessionID}`);
      return refreshed;
    }
    return saveReservation(client, state, targetId, refreshed, sessionID, generation, deps);
  }

  // Fall through to create new reservation (with retry backoff + jitter).
  // Re-check the generation immediately before the create call so a session
  // deleted while status/adoption work ran never triggers a fresh reservation.
  if (!isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
    deps.log(`reserveOrRefreshTarget skipped create (session stale): targetId=${targetId} session=${sessionID}`);
    return undefined;
  }
  const retryKey = `${sessionID}::${targetId}::reserve`;
  let reservation;
  try {
    deps.log(`reservation decision: create new reservation targetId=${targetId} session=${sessionID}`);
    reservation = await retryWithBackoff(
      state,
      retryKey,
      () => client.createReservation(match),
      client.config.retryMaxAttempts,
      client.config.retryBaseMs,
      client.config.retryMaxMs
    );
  } catch (error) {
    deps.log(`reservation create fail: targetId=${targetId} session=${sessionID} error=${error?.message ?? error}`);
    throw error;
  }
  saveReservation(client, state, targetId, reservation, sessionID, generation, deps);
  try {
    if (client.config.waitForHealthy) {
      await client.waitForHealthy(reservation.reservationId, () => invalidateStatusCache(state.statusCache));
    }
  } catch (e) {
    state.reservations.delete(resKey);
    throw e;
  }
  return reservation;
}

export function saveReservation(client, state, targetId, reservation, sessionID, generation, deps, { remainingMs } = {}) {
  const resKey = `${sessionID}::${targetId}`;
  // Effective generation for stale checks: the caller's captured generation
  // when it guarded, otherwise the live generation captured at arm time.
  // The keepalive timer uses this for every stale check it performs.
  const timerGeneration = generation ?? currentSessionGeneration(state, sessionID);
  // Stale-work guard: background reservation/warmup work that outlived the
  // session must not recreate reservation state or keepalive timers.
  // (generation === undefined means the caller didn't guard — legacy path.)
  if (generation !== undefined && !isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
    deps.log(`saveReservation skipped (session stale): targetId=${targetId} session=${sessionID}`);
    return reservation;
  }
  const minutes = reservation.keepaliveMinutes ?? reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  // Resolve the effective remaining lifetime, in priority order:
  //  1. remainingMs — explicitly computed by the caller (adoption path).
  //  2. reservation.expiresAt — the server's authoritative expiry clock
  //     (accounts for prior extends; the /neuron-extend response carries it).
  //  3. Full duration — fallback for create (server hasn't set an expiry yet)
  //     or when the response lacks the field.
  let lifeMs;
  if (remainingMs != null) {
    lifeMs = remainingMs;
  } else if (reservation.expiresAt) {
    const serverExpiry = Date.parse(reservation.expiresAt);
    if (Number.isFinite(serverExpiry) && serverExpiry > Date.now()) {
      lifeMs = serverExpiry - Date.now();
    }
  }
  if (lifeMs == null) {
    lifeMs = minutes * 60 * 1000;
  }
  const entry = {
    reservation,
    expiresAt: Date.now() + lifeMs
  };
  state.reservations.set(resKey, entry);

  // A create/adopt/extend is a new baseline: restart the keepalive countdown.
  deps.armKeepalive(resKey, targetId, sessionID, client, timerGeneration, true, lifeMs);
  return reservation;
}

// Compute the actual remaining lifetime of a reservation. Prefers the
// server-provided expiresAt (authoritative); falls back to createdAt +
// durationMinutes when expiresAt is absent. Returns null when the data is
// insufficient or the reservation has already expired (caller should not
// adopt it).
export function computeRemainingMs(reservation) {
  if (!reservation) return null;
  // Prefer the server's own expiry clock — it accounts for any prior extends.
  if (reservation.expiresAt) {
    const expiry = Date.parse(reservation.expiresAt);
    if (Number.isFinite(expiry)) {
      const remaining = expiry - Date.now();
      return remaining > 0 ? remaining : null;
    }
  }
  // Fallback: createdAt + durationMinutes (may be stale if the reservation
  // was extended after creation).
  if (!reservation.createdAt) return null;
  const durationMin = reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const expiry = new Date(reservation.createdAt).getTime() + durationMin * 60 * 1000;
  const remaining = expiry - Date.now();
  return remaining > 0 ? remaining : null;
}

// The server-side reservation APIs are owner-scoped: a non-admin can only
// extend/inspect its own reservations. Adopting a foreign reservation would
// therefore only produce 404 churn on every keepalive tick. Skip foreign
// reservations when the authenticated username is known; fail open (adopt
// as before) when it could not be resolved (older control plane, network
// blip) so the gate keeps working. Admins adopt freely — their key is
// allowed to reach every reservation by server design.
export function isOwnReservation(res, state) {
  if (!state.username) return true;
  if (state.isAdmin) return true;
  return res.username === state.username;
}

export async function adoptExistingReservation(client, state, targetId, status, sessionID, generation, deps) {
  // Username discovery is async (one GET /api/me, memoized on state); this
  // used to be synchronous, so all call sites must await it.
  await resolveUsername(client, state, deps.log);
  const active = [
    ...(status.activeReservations ?? []),
    ...(status.reservations ?? [])
  ];
  for (const res of active) {
    const targets = res.targets ?? [];
    for (const t of targets) {
      if ((t.id ?? t) === targetId && res.status === "active") {
        if (!isOwnReservation(res, state)) {
          deps.log(`adopt skipped (foreign): targetId=${targetId} reservationId=${res.reservationId} owner=${res.username ?? "unknown"}`);
          return null;
        }
        // Generation-aware adoption. The caller captured `generation` before
        // its async work started:
        //  - undefined  → live synchronous call for the current session:
        //                  adopt freely (fresh sessions adopt remote active
        //                  reservations as before).
        //  - still current → the caller's session is the same one it started
        //                    as (or was legitimately re-created): adopt.
        //  - stale → the session was deleted while the caller's async work ran;
        //                  never write state/timers for it.
        if (generation === undefined || isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
          const remainingMs = computeRemainingMs(res);
          if (remainingMs === null) {
            // Cannot compute remaining time (no createdAt/expiresAt, or our
            // estimate says expired). The server still reports it as active —
            // trust the server and adopt with the full duration (old behavior).
            deps.log(`adopt (full-duration fallback): targetId=${targetId} reservationId=${res.reservationId}`);
            saveReservation(client, state, targetId, res, sessionID, generation, deps);
          } else {
            deps.log(`adopt (remaining=${Math.round(remainingMs / 60000)}min): targetId=${targetId} reservationId=${res.reservationId}`);
            saveReservation(client, state, targetId, res, sessionID, generation, deps, { remainingMs });
          }
          return res;
        }
        return null;
      }
    }
  }
  return null;
}

export function ensureReservation(client, state, modelId, sessionID, deps) {
  const inflightKey = `${sessionID}::${modelId}`;
  const existing = state.inflight.get(inflightKey);
  if (existing) {
    return existing;
  }

  // Capture the session generation at launch. If the session is deleted (or
  // re-created) while this async chain runs, the stale work aborts before
  // writing any reservation state or keepalive timers.
  const generation = currentSessionGeneration(state, sessionID);
  const promise = resolveTargetForModel(client, state, modelId, sessionID, generation, deps)
    .then(async ({ targetId, match }) => {
      if (!isSessionGenerationCurrent(state, sessionID, generation, deps.log)) {
        deps.log(`ensureReservation skipped (session stale): model=${modelId} session=${sessionID}`);
        return undefined;
      }
      // Secondary dedup at target level for models sharing targets
      const targetInflightKey = `${sessionID}::${targetId}`;
      const targetInflight = state.inflightTarget.get(targetInflightKey);
      if (targetInflight) return targetInflight;

      const p = reserveOrRefreshTarget(client, state, targetId, match, sessionID, generation, deps).finally(() => {
        state.inflightTarget.delete(targetInflightKey);
      });
      state.inflightTarget.set(targetInflightKey, p);
      return p;
    })
    .finally(() => { state.inflight.delete(inflightKey); });

  state.inflight.set(inflightKey, promise);
  return promise;
}
