// ── Status reads + target-state derivation ────────────────
// Bounded live/cached status reads over the client, and derivation of the
// observed target state for a model. The status cache is an injected plain
// object ({ value, at, inflight }) owned by the adapter; this module only
// mutates it.

import { splitProvider, matchLiteLlmModel, findTargetStatus } from "./models.js";

export const STATUS_CACHE_TTL = 3000;

// ── Authenticated-username discovery (adoption scoping) ─────
// The server-side reservation APIs (extend/done/status) are owner-scoped
// (admin can reach everything). Adapters must therefore only ADOPT
// reservations owned by their own user, otherwise every keepalive tick hits
// a 404 against a foreign lease. The username is resolved once per process
// from the injected state ({ username, usernamePromise, isAdmin }):
//  - config.username (NEURON_USERNAME) short-circuits the network call;
//  - otherwise GET /api/me is called once and memoized;
//  - a failed discovery leaves state.username undefined, and the caller
//    fails open (adopts as before) so a missing /api/me on an older control
//    plane never breaks the gate.

export async function resolveUsername(client, state, log = () => {}) {
  if (client.config.username) return client.config.username;
  if (state.username) return state.username;
  if (!state.usernamePromise) {
    state.usernamePromise = client.getMe().then((me) => {
      state.username = typeof me?.username === "string" ? me.username : undefined;
      state.isAdmin = Boolean(me?.isAdmin);
      return state.username;
    }).catch((e) => {
      log(`username discovery failed (failing open): ${e?.message ?? e}`);
      return undefined;
    }).finally(() => {
      state.usernamePromise = null;
    });
  }
  return state.usernamePromise;
}

export function getCachedStatus(cache, client) {
  // 1. Return cached resolved status while TTL valid
  if (cache.value && Date.now() - cache.at < STATUS_CACHE_TTL) {
    return cache.value;
  }
  // 2. If stale and fetch in-flight, await the in-flight request
  if (cache.inflight) {
    return cache.inflight;
  }
  // 3. Fetch new, set inflight, save resolved value+time, clear inflight
  cache.inflight = client.getStatus().then((result) => {
    cache.value = result;
    cache.at = Date.now();
    cache.inflight = null;
    return result;
  }).catch((e) => {
    cache.inflight = null;
    cache.value = null;
    cache.at = 0;
    throw e;
  });
  return cache.inflight;
}

export function invalidateStatusCache(cache) {
  cache.value = null;
  cache.at = 0;
}

// ── Utilities ─────────────────────────────────────────────

// The ONLY target states that may block a message or tool:
// the target is not usable and a cold start (reserve → warm → healthy) must
// actually happen. "healthy" returns immediately (background work only);
// "unreachable" fails open; any other unknown state fails open too.
export const COLD_START_BLOCKING_STATES = new Set(["cold", "stopped", "stopping"]);

export function shouldBlockForWarmup(targetState) {
  return COLD_START_BLOCKING_STATES.has(targetState);
}

// Compute the observed target state from a resolved status object.
// Returns "unknown" when the model cannot be mapped to a neuron target.
export function stateFromStatus(status, modelId, client) {
  try {
    const splitResult = splitProvider(modelId);
    const match = matchLiteLlmModel(
      status.capacityTargets ?? [],
      status.models ?? [],
      splitResult.bareModelId,
      splitResult.provider,
      client.config.strictProviderMatch
    );
    if (!match) return "unknown";
    if (match.error) return "unknown";
    const targetInfo = findTargetStatus(
      status.capacityTargets ?? [],
      match.targetIds[0]
    );
    return targetInfo?.observed ?? "unknown";
  } catch (e) {
    return "unknown";
  }
}

// Bounded live status read for hot paths. A fresh cache is returned with
// zero I/O; a stale/empty cache triggers one live fetch under the preflight
// timeout budget so a slow or dead control plane can never stall the
// message/tool/chat path. Fetch failure or timeout returns null (callers
// fail open). If the timer wins the race, the in-flight fetch keeps running
// and will refresh the cache when it completes.
export async function getLiveStatus(cache, client) {
  if (cache.value && Date.now() - cache.at < STATUS_CACHE_TTL) {
    return cache.value;
  }
  let timer;
  try {
    const status = await Promise.race([
      getCachedStatus(cache, client),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), client.config.preflightTimeoutMs);
      })
    ]);
    return status ?? null;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Cached-only preflight for synchronous, read-only lookups (e.g. the
// model-switch log/toast context). Returns the observed target state when
// the status cache is fresh, or "unknown" otherwise. Never performs
// network I/O — hot paths use getTargetStateLive instead.
export function getTargetStateNow(cache, client, modelId) {
  if (!cache.value || Date.now() - cache.at >= STATUS_CACHE_TTL) {
    return "unknown";
  }
  return stateFromStatus(cache.value, modelId, client);
}

// Bounded preflight for hot paths. A fresh cache is used with zero I/O; a
// stale/empty cache triggers one bounded live check so a cold target is
// caught BEFORE the request races it (a failed first request would otherwise
// trigger downstream model fallbacks). Unknown/unreachable states fail open;
// only a cold/stopped/stopping state (fresh or freshly verified) lets the
// caller's cold-start block engage.
export async function getTargetStateLive(cache, client, modelId) {
  const status = await getLiveStatus(cache, client);
  if (!status) return "unknown";
  return stateFromStatus(status, modelId, client);
}
