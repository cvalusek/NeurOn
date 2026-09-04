// src/opencode-adapter.js
import fs from "node:fs/promises";

// ../shared/neuron-core/config.js
var DEFAULT_POLL_S = 5;
var DEFAULT_DURATION_MINUTES = 2;
var DEFAULT_WAIT_TIMEOUT_S = 600;
var DEFAULT_HARNESS_LABEL = "OpenCode";
function harnessLabelOf(config) {
  return config?.harnessLabel || DEFAULT_HARNESS_LABEL;
}
function loadConfig(env = process.env, harnessLabel = DEFAULT_HARNESS_LABEL) {
  const raw = env.NEURON_ALLOWED_PROVIDERS;
  const allowedProviders = raw ? raw.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const baseUrl = env.NEURON_API_BASE_URL || "http://localhost:8090";
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))
    throw new Error("NEURON_API_BASE_URL must be a valid http:// or https:// URL");
  return {
    apiBaseUrl: trimSlash(baseUrl),
    apiKey: env.NEURON_API_KEY,
    durationMinutes: positiveNumber(
      env.NEURON_RESERVATION_DURATION_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    keepaliveMinutes: positiveNumber(
      env.NEURON_RESERVATION_KEEPALIVE_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    waitForHealthy: boolEnv(env.NEURON_WAIT_FOR_HEALTHY, true),
    waitTimeoutMs: positiveNumber(env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_S) * 1e3,
    pollMs: positiveNumber(env.NEURON_WAIT_POLL_SECONDS, DEFAULT_POLL_S) * 1e3,
    requestTimeoutMs: positiveNumber(env.NEURON_REQUEST_TIMEOUT_MS, 8e3),
    preflightTimeoutMs: positiveNumber(env.NEURON_PREFLIGHT_TIMEOUT_MS, 2e3),
    cooldownPeriodMs: positiveNumber(env.NEURON_COOLDOWN_PERIOD_MS, 3e4),
    retryMaxAttempts: positiveNumber(env.NEURON_RETRY_MAX_ATTEMPTS, 3),
    retryBaseMs: positiveNumber(env.NEURON_RETRY_BASE_MS, 1e3),
    retryMaxMs: positiveNumber(env.NEURON_RETRY_MAX_MS, 8e3),
    blockOnColdMessage: boolEnv(env.NEURON_BLOCK_ON_COLD_MESSAGE, false),
    bypassMessageHook: boolEnv(env.NEURON_BYPASS_MESSAGE_HOOK, false),
    strictProviderMatch: boolEnv(env.NEURON_STRICT_PROVIDER_MATCH, false),
    warmupLockTimeoutMs: positiveNumber(env.NEURON_WARMUP_LOCK_TIMEOUT_MS, 6e4),
    // Pin the authenticated username for lease/adoption scoping. Without it
    // the harness discovers the username lazily via GET /api/me (cached on
    // the injected state). Useful for tests and for operators who know their
    // username in advance.
    username: env.NEURON_USERNAME || void 0,
    allowedProviders,
    harnessLabel
  };
}
function matchesAllowedProvider(providerId, modelId, allowedProviders, log2 = () => {
}) {
  if (!allowedProviders.length) return true;
  if (providerId) {
    for (const p of allowedProviders)
      if (providerId.toLowerCase() === p.toLowerCase()) return true;
    log2(`allowed-provider skip: provider=${providerId} model=${modelId} allowed=${allowedProviders.join(",")}`);
    return false;
  }
  for (const p of allowedProviders)
    if (modelId.startsWith(p + "/")) return true;
  log2(`allowed-provider skip: provider=none model=${modelId} allowed=${allowedProviders.join(",")}`);
  return false;
}
function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function boolEnv(value, fallback) {
  if (value === void 0) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

// ../shared/neuron-core/models.js
function splitProvider(modelId) {
  const slash = modelId.indexOf("/");
  if (slash > 0 && slash < modelId.length - 1) {
    return { provider: modelId.slice(0, slash), bareModelId: modelId.slice(slash + 1) };
  }
  return { provider: void 0, bareModelId: modelId };
}
function canonicalizeModel(provider, modelId) {
  const id = modelId ?? "";
  let finalProvider = provider;
  let bareModelId;
  if (provider) {
    if (id.startsWith(provider + "/")) {
      bareModelId = id.slice(provider.length + 1);
    } else {
      bareModelId = id;
    }
  } else {
    const split = splitProvider(id);
    finalProvider = split.provider;
    bareModelId = split.bareModelId;
  }
  const fullModel = finalProvider ? `${finalProvider}/${bareModelId}` : bareModelId;
  return { provider: finalProvider, bareModelId, fullModel };
}
function resolveProviderFallback(fallbackTargets, bareModelId, strictProviderMatch, targetIdHint) {
  if (targetIdHint) {
    const hinted = fallbackTargets.find((t) => t.id === targetIdHint);
    if (hinted) return { targetIds: [hinted.id] };
  }
  if (!strictProviderMatch && fallbackTargets.length === 1) {
    return { targetIds: [fallbackTargets[0].id] };
  }
  if (!strictProviderMatch && fallbackTargets.length > 1) {
    const providers = [...new Set(fallbackTargets.map((t) => t.provider?.toLowerCase()).filter(Boolean))];
    if (providers.length === 1) {
      return { targetIds: [fallbackTargets[0].id] };
    }
    if (providers.length === 0) {
      return { error: "provider_mapping_error", detail: `Model "${bareModelId}" has multiple NeurOn targets with missing provider metadata.` };
    }
    return { error: "provider_mapping_error", detail: `Model "${bareModelId}" is on multiple NeurOn providers (${providers.join(", ")}). Configure provider mapping or use strict provider labels.` };
  }
  return null;
}
function matchLiteLlmModel(targets, models, bareModelId, provider, strictProviderMatch = false) {
  const modelByLookup = buildModelLookup(models);
  const segments = bareModelId.split("/");
  const candidates = [];
  for (let i = 0; i < segments.length; i++) {
    candidates.push(segments.slice(i).join("/"));
  }
  const targetIdHint = segments.length > 1 ? segments[0] : void 0;
  let model = null;
  let matchedCandidate = null;
  for (const c of candidates) {
    const m = modelByLookup.get(c);
    if (m && m.targetIds?.length) {
      model = m;
      matchedCandidate = c;
      break;
    }
  }
  if (model) {
    if (targetIdHint) {
      const exact = targets.find((t) => model.targetIds.includes(t.id) && t.id === targetIdHint);
      if (exact) return { modelIds: [model.id], targetIds: [exact.id] };
    }
    if (provider) {
      const pLower = provider.toLowerCase();
      const providerFallbackTargets = [];
      for (const target of targets) {
        if (model.targetIds.includes(target.id) && target.provider?.toLowerCase() === pLower) {
          return { modelIds: [model.id], targetIds: [target.id] };
        }
        if (model.targetIds.includes(target.id)) {
          providerFallbackTargets.push(target);
        }
      }
      const fallback = resolveProviderFallback(providerFallbackTargets, matchedCandidate, strictProviderMatch, targetIdHint);
      if (fallback) {
        if (fallback.error) return fallback;
        return { modelIds: [model.id], targetIds: fallback.targetIds };
      }
      return { error: "provider_mapping_error", detail: `Model "${matchedCandidate}" not found on provider "${provider}".` };
    }
    const pass1Providers = /* @__PURE__ */ new Set();
    let pass1Primary = null;
    for (const target of targets) {
      if (model.targetIds.includes(target.id)) {
        if (!pass1Primary) pass1Primary = target;
        if (target.provider) pass1Providers.add(target.provider.toLowerCase());
      }
    }
    if (pass1Providers.size > 1) {
      return { error: `ambiguous_model_mapping`, detail: `Model "${matchedCandidate}" is available on providers: ${[...pass1Providers].join(", ")}. Specify provider explicitly.` };
    }
    if (pass1Primary) {
      return { modelIds: [model.id], targetIds: [pass1Primary.id] };
    }
  }
  let primaryMatch = null;
  const providerFallbackMatches = [];
  let altProviders = /* @__PURE__ */ new Set();
  for (const target of targets) {
    if (!candidates.some((c) => target.modelIds?.includes(c))) continue;
    if (provider) {
      const tProv = target.provider?.toLowerCase();
      if (tProv === provider.toLowerCase()) {
        return { modelIds: [matchedCandidate ?? bareModelId], targetIds: [target.id] };
      }
      providerFallbackMatches.push(target);
      if (tProv) altProviders.add(tProv);
    } else {
      if (!primaryMatch) primaryMatch = target;
      if (target.provider) {
        altProviders.add(target.provider.toLowerCase());
      }
    }
  }
  if (provider) {
    const fallback = resolveProviderFallback(providerFallbackMatches, matchedCandidate ?? bareModelId, strictProviderMatch, targetIdHint);
    if (fallback) {
      if (fallback.error) return fallback;
      return { modelIds: [matchedCandidate ?? bareModelId], targetIds: fallback.targetIds };
    }
    return { error: "provider_mapping_error", detail: `Model "${bareModelId}" not found on provider "${provider}". Available providers: ${[...altProviders].join(", ")}.` };
  }
  if (!provider && altProviders.size > 1) {
    return { error: `ambiguous_model_mapping`, detail: `Model "${bareModelId}" is available on providers: ${[...altProviders].join(", ")}. Specify provider explicitly.` };
  }
  if (primaryMatch) {
    return { modelIds: [matchedCandidate ?? bareModelId], targetIds: [primaryMatch.id] };
  }
  const directTarget = targets.find((t) => t.id === bareModelId);
  if (directTarget) {
    const modelId = directTarget.modelIds?.[0];
    if (modelId) return { modelIds: [modelId], targetIds: [directTarget.id] };
    return { targetIds: [directTarget.id] };
  }
  return void 0;
}
function buildModelLookup(models) {
  const lookup = /* @__PURE__ */ new Map();
  for (const model of models) {
    for (const id of [
      model.id,
      ...model.aliases ?? [],
      ...model.backendModelIds ?? [],
      ...model.runtimeModelIds ?? []
    ]) {
      if (id) lookup.set(id, model);
    }
  }
  return lookup;
}
function findTargetStatus(targets, targetId) {
  for (const t of targets)
    if (t.id === targetId) return t;
  return void 0;
}

// ../shared/neuron-core/client.js
var NeurOnApiError = class extends Error {
  constructor(status, path, body, statusText) {
    super(`NeurOn API ${status} for ${path}: ${body || statusText}`);
    this.status = status;
    this.body = body || statusText;
  }
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var NeurOnClient = class {
  constructor(config) {
    this.config = config;
  }
  async getStatus() {
    const [status, models, clientModels] = await Promise.all([
      this.request("/api/status"),
      this.request("/api/models"),
      this.request("/api/client-models").catch((error) => {
        if (error instanceof NeurOnApiError && error.status === 404) return { models: [] };
        throw error;
      })
    ]);
    return { ...status, models: mergeClientModels(models.models ?? [], clientModels.models ?? []) };
  }
  // The authenticated user for this API key ({username, isAdmin}). Used for
  // lease/adoption scoping so a harness only ever touches its own
  // reservations.
  async getMe() {
    return this.request("/api/me");
  }
  async createReservation(match) {
    return this.request("/api/reservations", {
      method: "POST",
      body: JSON.stringify({
        modelIds: match.modelIds,
        targetIds: match.targetIds,
        durationMinutes: this.config.durationMinutes,
        keepaliveMinutes: this.config.keepaliveMinutes
      })
    });
  }
  async refreshReservation(reservationId) {
    return this.request(`/api/reservations/${encodeURIComponent(reservationId)}/extend`, {
      method: "POST",
      body: JSON.stringify({
        durationMinutes: this.config.durationMinutes,
        fromNow: true
      })
    });
  }
  // Manual extension for the /neuron-extend command. Unlike refreshReservation
  // (keepalive: fromNow:true, config duration), the duration and fromNow flag
  // are caller-supplied — the command uses fromNow:false for additive semantics
  // (server computes expiry = max(now, currentExpiry) + N, never shrinks).
  async extendReservation(reservationId, durationMinutes, { fromNow }) {
    return this.request(`/api/reservations/${encodeURIComponent(reservationId)}/extend`, {
      method: "POST",
      body: JSON.stringify({ durationMinutes, fromNow })
    });
  }
  // Manual "I'm Done" for the /neuron-done command. Marks the reservation done
  // server-side (same endpoint the web UI "I'm Done" button calls). No body —
  // the server closes the reservation; the reconciler shuts down targets when
  // no other active reservations remain.
  async markReservationDone(reservationId) {
    return this.request(`/api/reservations/${encodeURIComponent(reservationId)}/done`, {
      method: "POST"
    });
  }
  // Bounded wait for the reservation's targets to report healthy. The optional
  // invalidateStatusCache callback is invoked once the healthy state is
  // observed (the injected status cache is owned by the adapter).
  async waitForHealthy(reservationId, invalidateStatusCache2) {
    const deadline = Date.now() + this.config.waitTimeoutMs;
    let lastReservation;
    while (Date.now() <= deadline) {
      lastReservation = await this.request(
        `/api/reservations/${encodeURIComponent(reservationId)}/status`
      );
      if (lastReservation.targets?.every((t) => t.observed === "healthy")) {
        if (typeof invalidateStatusCache2 === "function") invalidateStatusCache2();
        return lastReservation;
      }
      const failed = lastReservation.targets?.find((t) => t.observed === "failed");
      if (failed)
        throw new Error(`NeurOn target ${failed.id} failed: ${failed.message}`);
      }
      await sleep(this.config.pollMs);
    }
    const states = (lastReservation?.targets ?? []).map((t) => `${t.id}:${t.observed}`).join(", ");
    throw new Error(
      `Timed out waiting for NeurOn reservation ${reservationId} to become healthy${states ? ` (${states})` : ""}`
    );
  }
  async request(path, options = {}, requestTimeoutMs) {
    if (!this.config.apiKey)
      throw new Error(
        `NEURON_API_KEY is required for the NeurOn ${harnessLabelOf(this.config)} plugin`
      );
    const controller = new AbortController();
    const timeout = requestTimeoutMs ?? this.config.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...options,
        headers: {
          // Only set content-type when a body is present — Fastify rejects
          // content-type: application/json with an empty body (the /done
          // endpoint sends no body).
          ...options.body != null ? { "content-type": "application/json" } : {},
          authorization: `Bearer ${this.config.apiKey}`,
          ...options.headers ?? {}
        },
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text();
        throw new NeurOnApiError(response.status, path, body, response.statusText);
      }
      const raw = await response.text();
      try {
        return JSON.parse(raw);
      } catch (parseErr) {
        throw new NeurOnApiError(0, path, `Failed to parse response: ${raw}`, "invalid_json");
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new NeurOnApiError(0, path, "Request timed out", "timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
};

// ../shared/neuron-core/status.js
var STATUS_CACHE_TTL = 3e3;
async function resolveUsername(client, state2, log2 = () => {
}) {
  if (client.config.username) return client.config.username;
  if (state2.username) return state2.username;
  if (!state2.usernamePromise) {
    state2.usernamePromise = client.getMe().then((me) => {
      state2.username = typeof me?.username === "string" ? me.username : void 0;
      state2.isAdmin = Boolean(me?.isAdmin);
      return state2.username;
    }).catch((e) => {
      log2(`username discovery failed (failing open): ${e?.message ?? e}`);
      return void 0;
    }).finally(() => {
      state2.usernamePromise = null;
    });
  }
  return state2.usernamePromise;
}
function getCachedStatus(cache, client) {
  if (cache.value && Date.now() - cache.at < STATUS_CACHE_TTL) {
    return cache.value;
  }
  if (cache.inflight) {
    return cache.inflight;
  }
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
function invalidateStatusCache(cache) {
  cache.value = null;
  cache.at = 0;
}
var COLD_START_BLOCKING_STATES = /* @__PURE__ */ new Set(["cold", "stopped", "stopping"]);
function shouldBlockForWarmup(targetState) {
  return COLD_START_BLOCKING_STATES.has(targetState);
}
function stateFromStatus(status, modelId, client) {
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
async function getLiveStatus(cache, client) {
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
function getTargetStateNow(cache, client, modelId) {
  if (!cache.value || Date.now() - cache.at >= STATUS_CACHE_TTL) {
    return "unknown";
  }
  return stateFromStatus(cache.value, modelId, client);
}
async function getTargetStateLive(cache, client, modelId) {
  const status = await getLiveStatus(cache, client);
  if (!status) return "unknown";
  return stateFromStatus(status, modelId, client);
}

// ../shared/neuron-core/reservation.js
function currentSessionGeneration(state2, sessionID) {
  return state2.sessionGenerations.get(sessionID) ?? 0;
}
function isSessionGenerationCurrent(state2, sessionID, generation, log2 = () => {
}) {
  if (generation === void 0) {
    log2(`isSessionGenerationCurrent: generation not captured (failing closed) session=${sessionID}`);
    return false;
  }
  return currentSessionGeneration(state2, sessionID) === generation;
}
function invalidateSessionGeneration(state2, sessionID) {
  if (!sessionID) return;
  state2.sessionGenerations.set(sessionID, (currentSessionGeneration(state2, sessionID) ?? 0) + 1);
}
async function resolveTargetForModel(client, state2, modelId, sessionID, generation, deps) {
  let status;
  try {
    status = await getLiveStatus(state2.statusCache, client);
  } catch (error) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} error=${error?.message ?? error}`);
    throw error;
  }
  if (!status) {
    deps.log(`resolve target failure: model=${modelId} session=${sessionID} targetId=none reason=unreachable`);
    throw new Error(`NeurOn: control plane unreachable while resolving model "${modelId}"`);
  }
  const splitResult = splitProvider(modelId);
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
  if (targetHealthy && !state2.reservations.has(resKey)) {
    try {
      await adoptExistingReservation(client, state2, targetId, status, sessionID, generation, deps);
    } catch (e) {
    }
  }
  deps.log(`resolve target success: model=${modelId} session=${sessionID} targetId=${targetId} observed=${targetInfo?.observed ?? "unknown"}`);
  return { targetId, match, targetHealthy, resKey };
}
function isTransientError(err) {
  if (err instanceof NeurOnApiError) {
    if (err.status === 0) return true;
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  return true;
}
async function retryWithBackoff(state2, key, fn, maxAttempts, baseMs, maxMs) {
  const rs = state2.retryState.get(key) ?? { attempts: 0, nextDelay: baseMs };
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      state2.retryState.delete(key);
      return result;
    } catch (err) {
      lastErr = err;
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
  state2.retryState.delete(key);
  throw lastErr;
}
async function reserveOrRefreshTarget(client, state2, targetId, match, sessionID, generation, deps) {
  const resKey = `${sessionID}::${targetId}`;
  const existingEntry = state2.reservations.get(resKey);
  if (existingEntry) {
    if (existingEntry.expiresAt < Date.now()) {
      state2.reservations.delete(resKey);
    } else {
      try {
        deps.log(`reservation decision: refresh local targetId=${targetId} session=${sessionID} reservationId=${existingEntry.reservation.reservationId}`);
        const refreshed = await client.refreshReservation(existingEntry.reservation.reservationId);
        if (!isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
          deps.log(`reserveOrRefreshTarget skipped save (session stale): targetId=${targetId} session=${sessionID}`);
          return refreshed;
        }
        return saveReservation(client, state2, targetId, refreshed, sessionID, generation, deps);
      } catch (error) {
        state2.reservations.delete(resKey);
      }
    }
  }
  const status = await getCachedStatus(state2.statusCache, client);
  if (!isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
    deps.log(`reserveOrRefreshTarget skipped adopt (session stale): targetId=${targetId} session=${sessionID}`);
    return void 0;
  }
  const adopted = await adoptExistingReservation(client, state2, targetId, status, sessionID, generation, deps);
  if (adopted) {
    deps.log(`reservation decision: adopt remote+refresh targetId=${targetId} session=${sessionID} reservationId=${adopted.reservationId}`);
    const refreshed = await client.refreshReservation(adopted.reservationId);
    if (!isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
      deps.log(`reserveOrRefreshTarget skipped save (session stale): targetId=${targetId} session=${sessionID}`);
      return refreshed;
    }
    return saveReservation(client, state2, targetId, refreshed, sessionID, generation, deps);
  }
  if (!isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
    deps.log(`reserveOrRefreshTarget skipped create (session stale): targetId=${targetId} session=${sessionID}`);
    return void 0;
  }
  const retryKey = `${sessionID}::${targetId}::reserve`;
  let reservation;
  try {
    deps.log(`reservation decision: create new reservation targetId=${targetId} session=${sessionID}`);
    reservation = await retryWithBackoff(
      state2,
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
  saveReservation(client, state2, targetId, reservation, sessionID, generation, deps);
  try {
    if (client.config.waitForHealthy) {
      await client.waitForHealthy(reservation.reservationId, () => invalidateStatusCache(state2.statusCache));
    }
  } catch (e) {
    state2.reservations.delete(resKey);
    throw e;
  }
  return reservation;
}
function saveReservation(client, state2, targetId, reservation, sessionID, generation, deps, { remainingMs } = {}) {
  const resKey = `${sessionID}::${targetId}`;
  const timerGeneration = generation ?? currentSessionGeneration(state2, sessionID);
  if (generation !== void 0 && !isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
    deps.log(`saveReservation skipped (session stale): targetId=${targetId} session=${sessionID}`);
    return reservation;
  }
  const minutes = reservation.keepaliveMinutes ?? reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
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
    lifeMs = minutes * 60 * 1e3;
  }
  const entry = {
    reservation,
    expiresAt: Date.now() + lifeMs
  };
  state2.reservations.set(resKey, entry);
  deps.armKeepalive(resKey, targetId, sessionID, client, timerGeneration, true, lifeMs);
  return reservation;
}
function computeRemainingMs(reservation) {
  if (!reservation) return null;
  if (reservation.expiresAt) {
    const expiry2 = Date.parse(reservation.expiresAt);
    if (Number.isFinite(expiry2)) {
      const remaining2 = expiry2 - Date.now();
      return remaining2 > 0 ? remaining2 : null;
    }
  }
  if (!reservation.createdAt) return null;
  const durationMin = reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const expiry = new Date(reservation.createdAt).getTime() + durationMin * 60 * 1e3;
  const remaining = expiry - Date.now();
  return remaining > 0 ? remaining : null;
}
function isOwnReservation(res, state2) {
  if (!state2.username) return true;
  if (state2.isAdmin) return true;
  return res.username === state2.username;
}
async function adoptExistingReservation(client, state2, targetId, status, sessionID, generation, deps) {
  await resolveUsername(client, state2, deps.log);
  const active = [
    ...status.activeReservations ?? [],
    ...status.reservations ?? []
  ];
  for (const res of active) {
    const targets = res.targets ?? [];
    for (const t of targets) {
      if ((t.id ?? t) === targetId && res.status === "active") {
        if (!isOwnReservation(res, state2)) {
          deps.log(`adopt skipped (foreign): targetId=${targetId} reservationId=${res.reservationId} owner=${res.username ?? "unknown"}`);
          return null;
        }
        if (generation === void 0 || isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
          const remainingMs = computeRemainingMs(res);
          if (remainingMs === null) {
            deps.log(`adopt (full-duration fallback): targetId=${targetId} reservationId=${res.reservationId}`);
            saveReservation(client, state2, targetId, res, sessionID, generation, deps);
          } else {
            deps.log(`adopt (remaining=${Math.round(remainingMs / 6e4)}min): targetId=${targetId} reservationId=${res.reservationId}`);
            saveReservation(client, state2, targetId, res, sessionID, generation, deps, { remainingMs });
          }
          return res;
        }
        return null;
      }
    }
  }
  return null;
}
function ensureReservation(client, state2, modelId, sessionID, deps) {
  const inflightKey = `${sessionID}::${modelId}`;
  const existing = state2.inflight.get(inflightKey);
  if (existing) {
    return existing;
  }
  const generation = currentSessionGeneration(state2, sessionID);
  const promise = resolveTargetForModel(client, state2, modelId, sessionID, generation, deps).then(async ({ targetId, match }) => {
    if (!isSessionGenerationCurrent(state2, sessionID, generation, deps.log)) {
      deps.log(`ensureReservation skipped (session stale): model=${modelId} session=${sessionID}`);
      return void 0;
    }
    const targetInflightKey = `${sessionID}::${targetId}`;
    const targetInflight = state2.inflightTarget.get(targetInflightKey);
    if (targetInflight) return targetInflight;
    const p = reserveOrRefreshTarget(client, state2, targetId, match, sessionID, generation, deps).finally(() => {
      state2.inflightTarget.delete(targetInflightKey);
    });
    state2.inflightTarget.set(targetInflightKey, p);
    return p;
  }).finally(() => {
    state2.inflight.delete(inflightKey);
  });
  state2.inflight.set(inflightKey, promise);
  return promise;
}

// ../shared/neuron-core/policy.js
function markActivity(state2, sessionID) {
  if (!sessionID) return;
  state2.sessionActivity.set(sessionID, Date.now());
}
function isSessionActive(state2, sessionID, client) {
  const last = state2.sessionActivity.get(sessionID);
  if (!last) return false;
  const graceMs = (client?.config?.keepaliveMinutes ?? DEFAULT_DURATION_MINUTES) * 60 * 1e3;
  return Date.now() - last <= graceMs;
}
function effectiveKeepaliveMinutes(reservation) {
  return reservation.keepaliveMinutes ?? reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
}
function keepaliveIntervalMs(minutes) {
  return Math.max(minutes * 60 * 1e3 / 2, 3e4);
}
function formatWarmupTimeoutMs(ms) {
  const min = Math.ceil(ms / 6e4);
  return `${min}m`;
}
function formatClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const hour12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${hour12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() >= 12 ? "PM" : "AM"}`;
}

// src/opencode-adapter.js
var NEURON_LOG_FILE = process.env.NEURON_LOG_FILE || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\neuron-plugin.log` : `${process.env.HOME || "."}/neuron-plugin.log`);
var NEURON_LOG_MAX_BYTES = (() => {
  const v = Number(process.env.NEURON_LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
})();
var _logSize = 0;
var _rotating = false;
function log(msg) {
  const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`;
  _logSize += Buffer.byteLength(line, "utf8");
  if (_logSize > NEURON_LOG_MAX_BYTES && !_rotating) {
    _rotating = true;
    fs.rename(NEURON_LOG_FILE, `${NEURON_LOG_FILE}.1`).catch(() => {
    }).finally(() => {
      _logSize = 0;
      _rotating = false;
    });
  }
  fs.appendFile(NEURON_LOG_FILE, line).catch(() => {
  });
}
var state = {
  reservations: /* @__PURE__ */ new Map(),
  inflight: /* @__PURE__ */ new Map(),
  inflightTarget: /* @__PURE__ */ new Map(),
  retryState: /* @__PURE__ */ new Map(),
  keepaliveTimers: /* @__PURE__ */ new Map(),
  sessionActivity: /* @__PURE__ */ new Map(),
  // sessionID → last real agent-work timestamp (ms)
  sessionGenerations: /* @__PURE__ */ new Map(),
  // sessionID → int, bumped on session.deleted
  statusCache: { value: null, at: 0, inflight: null }
  // shared status cache (core status reads)
};
var transportFailures = /* @__PURE__ */ new Map();
var warmupLocks = /* @__PURE__ */ new Map();
var lastFailure = /* @__PURE__ */ new Map();
var lastSwitchToastAt = /* @__PURE__ */ new Map();
var lastExtendAt = /* @__PURE__ */ new Map();
var lastDoneAt = /* @__PURE__ */ new Map();
var extendInFlight = /* @__PURE__ */ new Set();
var doneInFlight = /* @__PURE__ */ new Set();
var COMMAND_DEBOUNCE_MS = 2e3;
var FAILURE_CONTEXT_WINDOW_MS = 12e4;
var MODEL_SWITCH_TOAST_COOLDOWN_MS = 6e4;
var FAILURE_MESSAGE_MAX_CHARS = 120;
var coreDeps = {
  log,
  armKeepalive: (resKey, targetId, sessionID, client, generation, restart, remainingMs) => armKeepaliveTimer(resKey, targetId, sessionID, client, generation, restart, remainingMs)
};
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
async function acquireWarmupAndEnsure(client, modelId, sessionID, lockTargetId) {
  const generation = currentSessionGeneration(state, sessionID);
  await acquireWarmupLock(
    lockTargetId,
    () => ensureReservation(client, state, modelId, sessionID, coreDeps)
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
function armKeepaliveTimer(resKey, targetId, sessionID, client, generation, restart, remainingMs) {
  if (restart) {
    stopKeepaliveTimer(resKey);
  } else if (state.keepaliveTimers.has(resKey)) {
    return;
  }
  const current = state.reservations.get(resKey);
  if (!current || !client || !client.config) return;
  const lifeMinutes = remainingMs != null ? remainingMs / 6e4 : effectiveKeepaliveMinutes(current.reservation);
  const refreshMs = keepaliveIntervalMs(lifeMinutes);
  const timer = setInterval(() => {
    const tickEntry = state.reservations.get(resKey);
    if (!tickEntry) {
      stopKeepaliveTimer(resKey);
      return;
    }
    if (!isSessionActive(state, sessionID, client)) {
      log(`keepalive stopped (inactive): targetId=${targetId} session=${sessionID}`);
      stopKeepaliveTimer(resKey);
      return;
    }
    client.refreshReservation(tickEntry.reservation.reservationId).then((refreshed) => {
      if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
        log(`keepalive refresh ignored (session stale): targetId=${targetId} session=${sessionID}`);
        return;
      }
      const tickEntryNow = state.reservations.get(resKey);
      if (!tickEntryNow) return;
      const mins = effectiveKeepaliveMinutes(refreshed);
      tickEntryNow.reservation = refreshed;
      tickEntryNow.expiresAt = Date.now() + mins * 60 * 1e3;
      log(`keepalive refresh: targetId=${targetId} session=${sessionID} reservationId=${refreshed.reservationId}`);
    }).catch((e) => {
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
function extractSessionID(event) {
  return event?.sessionID ?? event?.sessionId ?? event?.properties?.sessionID ?? event?.properties?.sessionId ?? void 0;
}
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
  return void 0;
}
function scrubSession(sessionID, sessionModels) {
  if (!sessionID) return;
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
  sessionModels?.delete(sessionID);
  state.sessionActivity.delete(sessionID);
  transportFailures.delete(sessionID);
  lastFailure.delete(sessionID);
  lastSwitchToastAt.delete(sessionID);
}
function backgroundReserve(client, modelId, sessionID, sessionModels, ctx) {
  log(`background reserve start: model=${modelId} session=${sessionID}`);
  const generation = currentSessionGeneration(state, sessionID);
  (async () => {
    if (!isSessionGenerationCurrent(state, sessionID, generation, log)) {
      log(`background reserve skipped (session stale): model=${modelId} session=${sessionID}`);
      return;
    }
    try {
      await ensureReservation(client, state, modelId, sessionID, coreDeps);
      log(`background reserve success: model=${modelId} session=${sessionID}`);
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
          return;
        }
        if (!info.errorNotified) {
          info.errorNotified = true;
          let msg = `NeurOn: reservation failed`;
          if (e.status === 401 || e.status === 403) msg += " (authentication error)";
          else if (e.status === 429) msg += " (rate limited \u2014 wait and retry)";
          else if (e.status >= 500) msg += " (server error)";
          else msg += ` (HTTP ${e.status})`;
          ctx.client.tui.showToast({
            body: { message: msg, variant: "error" }
          });
        }
        return;
      }
      if (!info.warmupNotified) {
        info.warmupNotified = true;
        ctx.client.tui.showToast({
          body: {
            message: `NeurOn: warming up\u2026 please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`,
            variant: "warning"
          }
        });
      }
    }
  })();
}
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
      msg = `${msg.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}\u2026`;
    text += `: ${msg}`;
  }
  return text;
}
function notifyModelSwitch(client, allowedProviders, sessionID, ctx, oldFullModel, newFullModel, oldProvider, newProvider) {
  const oldManaged = matchesAllowedProvider(oldProvider, oldFullModel, allowedProviders, log);
  const newManaged = matchesAllowedProvider(newProvider, newFullModel, allowedProviders, log);
  const failure = lastFailure.get(sessionID);
  const recent = failure && Date.now() - failure.at <= FAILURE_CONTEXT_WINDOW_MS;
  log(`model switch: session=${sessionID} from=${oldFullModel} to=${newFullModel} oldManaged=${oldManaged} newManaged=${newManaged} recentFailure=${recent ? describeFailure(failure) : "none"}`);
  if (!oldManaged && !newManaged) return;
  const lastToastAt = lastSwitchToastAt.get(sessionID) ?? 0;
  if (Date.now() - lastToastAt <= MODEL_SWITCH_TOAST_COOLDOWN_MS) return;
  lastSwitchToastAt.set(sessionID, Date.now());
  let message;
  if (recent) {
    message = `NeurOn: model switched ${oldFullModel} \u2192 ${newFullModel} \u2014 last failure: ${describeFailure(failure)}`;
    if (oldManaged) {
      const targetState = getTargetStateNow(state.statusCache, client, oldFullModel);
      if (targetState !== "unknown") message += ` (target was ${targetState})`;
    }
  } else {
    message = `NeurOn: model switched ${oldFullModel} \u2192 ${newFullModel} (no recorded failure)`;
  }
  if (ctx.client?.tui?.showToast) {
    ctx.client.tui.showToast({ body: { message, variant: "warning" } });
  }
}
function setCommandParts(output, text) {
  if (!output || !Array.isArray(output.parts)) return;
  output.parts.length = 0;
  output.parts.push({ type: "text", text });
}
function notificationPart(msg) {
  return `NeurOn notification (automated \u2014 no action needed, reply with a one-line acknowledgement only): ${msg}`;
}
async function handleNeuronExtend(client, allowedProviders, sessionModels, sessionID, rawArguments, output) {
  if (!client?.config?.apiKey) {
    setCommandParts(output, notificationPart("NeurOn: plugin not configured"));
    return;
  }
  const arg = (rawArguments ?? "").trim();
  const minutes = arg === "" ? client.config.durationMinutes : Number(arg);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720 || arg !== "" && !Number.isInteger(minutes)) {
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
  const generation = currentSessionGeneration(state, sessionID);
  let targetId;
  try {
    const resolved = await resolveTargetForModel(client, state, fullModel, sessionID, generation, coreDeps);
    targetId = resolved.targetId;
  } catch (e) {
    const mappingFailure = e instanceof Error && /^NeurOn /.test(e.message ?? "");
    if (!mappingFailure) {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
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
  const status = await getLiveStatus(state.statusCache, client);
  if (!status) {
    setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=unreachable`);
    return;
  }
  const res = await adoptExistingReservation(client, state, targetId, status, sessionID, generation, coreDeps);
  if (!res?.reservationId) {
    setCommandParts(output, notificationPart("NeurOn: no active reservation \u2014 send a message to start one"));
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=no_active_reservation`);
    return;
  }
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
    saveReservation(client, state, targetId, refreshed, sessionID, generation, coreDeps);
    setCommandParts(
      output,
      notificationPart(`NeurOn: reservation ${refreshed?.reservationId ?? res.reservationId} extended to ${formatClock(refreshed?.expiresAt)} (+${minutes} min)`)
    );
    log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=ok`);
  } catch (e) {
    if (e instanceof NeurOnApiError && (e.status === 400 || e.status === 404)) {
      setCommandParts(output, notificationPart(`NeurOn: extend rejected \u2014 ${e.body || e.message}`));
      log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=rejected_${e.status}`);
    } else {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
      log(`command extend: session=${sessionID} minutes=${minutes} fromNow=false result=unreachable`);
    }
  } finally {
    extendInFlight.delete(sessionID);
  }
}
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
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
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
    setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
    log(`command done: session=${sessionID} result=unreachable`);
    return;
  }
  const res = await adoptExistingReservation(client, state, targetId, status, sessionID, generation, coreDeps);
  if (!res?.reservationId) {
    setCommandParts(output, notificationPart("NeurOn: no active reservation to end"));
    log(`command done: session=${sessionID} result=no_active_reservation`);
    return;
  }
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
      setCommandParts(output, notificationPart(`NeurOn: end rejected \u2014 ${e.body || e.message}`));
      log(`command done: session=${sessionID} reservationId=${res.reservationId} result=rejected_${e.status}`);
    } else {
      setCommandParts(output, notificationPart("NeurOn: control plane unreachable \u2014 try again"));
      log(`command done: session=${sessionID} reservationId=${res.reservationId} result=unreachable`);
    }
  } finally {
    doneInFlight.delete(sessionID);
  }
}
var NeurOnPlugin = async function NeurOnPlugin2(ctx) {
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
        body: { message: `NeurOn: plugin failed to init \u2014 ${e?.message ?? e}. Check env vars (NEURON_API_BASE_URL, NEURON_API_KEY).`, variant: "error" }
      });
    }
    return {
      event: () => {
      },
      "tool.execute.before": () => {
      },
      // Config failed to load — /neuron-extend and /neuron-done cannot work;
      // report it instead of letting the command template reach the LLM.
      "command.execute.before": async (input, output) => {
        if (input?.command === "neuron-extend" || input?.command === "neuron-done") {
          setCommandParts(output, notificationPart("NeurOn: plugin not configured"));
        }
      },
      dispose: async () => {
      }
    };
  }
  const sessionModels = /* @__PURE__ */ new Map();
  const instanceKey = /* @__PURE__ */ Symbol.for("neuron.opencode.active-instance");
  const instanceId = Math.random().toString(36).slice(2, 10);
  const previousInstance = globalThis[instanceKey];
  if (previousInstance?.dispose) {
    try {
      await previousInstance.dispose();
    } catch {
    }
  }
  const hooks = {
    event: async ({ event }) => {
      const type = event.type;
      const props = event?.properties || {};
      const sessionID = extractSessionID(event);
      if (!sessionID) return;
      if (type === "plugin.added") return;
      if (type === "session.error" && props?.error?.name) {
        recordSessionFailure(sessionID, {
          name: props.error.name,
          message: props.error.data?.message,
          status: props.error.data?.statusCode,
          source: "session.error"
        });
      }
      if (type === "message.updated" || type === "message.part.updated" || type === "message.part.delta") {
        markActivity(state, sessionID);
        if (type === "message.part.delta") return;
      }
      if (type === "session.status" && props?.status?.type === "busy") {
        markActivity(state, sessionID);
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
      if (type === "session.status" && props?.status?.type === "retry") {
        recordSessionFailure(sessionID, {
          name: props.status.attempt ? `Retry ${props.status.attempt}` : "Retry",
          message: props.status.message,
          source: "session.status"
        });
        return;
      }
      if (type === "session.deleted") {
        scrubSession(sessionID, sessionModels);
        return;
      }
      if (type === "session.created" && props.info?.model) {
        const m = props.info.model;
        const normalized = canonicalizeModel(m.providerID, m.id);
        const prevModel = sessionModels.get(sessionID);
        if (prevModel && (prevModel.id !== normalized.bareModelId || prevModel.provider !== normalized.provider)) {
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
              const currentModel = sessionModels.get(sessionID);
              const sameTarget = currentModel && (currentModel.id === oldFullModel || currentModel.provider === prevModel.provider) && oldTarget.resKey !== void 0;
              if (sameTarget && currentModel && (currentModel.id !== prevModel.id || currentModel.provider !== prevModel.provider)) {
                log(`session.created old-model cleanup skipped (same target as new model): session=${sessionID} target=${oldTarget.resKey}`);
                return;
              }
              stopKeepaliveTimer(oldTarget.resKey);
              state.reservations.delete(oldTarget.resKey);
            } catch (e) {
            }
          })();
        }
        sessionModels.set(sessionID, {
          id: normalized.bareModelId,
          provider: normalized.provider
        });
        log(`session.created: session=${sessionID} model=${normalized.bareModelId} provider=${normalized.provider ?? "none"}`);
        return;
      }
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
      if (provider) {
        const p = provider.toLowerCase();
        if (p === "neuron" || p === "neuron-bridge" || p === "opencode-neuron") return;
      }
      if (eventModel?.id) {
        const normalizedEvent = canonicalizeModel(eventModel.providerID, eventModel.id);
        if (normalizedEvent.bareModelId !== cachedModel?.id || normalizedEvent.provider !== cachedModel?.provider) {
          if (cachedModel) {
            const oldFullModel2 = cachedModel.provider ? `${cachedModel.provider}/${cachedModel.id}` : cachedModel.id;
            notifyModelSwitch(
              client,
              allowedProviders,
              sessionID,
              ctx,
              oldFullModel2,
              normalizedEvent.fullModel,
              cachedModel.provider,
              normalizedEvent.provider
            );
          }
          const generation = currentSessionGeneration(state, sessionID);
          const oldFullModel = cachedModel?.provider ? `${cachedModel.provider}/${cachedModel.id}` : cachedModel?.id;
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
              } catch (e) {
              }
            })();
          }
          sessionModels.set(sessionID, {
            id: normalizedEvent.bareModelId,
            provider: normalizedEvent.provider
          });
        }
      }
      const role = event.role ?? event.properties?.info?.role ?? event.properties?.role;
      if (type === "message.updated" && role === "user") {
        if (client.config.bypassMessageHook) return;
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);
        if (targetState === "healthy") {
          const info2 = sessionModels.get(sessionID);
          if (info2) info2.stoppingNotified = false;
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
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`message.updated keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) {
            }
          })();
          return;
        }
        if (targetState === "unreachable") return;
        if (!shouldBlockForWarmup(targetState)) return;
        const info = sessionModels.get(sessionID);
        if (targetState === "stopping") {
          try {
            const result = await resolveTargetForModel(client, state, fullModel, sessionID);
            stopKeepaliveTimer(result.resKey);
            state.reservations.delete(result.resKey);
          } catch (e) {
          }
          if (info && !info.stoppingNotified) {
            info.stoppingNotified = true;
            if (ctx.client?.tui?.showToast) {
              ctx.client.tui.showToast({
                body: { message: `NeurOn: target stopping, restarting\u2026 please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`, variant: "warning" }
              });
            }
          }
        } else if (info && !info.warmupNotified) {
          info.warmupNotified = true;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: { message: `NeurOn: warming up\u2026 please wait, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`, variant: "warning" }
            });
          }
        }
        if (client.config.blockOnColdMessage) {
          backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
          throw new Error(`NeurOn: target is ${targetState}, warming up \u2014 please retry once warmup completes, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`);
        }
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
          }
        }
        backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
        return;
      }
      if (type === "session.error") {
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;
      }
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
        const sessionID = input.sessionID;
        if (!sessionID) return;
        markActivity(state, sessionID);
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
        const lastFailureTs = transportFailures.get(sessionID) ?? 0;
        if (Date.now() - lastFailureTs < client.config.cooldownPeriodMs) {
          log(`tool.execute.before fail-open: session=${sessionID} model=${fullModel} reason=transport_cooldown`);
          return;
        }
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);
        if (targetState === "healthy") {
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
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`tool.execute.before keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) {
            }
          })();
          return;
        }
        if (targetState === "unreachable") {
          transportFailures.set(sessionID, Date.now());
          log(`tool.execute.before fail-open: session=${sessionID} model=${fullModel} reason=unreachable`);
          return;
        }
        if (!shouldBlockForWarmup(targetState)) return;
        {
          log(`tool.execute.before cold target: session=${sessionID} model=${fullModel} targetState=${targetState}`);
          return;
        }
      } catch (e) {
        if (e.message?.includes("NeurOn:")) throw e;
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
        const sessionID = input?.sessionID ?? input?.sessionId ?? input?.properties?.sessionID;
        if (!sessionID) return;
        if (client.config.bypassMessageHook) return;
        markActivity(state, sessionID);
        let cached = sessionModels.get(sessionID);
        const inputModel = extractModelIdentity(input);
        if (!cached && inputModel) {
          const normalized = inputModel;
          cached = { id: normalized.bareModelId, provider: normalized.provider };
          sessionModels.set(sessionID, cached);
        }
        if (!cached) return;
        const model = cached.id;
        const provider = cached.provider;
        const fullModel = provider ? `${provider}/${model}` : model;
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders, log)) return;
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
        if (!lockTargetId) return;
        const targetState = await getTargetStateLive(state.statusCache, client, fullModel);
        if (targetState === "healthy") {
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
                markActivity(state, sessionID);
                armKeepaliveTimer(result.resKey, result.targetId, sessionID, client, generation, false);
                log(`chat.message keepalive-only: session=${sessionID} model=${fullModel} targetId=${result.targetId}`);
              }
            } catch (e) {
            }
          })();
          return;
        }
        if (targetState === "unreachable") return;
        if (!shouldBlockForWarmup(targetState)) return;
        const info = sessionModels.get(sessionID);
        if (info && !info.warmupNotified) {
          info.warmupNotified = true;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: {
                message: `NeurOn: warming up\u2026 please wait, up to ${formatWarmupTimeoutMs(client.config.waitTimeoutMs)}`,
                variant: "warning"
              }
            });
          }
        }
        let heartbeatDone = false;
        const heartbeat = setInterval(() => {
          if (heartbeatDone) return;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: {
                message: `NeurOn: still warming up\u2026`,
                variant: "warning"
              }
            });
          }
        }, 3e4);
        try {
          await acquireWarmupAndEnsure(client, fullModel, sessionID, lockTargetId);
          log(`chat.message warmup complete: targetId=${lockTargetId} session=${sessionID}`);
        } catch (e) {
          log(`chat.message warmup failed: targetId=${lockTargetId} session=${sessionID} error=${e?.message ?? e}`);
        } finally {
          clearInterval(heartbeat);
          heartbeatDone = true;
        }
      } catch (e) {
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
          setCommandParts(output, notificationPart(`NeurOn: extend failed \u2014 ${e?.message ?? e}`));
        } else if (input?.command === "neuron-done") {
          setCommandParts(output, notificationPart(`NeurOn: done failed \u2014 ${e?.message ?? e}`));
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
export {
  NeurOnPlugin
};
