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
  healthCheckUrl: "http://example.test/health"
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
});
