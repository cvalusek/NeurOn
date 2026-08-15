const DEFAULT_API_BASE_URL = "http://localhost:8090";
const DEFAULT_DURATION_MINUTES = 2;
const DEFAULT_KEEPALIVE_MINUTES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;

const state = {
  reservations: new Map(),
  inflight: new Map(),
  sessionModels: new Map()
};

export async function NeurOnPlugin() {
  const client = new NeurOnClient(loadConfig());
  return createNeurOnHooks(client);
}

export default NeurOnPlugin;

export function createNeurOnHooks(client) {
  const allowedProviders = client.config.allowedProviders ?? [];

  return {
    "chat.message": async (input) => {
      const selection = modelSelection(input);
      if (!selection) return;
      if (!matchesAllowedProvider(selection.providerId, selection.modelId, allowedProviders)) return;

      if (input.sessionID) state.sessionModels.set(input.sessionID, selection);
      try {
        await ensureReservation(client, selection.modelId);
      } catch (error) {
        if (input.sessionID) state.sessionModels.delete(input.sessionID);
        throw error;
      }
    },

    event: async (input) => {
      if (!isCompletionEvent(input)) return;

      const event = input?.event ?? input;
      const sessionId = sessionIdFromEvent(event);
      const selection = modelSelection(event) ?? (sessionId ? state.sessionModels.get(sessionId) : undefined);
      if (!selection) return;
      if (!matchesAllowedProvider(selection.providerId, selection.modelId, allowedProviders)) return;

      try {
        await refreshExistingReservation(client, selection.modelId);
      } catch {
        // The model response is already complete. A failed keepalive must not
        // turn a successful OpenCode response into an integration error; the
        // next chat.message hook will repair or recreate the reservation.
      } finally {
        // OpenCode normally emits both a completed message and session.idle.
        // Forgetting the turn here prevents two keepalive extensions for one completion.
        if (sessionId) state.sessionModels.delete(sessionId);
      }
    }
  };
}

export async function ensureReservation(client, litellmModelId) {
  const resolved = await resolveTargetForModel(client, litellmModelId);
  const key = reservationKey(resolved.targetId, resolved.match.modelIds[0]);
  const inflight = state.inflight.get(key);
  if (inflight) return inflight;

  const promise = reserveOrRefreshModel(client, key, resolved.match)
    .finally(() => state.inflight.delete(key));
  state.inflight.set(key, promise);
  return promise;
}

export function resetNeurOnPluginState() {
  state.reservations.clear();
  state.inflight.clear();
  state.sessionModels.clear();
}

async function reserveOrRefreshModel(client, key, match) {
  const existing = state.reservations.get(key);
  if (existing) {
    try {
      const refreshed = await client.refreshReservation(existing.reservationId);
      return waitForReadyReservation(client, key, refreshed);
    } catch (error) {
      if (!isRecoverableReservationError(error)) throw error;
      state.reservations.delete(key);
    }
  }

  const reservation = await client.createReservation(match);
  return waitForReadyReservation(client, key, reservation);
}

async function waitForReadyReservation(client, key, reservation) {
  const ready = client.config.waitForHealthy
    ? await client.waitForHealthy(reservation.reservationId)
    : reservation;
  state.reservations.set(key, ready);
  return ready;
}

export async function refreshExistingReservation(client, litellmModelId) {
  const resolved = await resolveTargetForModel(client, litellmModelId);
  const key = reservationKey(resolved.targetId, resolved.match.modelIds[0]);
  const existing = state.reservations.get(key);
  if (!existing) return undefined;

  try {
    const refreshed = await client.refreshReservation(existing.reservationId);
    state.reservations.set(key, refreshed);
    return refreshed;
  } catch (error) {
    if (!isRecoverableReservationError(error)) throw error;
    state.reservations.delete(key);
    return undefined;
  }
}

async function resolveTargetForModel(client, litellmModelId) {
  const status = await client.getStatus();
  const match = matchLiteLlmModel(
    status.capacityTargets ?? [],
    status.models ?? [],
    litellmModelId
  );
  if (!match) {
    throw new Error(
      `NeurOn could not map OpenCode model "${litellmModelId}" to a capacity target`
    );
  }
  return { targetId: match.targetIds[0], match };
}

function reservationKey(targetId, modelId) {
  // A target can serve several models. Include the canonical model so a
  // reservation for one model cannot incorrectly stand in for another model's
  // warmup, while aliases for the same model still share one reservation.
  return `${targetId}\u0000${modelId}`;
}

export function matchLiteLlmModel(targets, models, litellmModelId) {
  const modelByLookup = buildModelLookup(models);
  const orderedTargets = [...targets].sort(
    (left, right) =>
      (left.aliasPriority ?? 100) - (right.aliasPriority ?? 100) ||
      String(left.id).localeCompare(String(right.id))
  );
  for (const target of orderedTargets) {
    for (const candidate of candidateModelIds(target, litellmModelId)) {
      const model = modelByLookup.get(candidate)?.find((entry) => entry.targetIds?.includes(target.id));
      if (model) {
        return { modelIds: [model.id], targetIds: [target.id] };
      }
      if (target.modelIds?.includes(candidate)) {
        return { modelIds: [candidate], targetIds: [target.id] };
      }
    }
  }
  return undefined;
}

export function candidateModelIds(target, litellmModelId) {
  const values = new Set([litellmModelId]);
  const routePrefixes = target.trafficModelPrefixes?.length
    ? target.trafficModelPrefixes
    : [`${target.id}/`];
  const displayPrefix = target.litellmDisplayPrefix ?? routePrefixes[0];
  if (litellmModelId.startsWith(displayPrefix)) {
    values.add(litellmModelId.slice(displayPrefix.length));
  }
  for (const prefix of routePrefixes) {
    if (litellmModelId.startsWith(prefix)) values.add(litellmModelId.slice(prefix.length));
    values.add(`${prefix}${litellmModelId}`);
  }
  return Array.from(values).filter(Boolean);
}

function buildModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const id of [
      model.id,
      ...(model.aliases ?? []),
      ...(model.backendModelIds ?? []),
      ...(model.runtimeModelIds ?? [])
    ]) {
      lookup.set(id, [...(lookup.get(id) ?? []), model]);
    }
  }
  return lookup;
}

export function matchesAllowedProvider(providerId, modelId, allowedProviders) {
  if (allowedProviders.length === 0) return true;
  if (providerId) {
    return allowedProviders.some(
      (allowed) => allowed.toLowerCase() === providerId.toLowerCase()
    );
  }
  return allowedProviders.some((allowed) => modelId.startsWith(`${allowed}/`));
}

function modelSelection(input) {
  const model =
    input?.model ??
    input?.message?.model ??
    input?.session?.model ??
    input?.properties?.model ??
    input?.properties?.info?.model;

  if (typeof model === "string") return { modelId: model, providerId: undefined };
  if (model) {
    const modelId = model.modelID ?? model.modelId ?? model.id;
    if (modelId) {
      return {
        modelId,
        providerId: model.providerID ?? model.providerId ?? model.provider
      };
    }
  }

  const info = input?.properties?.info;
  const modelId = info?.modelID ?? info?.modelId;
  if (!modelId) return undefined;
  return {
    modelId,
    providerId: info.providerID ?? info.providerId
  };
}

function sessionIdFromEvent(event) {
  return event?.properties?.sessionID ?? event?.properties?.info?.sessionID;
}

export function isCompletionEvent(input) {
  const event = input?.event ?? input;
  const type = event?.type ?? event?.name;
  const status =
    event?.status ??
    event?.properties?.status ??
    event?.properties?.message?.status;
  const message =
    event?.message ??
    event?.properties?.message ??
    event?.properties?.info;

  if (["chat.completion", "chat.completed", "message.completed", "session.idle"].includes(type)) {
    return true;
  }
  if (
    type === "message.updated" &&
    ["completed", "complete", "done", "idle"].includes(String(status ?? "").toLowerCase())
  ) {
    return true;
  }
  return Boolean(
    type === "message.updated" &&
      (message?.time?.completed || message?.completedAt || message?.completed)
  );
}

function loadConfig() {
  const durationMinutes = positiveNumber(
    process.env.NEURON_RESERVATION_DURATION_MINUTES,
    DEFAULT_DURATION_MINUTES
  );
  const keepaliveMinutes = positiveNumber(
    process.env.NEURON_RESERVATION_KEEPALIVE_MINUTES,
    DEFAULT_KEEPALIVE_MINUTES
  );
  const rawProviders = process.env.NEURON_ALLOWED_PROVIDERS;
  return {
    apiBaseUrl: trimSlash(process.env.NEURON_API_BASE_URL ?? DEFAULT_API_BASE_URL),
    apiKey: process.env.NEURON_API_KEY,
    durationMinutes,
    keepaliveMinutes,
    waitForHealthy: boolEnv(process.env.NEURON_WAIT_FOR_HEALTHY, true),
    waitTimeoutMs:
      positiveNumber(
        process.env.NEURON_WAIT_TIMEOUT_SECONDS,
        DEFAULT_WAIT_TIMEOUT_MS / 1000
      ) * 1000,
    pollMs:
      positiveNumber(process.env.NEURON_WAIT_POLL_SECONDS, DEFAULT_POLL_MS / 1000) * 1000,
    allowedProviders:
      rawProviders === undefined || rawProviders.trim() === ""
        ? []
        : rawProviders.split(",").map((provider) => provider.trim()).filter(Boolean)
  };
}

class NeurOnClient {
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
      if (lastReservation.targets?.every((target) => target.observed === "healthy")) {
        return lastReservation;
      }
      const failed = lastReservation.targets?.find((target) => target.observed === "failed");
      if (failed) {
        throw new Error(`NeurOn target ${failed.id} failed: ${failed.message}`);
      }
      await sleep(this.config.pollMs);
    }
    const states = (lastReservation?.targets ?? [])
      .map((target) => `${target.id}:${target.observed}`)
      .join(", ");
    throw new Error(
      `Timed out waiting for NeurOn reservation ${reservationId} to become healthy${states ? ` (${states})` : ""}`
    );
  }

  async request(path, options = {}) {
    if (!this.config.apiKey) {
      throw new Error("NEURON_API_KEY is required for the NeurOn OpenCode plugin");
    }
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

export function mergeClientModels(models, deployments) {
  return [
    ...models,
    ...deployments.map((deployment) => ({
      id: deployment.modelId,
      aliases: [
        ...(deployment.aliases?.global ?? []),
        ...(deployment.aliases?.scoped ?? [])
      ],
      targetIds: [deployment.targetId]
    }))
  ];
}

function isRecoverableReservationError(error) {
  return error instanceof NeurOnApiError && [400, 404].includes(error.status);
}

class NeurOnApiError extends Error {
  constructor(status, path, body, statusText) {
    super(`NeurOn API ${status} for ${path}: ${body || statusText}`);
    this.status = status;
  }
}

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
