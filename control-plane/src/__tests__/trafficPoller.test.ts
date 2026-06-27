import { describe, expect, it } from "vitest";
import type { TrafficSource } from "../domain/interfaces.js";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";
import { TrafficPoller } from "../services/TrafficPoller.js";

const target: CapacityTarget = {
  id: "local-runtime",
  displayName: "Local Runtime",
  provider: "docker-compose",
  modelIds: ["qwen-3.6-35b-a3b"],
  healthCheckUrl: "http://example.test/health",
  trafficModelPrefixes: ["prefer/"]
};

const models: ModelDefinition[] = [
  {
    id: "qwen-3.6-35b-a3b",
    displayName: "Qwen",
    aliases: ["qwen-3.6-35b-a3b"],
    targetIds: [target.id]
  }
];

describe("TrafficPoller", () => {
  it("refreshes a synthetic reservation for recent LiteLLM traffic", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    const source: TrafficSource = {
      async pollRecentTraffic(now = new Date()) {
        return [{ modelId: "qwen-3.6-35b-a3b", seenAt: now }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [target]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll(new Date("2026-06-24T20:00:00.000Z"));

    const reservations = await repository.list();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].username).toBe("traffic");
    expect(reservations[0].synthetic).toBe(true);
    expect(reservations[0].modelIds).toEqual(["qwen-3.6-35b-a3b"]);
    expect(reservations[0].expiresAt).toEqual(new Date("2026-06-24T20:02:00.000Z"));
  });

  it("ignores traffic for unknown LiteLLM aliases", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    const source: TrafficSource = {
      async pollRecentTraffic(now = new Date()) {
        return [{ modelId: "not-configured", seenAt: now }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [target]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll();

    expect(await repository.list()).toHaveLength(0);
  });

  it("keeps a target warm when LiteLLM logs a configured model prefix", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    const source: TrafficSource = {
      async pollRecentTraffic(now = new Date()) {
        return [{ modelId: "prefer/gemma-4b-e2b", seenAt: now }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [target]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll(new Date("2026-06-24T20:00:00.000Z"));

    const reservations = await repository.list();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].targetIds).toEqual([target.id]);
    expect(reservations[0].modelIds).toEqual(["prefer/gemma-4b-e2b"]);
  });

  it("uses the target traffic prefix from config instead of requiring prefer", async () => {
    const configuredPrefixTarget: CapacityTarget = {
      ...target,
      trafficModelPrefixes: ["runpod/"]
    };
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: configuredPrefixTarget.id, desired: "on", observed: "healthy", message: "Ready" });
    const source: TrafficSource = {
      async pollRecentTraffic(now = new Date()) {
        return [{ modelId: "runpod/gemma-4b-e2b", seenAt: now }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [configuredPrefixTarget]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll(new Date("2026-06-24T20:00:00.000Z"));

    const reservations = await repository.list();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].targetIds).toEqual([configuredPrefixTarget.id]);
    expect(reservations[0].modelIds).toEqual(["runpod/gemma-4b-e2b"]);
  });

  it("does not renew keepalive from stale LiteLLM traffic", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    const source: TrafficSource = {
      async pollRecentTraffic() {
        return [{ modelId: "qwen-3.6-35b-a3b", seenAt: new Date("2026-06-24T20:00:00.000Z") }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [target]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll(new Date("2026-06-24T20:06:00.000Z"));

    expect(await repository.list()).toHaveLength(0);
  });

  it("uses active reservation keepalive minutes for traffic reservations", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    await repository.create({
      username: "clint",
      modelIds: [],
      targetIds: [target.id],
      createdAt: new Date("2026-06-24T20:00:00.000Z"),
      expiresAt: new Date("2026-06-24T20:10:00.000Z"),
      keepaliveMinutes: 7,
      status: "active"
    });
    const source: TrafficSource = {
      async pollRecentTraffic() {
        return [{ modelId: "qwen-3.6-35b-a3b", seenAt: new Date("2026-06-24T20:01:00.000Z") }];
      }
    };

    const poller = new TrafficPoller(source, new ModelCatalog(models, [target]), new TrafficKeepaliveService(repository, statuses));
    await poller.poll(new Date("2026-06-24T20:02:00.000Z"));

    const traffic = (await repository.list()).find((reservation) => reservation.synthetic);
    expect(traffic?.keepaliveMinutes).toBe(7);
    expect(traffic?.expiresAt).toEqual(new Date("2026-06-24T20:08:00.000Z"));
  });
});
