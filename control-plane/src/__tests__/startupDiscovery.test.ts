import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { FakeCapacityProvider } from "../capacity/FakeCapacityProvider.js";
import type { AppConfig } from "../domain/types.js";
import { SqliteTargetModelDiscoveryRepository } from "../repository/SqliteTargetModelDiscoveryRepository.js";

const previousUseFakeProvider = process.env.USE_FAKE_PROVIDER;

afterEach(() => {
  if (previousUseFakeProvider === undefined) delete process.env.USE_FAKE_PROVIDER;
  else process.env.USE_FAKE_PROVIDER = previousUseFakeProvider;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startup runtime model discovery cache", () => {
  it("reuses a persisted runpod-prefer catalog without any provider or model contact", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-startup-discovery-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const discoveredAt = new Date("2026-07-13T20:15:00.000Z");
    const seed = new SqliteTargetModelDiscoveryRepository(databasePath);
    await seed.record({
      targetId: "runpod-prefer",
      discoveredAt,
      models: [{ id: "gemma-4-e2b", aliases: ["gemma-4-e2b"] }]
    });
    seed.close();

    const providerSpies = [
      vi.spyOn(FakeCapacityProvider.prototype, "provisionTarget"),
      vi.spyOn(FakeCapacityProvider.prototype, "ensureTargetOn"),
      vi.spyOn(FakeCapacityProvider.prototype, "ensureTargetOff"),
      vi.spyOn(FakeCapacityProvider.prototype, "getTargetStatus"),
      vi.spyOn(FakeCapacityProvider.prototype, "forceStopTarget")
    ];
    const fetchMock = vi.fn(async () => {
      throw new Error("network contact was not expected");
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.USE_FAKE_PROVIDER = "true";

    const config: AppConfig = {
      port: 0,
      sharedPassword: "secret",
      storage: { driver: "sqlite", path: databasePath },
      awsRegion: "us-east-1",
      litellmTrafficPollSeconds: 0,
      litellmTrafficLookbackSeconds: 300,
      runtimeProfiles: [],
      capacityProviders: [],
      capacityTargets: [{
        id: "runpod-prefer",
        displayName: "RunPod PreFer",
        provider: "runpod",
        modelIds: [],
        modelDiscovery: { bootstrapOnStartup: true },
        apiUrl: "http://runtime.invalid/v1",
        runpod: { podId: "fake-locked-pod", runtimePort: 8080 }
      }],
      reconcilerIntervalSeconds: 60,
      reservationStatusPollSeconds: 10,
      adminStatusPollSeconds: 30,
      healthCheckTimeoutSeconds: 1,
      healthCheckIntervalSeconds: 15,
      adminUsers: [],
      authMethods: []
    };

    const built = await buildApp(config, []);
    const infoLog = vi.spyOn(built.app.log, "info");
    const auth = { authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}` };
    try {
      const outcomes = await built.bootstrapRuntimeModels();

      expect(outcomes).toEqual([{
        targetId: "runpod-prefer",
        outcome: "skipped-cached",
        reason: `Reused persisted runtime model discovery from ${discoveredAt.toISOString()}; startup discovery did not contact the capacity provider.`,
        cachedDiscoveredAt: discoveredAt.toISOString()
      }]);
      for (const providerSpy of providerSpies) expect(providerSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(infoLog).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "runpod-prefer", outcome: "skipped-cached", cachedDiscoveredAt: discoveredAt.toISOString() }),
        "runtime model discovery bootstrap skipped because cached discovery is available"
      );

      const status = await built.app.inject({ method: "GET", url: "/api/admin/targets", headers: auth });
      expect(status.statusCode).toBe(200);
      expect(status.json().capacityTargets[0]).toMatchObject({
        id: "runpod-prefer",
        modelIds: ["gemma-4-e2b"],
        runtimeModelDiscovery: {
          cached: true,
          discoveredAt: discoveredAt.toISOString(),
          startupOutcome: {
            targetId: "runpod-prefer",
            outcome: "skipped-cached",
            reason: `Reused persisted runtime model discovery from ${discoveredAt.toISOString()}; startup discovery did not contact the capacity provider.`
          }
        }
      });

      const systemStatus = await built.app.inject({ method: "GET", url: "/api/status", headers: auth });
      expect(systemStatus.json()).toMatchObject({ reservations: [], activeReservations: [] });
      const activations = await built.app.inject({ method: "GET", url: "/api/admin/activations", headers: auth });
      expect(activations.json().activations).toEqual([]);
      for (const providerSpy of providerSpies) expect(providerSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      const manualDiscovery = vi.spyOn(built.runtimeModelDiscovery, "bootstrapTarget").mockResolvedValue(undefined);
      const manual = await built.app.inject({ method: "POST", url: "/api/admin/targets/runpod-prefer/discover", headers: auth });
      expect(manual.statusCode).toBe(200);
      expect(manualDiscovery).toHaveBeenCalledTimes(1);

      const page = await built.app.inject({ method: "GET", url: "/admin/targets", headers: auth });
      expect(page.body).toContain("Discover models now");
      expect(page.body).toContain("Discovery cached");
      expect(page.body).toContain("may activate a stopped target");
    } finally {
      await built.app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
