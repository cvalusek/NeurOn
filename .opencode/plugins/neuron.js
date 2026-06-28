const DEFAULT_API_BASE_URL = "http://localhost:8090";
const DEFAULT_DURATION_MINUTES = 2;
const DEFAULT_KEEPALIVE_MINUTES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;

const state = {
  reservations: new Map(),
  inflight: new Map(),
  lastModelId: undefined
};

export default async function NeurOnPlugin() {
  const client = new NeurOnClient(loadConfig());
  return {
    "chat.message": async (input) => {
      const modelId = modelIdFromChat(input);
      if (!modelId) return;
      state.lastModelId = modelId;
      await ensureReservation(client, modelId);
    },
    event: async (input) => {
      if (!isCompletionEvent(input)) return;
      const modelId = modelIdFromChat(input) ?? state.lastModelId;
      if (!modelId) return;
      await refreshExistingReservation(client, modelId);
    }
  };
}

export async function ensureReservation(client, litellmModelId, now = Date.now()) {
  const key = litellmModelId;
  const inflight = state.inflight.get(key);
  if (inflight) return inflight;

  const promise = reserveOrRefreshModel(client, litellmModelId, now)
    .finally(() => state.inflight.delete(key));
  state.inflight.set(key, promise);
  return promise;
}

export function resetNeurOnPluginState() {
  state.reservations.clear();
  state.inflight.clear();
  state.lastModelId = undefined;
}

async function reserveOrRefreshModel(client, litellmModelId, _now) {
  const existing = state.reservations.get(litellmModelId);
  if (existing) {
    try {
      const refreshed = await client.refreshReservation(existing.reservationId);
      return waitForReadyReservation(client, litellmModelId, refreshed);
    } catch (error) {
      if (!isRecoverableReservationError(error)) throw error;
      state.reservations.delete(litellmModelId);
    }
  }

  const status = await client.getStatus();
  const match = matchLiteLlmModel(status.capacityTargets ?? [], status.models ?? [], litellmModelId);
  if (!match) throw new Error(`NeurOn could not map OpenCode model "${litellmModelId}" to a capacity target`);

  const reservation = await client.createReservation(match);
  return waitForReadyReservation(client, litellmModelId, reservation);
}

async function waitForReadyReservation(client, litellmModelId, reservation) {
  const ready = client.config.waitForHealthy ? await client.waitForHealthy(reservation.reservationId) : reservation;
  state.reservations.set(litellmModelId, ready);
  return ready;
}

export async function refreshExistingReservation(client, litellmModelId) {
  const existing = state.reservations.get(litellmModelId);
  if (!existing) return undefined;
  try {
    const refreshed = await client.refreshReservation(existing.reservationId);
    state.reservations.set(litellmModelId, refreshed);
    return refreshed;
  } catch (error) {
    if (!isRecoverableReservationError(error)) throw error;
    state.reservations.delete(litellmModelId);
    return undefined;
  }
}

export function matchLiteLlmModel(targets, models, litellmModelId) {
  const modelByLookup = buildModelLookup(models);
  for (const target of targets) {
    const candidates = candidateModelIds(target, litellmModelId);
    for (const candidate of candidates) {
      const model = modelByLookup.get(candidate);
      if (model?.targetIds?.includes(target.id)) {
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
  const displayPrefix = target.litellmDisplayPrefix;
  if (displayPrefix !== undefined && litellmModelId.startsWith(displayPrefix)) {
    values.add(litellmModelId.slice(displayPrefix.length));
  }
  for (const prefix of target.trafficModelPrefixes ?? []) {
    if (litellmModelId.startsWith(prefix)) values.add(litellmModelId.slice(prefix.length));
    values.add(`${prefix}${litellmModelId}`);
  }
  return Array.from(values).filter(Boolean);
}

function buildModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const id of [model.id, ...(model.aliases ?? []), ...(model.backendModelIds ?? []), ...(model.runtimeModelIds ?? [])]) {
      lookup.set(id, model);
    }
  }
  return lookup;
}

function modelIdFromChat(input) {
  const model = input?.model ?? input?.message?.model ?? input?.session?.model ?? input?.event?.properties?.model ?? input?.properties?.model;
  if (typeof model === "string") return model;
  return model?.modelID ?? model?.modelId ?? model?.id;
}

export function isCompletionEvent(input) {
  const event = input?.event ?? input;
  const type = event?.type ?? event?.name;
  const status = event?.status ?? event?.properties?.status ?? event?.properties?.message?.status;
  const message = event?.message ?? event?.properties?.message ?? event?.properties?.info;
  if (["chat.completion", "chat.completed", "message.completed", "session.idle"].includes(type)) return true;
  if (type === "message.updated" && ["completed", "complete", "done", "idle"].includes(String(status ?? "").toLowerCase())) return true;
  if (type === "message.updated" && (message?.time?.completed || message?.completedAt || message?.completed)) return true;
  return false;
}

function loadConfig() {
  const durationMinutes = positiveNumber(process.env.NEURON_RESERVATION_DURATION_MINUTES, DEFAULT_DURATION_MINUTES);
  const keepaliveMinutes = positiveNumber(process.env.NEURON_RESERVATION_KEEPALIVE_MINUTES, DEFAULT_KEEPALIVE_MINUTES);
  return {
    apiBaseUrl: trimSlash(process.env.NEURON_API_BASE_URL ?? DEFAULT_API_BASE_URL),
    apiKey: process.env.NEURON_API_KEY,
    durationMinutes,
    keepaliveMinutes,
    waitForHealthy: boolEnv(process.env.NEURON_WAIT_FOR_HEALTHY, true),
    waitTimeoutMs: positiveNumber(process.env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_MS / 1000) * 1000,
    pollMs: positiveNumber(process.env.NEURON_WAIT_POLL_SECONDS, DEFAULT_POLL_MS / 1000) * 1000
  };
}

class NeurOnClient {
  constructor(config) {
    this.config = config;
  }

  async getStatus() {
    const [status, models] = await Promise.all([this.request("/api/status"), this.request("/api/models")]);
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
      lastReservation = await this.request(`/api/reservations/${encodeURIComponent(reservationId)}/status`);
      if (lastReservation.targets?.every((target) => target.observed === "healthy")) return lastReservation;
      const failed = lastReservation.targets?.find((target) => target.observed === "failed");
      if (failed) throw new Error(`NeurOn target ${failed.id} failed: ${failed.message}`);
      await sleep(this.config.pollMs);
    }
    const states = (lastReservation?.targets ?? []).map((target) => `${target.id}:${target.observed}`).join(", ");
    throw new Error(`Timed out waiting for NeurOn reservation ${reservationId} to become healthy${states ? ` (${states})` : ""}`);
  }

  async request(path, options = {}) {
    if (!this.config.apiKey) throw new Error("NEURON_API_KEY is required for the NeurOn OpenCode plugin");
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
