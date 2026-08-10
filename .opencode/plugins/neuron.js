// NeurOn plugin - auto-loads from ~/.config/opencode/plugins/
// Manages reservation lifecycle: cold-start detection → reservation → warmup wait → healthy
// Config via env: NEURON_API_BASE_URL, NEURON_API_KEY, NEURON_ALLOWED_PROVIDERS (default: litellm)

const DEFAULT_POLL_S = 5;
const DEFAULT_DURATION_MINUTES = 2;
const DEFAULT_WAIT_TIMEOUT_S = 600;

const state = {
  reservations: new Map(),
  inflight: new Map()
};

class NeurOnClient {
  constructor(config) {
    this.config = config;
  }

  async getStatus() {
    const [status, models] = await Promise.all([
      this.request("/api/status"),
      this.request("/api/models")
    ]);
    return { ...status, models: models.models ?? [] };
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

  async waitForHealthy(reservationId) {
    const deadline = Date.now() + this.config.waitTimeoutMs;
    let lastReservation;
    while (Date.now() <= deadline) {
      lastReservation = await this.request(
        `/api/reservations/${encodeURIComponent(reservationId)}/status`
      );
      if (lastReservation.targets?.every((t) => t.observed === "healthy"))
        return lastReservation;
      const failed = lastReservation.targets?.find((t) => t.observed === "failed");
      if (failed)
        throw new Error(`NeurOn target ${failed.id} failed: ${failed.message}`);
      await sleep(this.config.pollMs);
    }
    const states = (lastReservation?.targets ?? [])
      .map((t) => `${t.id}:${t.observed}`)
      .join(", ");
    throw new Error(
      `Timed out waiting for NeurOn reservation ${reservationId} to become healthy${states ? ` (${states})` : ""}`
    );
  }

  async request(path, options = {}) {
    if (!this.config.apiKey)
      throw new Error("NEURON_API_KEY is required for the NeurOn OpenCode plugin");
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
        ...(options.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new NeurOnApiError(response.status, path, body, response.statusText);
    }
    return response.json();
  }
}

class NeurOnApiError extends Error {
  constructor(status, path, body, statusText) {
    super(`NeurOn API ${status} for ${path}: ${body || statusText}`);
    this.status = status;
  }
}

// ── Config ────────────────────────────────────────────────

function loadConfig() {
  const raw = process.env.NEURON_ALLOWED_PROVIDERS;
  // Empty string or unset = allow all providers; otherwise use the list
  const allowedProviders =
    raw === "" || raw == null
      ? []
      : raw.split(",").map((p) => p.trim()).filter(Boolean);
  return {
    apiBaseUrl: trimSlash(process.env.NEURON_API_BASE_URL ?? "http://localhost:8090"),
    apiKey: process.env.NEURON_API_KEY,
    durationMinutes: positiveNumber(
      process.env.NEURON_RESERVATION_DURATION_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    keepaliveMinutes: positiveNumber(
      process.env.NEURON_RESERVATION_KEEPALIVE_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    waitForHealthy: boolEnv(process.env.NEURON_WAIT_FOR_HEALTHY, true),
    waitTimeoutMs: positiveNumber(process.env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_S) * 1000,
    pollMs: positiveNumber(process.env.NEURON_WAIT_POLL_SECONDS, DEFAULT_POLL_S) * 1000,
    allowedProviders
  };
}

// ── Model / provider helpers ──────────────────────────────

function splitProvider(modelId) {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    return { provider: modelId.slice(0, slash), bareModelId: modelId.slice(slash + 1) };
  }
  return { provider: undefined, bareModelId: modelId };
}

function matchesAllowedProvider(providerId, modelId, allowedProviders) {
  // If no providers are restricted, allow all
  if (allowedProviders.length === 0) return true;
  if (providerId) {
    for (const p of allowedProviders)
      if (providerId.toLowerCase() === p.toLowerCase()) return true;
    return false;
  }
  for (const p of allowedProviders)
    if (modelId.startsWith(p + "/")) return true;
  return false;
}

// ── Model → target matching ───────────────────────────────

function matchLiteLlmModel(targets, models, bareModelId) {
  const modelByLookup = buildModelLookup(models);

  // Try bare model ID first (e.g. "qwen-3.6-27b") against model lookup
  const model = modelByLookup.get(bareModelId);
  if (model && model.targetIds?.length) {
    for (const target of targets) {
      if (model.targetIds.includes(target.id))
        return { modelIds: [model.id], targetIds: [target.id] };
    }
  }

  // Fallback: match bareModelId directly against any target's modelIds
  for (const target of targets) {
    if (target.modelIds?.includes(bareModelId))
      return { modelIds: [bareModelId], targetIds: [target.id] };
  }

  return undefined;
}

function buildModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const id of [
      model.id,
      ...(model.aliases ?? []),
      ...(model.backendModelIds ?? []),
      ...(model.runtimeModelIds ?? [])
    ])
      lookup.set(id, model);
  }
  return lookup;
}

function findTargetStatus(targets, targetId) {
  for (const t of targets)
    if (t.id === targetId) return t;
  return undefined;
}

// ── Reservation flow (keyed by target ID) ──────────────────

function ensureReservation(client, modelId) {
  // Resolve model → target first to deduplicate across models sharing a target
  return resolveTargetForModel(client, modelId).then(async ({ targetId, match }) => {
    const existing = state.inflight.get(targetId);
    if (existing) {
      return existing;
    }
    const promise = reserveOrRefreshTarget(client, targetId, match).finally(() =>
      state.inflight.delete(targetId)
    );
    state.inflight.set(targetId, promise);
    return promise;
  });
}

async function resolveTargetForModel(client, modelId) {
  const status = await client.getStatus();
  const { bareModelId } = splitProvider(modelId);
  const match = matchLiteLlmModel(
    status.capacityTargets ?? [],
    status.models ?? [],
    bareModelId
  );
  if (!match)
    throw new Error(
      `NeurOn could not map OpenCode model "${modelId}" to a capacity target`
    );
  const targetId = match.targetIds[0];
  const targetInfo = findTargetStatus(status.capacityTargets ?? [], targetId);
  return { targetId, match, targetHealthy: targetInfo?.observed === "healthy" };
}

async function reserveOrRefreshTarget(client, targetId, match) {
  // Check if we already have a reservation for this target
  const existing = state.reservations.get(targetId);
  if (existing) {
    try {
      const refreshed = await client.refreshReservation(existing.reservationId);
      return saveReservation(targetId, refreshed);
    } catch (error) {
      if (!isRecoverableReservationError(error)) throw error;
      state.reservations.delete(targetId);
    }
  }
  const reservation = await client.createReservation(match);
  return saveReservation(targetId, reservation);
}

function saveReservation(targetId, reservation) {
  state.reservations.set(targetId, reservation);
  return reservation;
}

async function refreshExistingReservation(client, modelId) {
  try {
    const { targetId } = await resolveTargetForModel(client, modelId);
    const existing = state.reservations.get(targetId);
    if (!existing) return undefined;
    const refreshed = await client.refreshReservation(existing.reservationId);
    state.reservations.set(targetId, refreshed);
    return refreshed;
  } catch (e) {
    return undefined;
  }
}

function isRecoverableReservationError(error) {
  return error instanceof NeurOnApiError && [400, 404].includes(error.status);
}

// ── Utilities ─────────────────────────────────────────────

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Background reservation (non-blocking) ─────────────────

async function checkTargetHealthy(client, modelId) {
  try {
    const status = await client.getStatus();
    const { bareModelId } = splitProvider(modelId);
    const match = matchLiteLlmModel(
      status.capacityTargets ?? [],
      status.models ?? [],
      bareModelId
    );
    if (!match) return "cold";
    const targetInfo = findTargetStatus(
      status.capacityTargets ?? [],
      match.targetIds[0]
    );
    return targetInfo?.observed ?? "cold";
  } catch (e) {
    return "cold";
  }
}

function backgroundReserve(client, modelId, sessionID, sessionModels, ctx) {
  // Fire-and-forget reservation in background so it doesn't block the session
  (async () => {
    try {
      await ensureReservation(client, modelId);
    } catch (e) {
      // Notify user only once per session
      const info = sessionModels.get(sessionID);
      if (info && !info.warmupNotified) {
        info.warmupNotified = true;
        if (ctx.client?.tui?.showToast) {
          ctx.client.tui.showToast({
            body: {
              message: `NeurOn: target cold, warming up… please retry in 2-3 min`,
              variant: "warning"
            }
          });
        }
      }
    }
  })();
}

// ── OpenCode plugin entry ─────────────────────────────────

export const NeurOnPlugin = async function NeurOnPlugin(ctx) {
  let client;
  let allowedProviders;
  try {
    client = new NeurOnClient(loadConfig());
    allowedProviders = client.config.allowedProviders;
  } catch (e) {
    return { event: () => {}, "tool.execute.before": () => {} };
  }

  // Track session -> model mapping from session.created events
  const sessionModels = new Map();

  return {
    event: async ({ event }) => {
      const type = event.type;
      const props = event?.properties || {};
      const sessionID = props.sessionID;

      if (type === "plugin.added" || type === "message.part.delta") return;

      // CAPTURE model from session.created
      if (type === "session.created" && props.info?.model) {
        const m = props.info.model;
        sessionModels.set(sessionID, {
          id: m.id,
          provider: m.providerID
        });
        return;
      }

      // Prefer model from current event (handles model switching within same session)
      const eventModel = props?.info?.model;
      const cachedModel = sessionModels.get(sessionID);
      const model = eventModel?.id ?? cachedModel?.id ?? event?.model;
      if (!model) return;

      const provider = eventModel?.providerID ?? cachedModel?.provider;
      const fullModel = provider
        ? `${provider}/${model}`
        : model;

      // Update cache if model changed mid-session (only when we have a real new model)
      if (eventModel?.id && eventModel.id !== cachedModel?.id) {
        sessionModels.set(sessionID, { id: eventModel.id, provider: eventModel.providerID });
      }

      const role =
        event.role ?? event.properties?.info?.role ?? event.properties?.role;

      // Pre-request: check target health on user message
      if (type === "message.updated" && role === "user") {
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders)) return;

        const targetState = await checkTargetHealthy(client, fullModel);

        if (targetState === "healthy") {
          // Target already running — refresh or create reservation
          try {
            const result = await resolveTargetForModel(client, fullModel);
            if (!state.reservations.has(result.targetId)) {
              await ensureReservation(client, fullModel);
            } else {
              await refreshExistingReservation(client, fullModel);
            }
          } catch (e) {
            /* ignore */
          }
          return;
        }

        if (targetState === "stopping") {
          // Target is shutting down — clear stale reservation, notify user
          try {
            const { targetId } = await resolveTargetForModel(client, fullModel);
            state.reservations.delete(targetId);
          } catch (e) {
            /* ignore */
          }
          const info = sessionModels.get(sessionID);
          if (info && !info.stoppingNotified) {
            info.stoppingNotified = true;
            if (ctx.client?.tui?.showToast) {
              ctx.client.tui.showToast({
                body: { message: "NeurOn: target stopping, restarting… please retry in 2-3 min", variant: "warning" }
              });
            }
          }
          backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
          return;
        }

        // Target is cold/stopped — fire reservation background, don't block
        const info = sessionModels.get(sessionID);
        if (info && !info.warmupNotified) {
          info.warmupNotified = true;
          if (ctx.client?.tui?.showToast) {
            ctx.client.tui.showToast({
              body: { message: "NeurOn: warming up… please retry in 2-3 min", variant: "warning" }
            });
          }
        }
        backgroundReserve(client, fullModel, sessionID, sessionModels, ctx);
        return;
      }

      // Reactive fallback: fix on session error
      if (type === "session.error") {
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders)) return;
        try {
          await ensureReservation(client, fullModel);
        } catch (e) {
          /* ignore */
        }
      }

      // Refresh reservation on session idle (keepalive)
      if (type === "session.idle") {
        if (!matchesAllowedProvider(provider, fullModel, allowedProviders)) return;
        refreshExistingReservation(client, fullModel).catch(() => {});
      }
    },

    "tool.execute.before": async () => {}
  };
};

