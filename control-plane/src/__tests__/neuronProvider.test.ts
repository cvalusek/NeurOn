import { afterEach, describe, expect, it, vi } from "vitest";
import { NeuronCapacityProvider } from "../capacity/NeuronCapacityProvider.js";
import type { CapacityTarget } from "../domain/types.js";

const target: CapacityTarget = {
  id: "remote-qwen",
  displayName: "Remote Qwen",
  provider: "neuron",
  providerId: "upstream",
  modelIds: ["qwen"],
  neuron: { targetId: "qwen" },
  neuronProvider: {
    apiBaseUrl: "https://neuron.example.test",
    apiKey: "secret",
    reservationMinutes: 3
  }
};

describe("NeuronCapacityProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates, extends, reads status, and ends an upstream reservation", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/api/reservations")) {
          return { ok: true, text: async () => JSON.stringify({ reservationId: "reservation-1" }) };
        }
        if (url.endsWith("/api/status")) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                capacityTargets: [{ id: "qwen", observed: "healthy", message: "Ready" }]
              })
          };
        }
        return { ok: true, text: async () => "" };
      })
    );

    const provider = new NeuronCapacityProvider();
    await provider.ensureTargetOn(target);
    await provider.ensureTargetOn(target);
    const status = await provider.getTargetStatus(target);
    await provider.ensureTargetOff(target);

    expect(calls).toEqual([
      {
        url: "https://neuron.example.test/api/reservations",
        method: "POST",
        body: { targetIds: ["qwen"], durationMinutes: 3 }
      },
      {
        url: "https://neuron.example.test/api/reservations/reservation-1/extend",
        method: "POST",
        body: { durationMinutes: 3, fromNow: true }
      },
      { url: "https://neuron.example.test/api/status", method: "GET", body: undefined },
      { url: "https://neuron.example.test/api/reservations/reservation-1/done", method: "POST", body: undefined }
    ]);
    expect(status).toMatchObject({ observed: "healthy", message: "Upstream NeurOn: Ready" });
  });
});
