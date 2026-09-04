// ── NeurOn control-plane client ───────────────────────────
// Harness-agnostic HTTP client for the NeurOn API (status, models,
// reservation create/extend/status, bounded healthy wait). User-facing
// error strings name the calling harness via config.harnessLabel (see
// harnessLabelOf; defaults to "OpenCode").

import { harnessLabelOf } from "./config.js";

export class NeurOnApiError extends Error {
  constructor(status, path, body, statusText) {
    super(`NeurOn API ${status} for ${path}: ${body || statusText}`);
    this.status = status;
    // The server's own error message (body, or statusText when the body is
    // empty) — surfaced verbatim by the /neuron-extend rejection line.
    this.body = body || statusText;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NeurOnClient {
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
  async waitForHealthy(reservationId, invalidateStatusCache) {
    const deadline = Date.now() + this.config.waitTimeoutMs;
    let lastReservation;
    while (Date.now() <= deadline) {
      lastReservation = await this.request(
        `/api/reservations/${encodeURIComponent(reservationId)}/status`
      );
      if (lastReservation.targets?.every((t) => t.observed === "healthy")) {
        if (typeof invalidateStatusCache === "function") invalidateStatusCache();
        return lastReservation;
      }
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
          ...(options.body != null ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${this.config.apiKey}`,
          ...(options.headers ?? {})
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
        throw new NeurOnApiError(0, path, `Failed to parse response: ${raw}`, 'invalid_json');
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new NeurOnApiError(0, path, 'Request timed out', 'timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
