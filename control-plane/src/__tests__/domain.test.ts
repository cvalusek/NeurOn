import { describe, expect, it } from "vitest";
import { FakeCapacityProvider } from "../capacity/FakeCapacityProvider.js";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";

const target: CapacityTarget = {
  id: "gpu-pool-96gb",
  displayName: "GPU Pool 96GB",
  provider: "aws-ecs",
  modelIds: ["qwen", "gemma"],
  healthCheckUrl: "http://example.test/health"
};

const models: ModelDefinition[] = [
  { id: "qwen", displayName: "Qwen", aliases: ["qwen"], targetIds: [target.id] },
  { id: "gemma", displayName: "Gemma", aliases: ["gemma"], targetIds: [target.id] }
];

function harness() {
  const repository = new InMemoryReservationRepository();
  const statuses = new InMemoryTargetStatusRepository();
  const provider = new FakeCapacityProvider();
  const catalog = new ModelCatalog(models, [target]);
  const reservations = new ReservationService(repository, catalog);
  const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync());
  return { repository, statuses, provider, catalog, reservations, reconciler };
}

describe("reservation behavior", () => {
  it("expires old reservations", async () => {
    const { repository } = harness();
    await repository.create({ username: "clint", modelIds: ["qwen"], targetIds: [target.id], createdAt: new Date(0), expiresAt: new Date(1), status: "active" });
    await repository.expireReservations(new Date(2));
    expect((await repository.list())[0].status).toBe("expired");
  });

  it("keeps capacity on for overlapping reservations when one is done", async () => {
    const { reservations, reconciler, provider } = harness();
    const userA = { username: "alice", isAdmin: false };
    const userB = { username: "bob", isAdmin: false };
    const first = await reservations.createForUser(userA, { modelIds: ["qwen"], durationMinutes: 30 });
    await reservations.createForUser(userB, { modelIds: ["gemma"], durationMinutes: 30 });
    await reservations.markDone(first.id, userA);
    await reconciler.reconcile();
    expect(provider.desired.get(target.id)).toBe("on");
  });

  it("selecting multiple models from one target only turns on that target once", async () => {
    const { reservations, repository } = harness();
    await reservations.createForUser({ username: "clint", isAdmin: false }, { modelIds: ["qwen", "gemma"], durationMinutes: 30 });
    expect((await repository.list())[0].targetIds).toEqual([target.id]);
  });

  it("allows target-only reservations before model discovery has populated choices", async () => {
    const { reservations, repository } = harness();
    await reservations.createForUser({ username: "clint", isAdmin: false }, { targetIds: [target.id], durationMinutes: 30 });
    const reservation = (await repository.list())[0];
    expect(reservation.modelIds).toEqual([]);
    expect(reservation.targetIds).toEqual([target.id]);
  });

  it("computes aggregate desired capacity from active reservations", async () => {
    const { reservations, reconciler, provider } = harness();
    await reservations.createForUser({ username: "clint", isAdmin: false }, { modelIds: ["qwen"], durationMinutes: 30 });
    await reconciler.reconcile();
    expect(provider.desired.get(target.id)).toBe("on");
  });

  it("adds discovered runtime models as selectable catalog entries", () => {
    const discoveryTarget: CapacityTarget = { id: "discovery", displayName: "Discovery", provider: "docker", modelIds: [], healthCheckUrl: "http://example.test/health" };
    const catalog = new ModelCatalog([], [discoveryTarget]);
    catalog.recordRuntimeModels(discoveryTarget.id, [
      { id: "default" },
      {
        id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
        aliases: ["qwen-3.6", "qwen-3.6-35b-a3b"],
        meta: { n_ctx_train: 1_000_000, n_params: 35_000_000_000, size: 28_000_000_000 }
      },
      { id: "unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF:UD-Q6_K_XL", aliases: ["glm-4.7-flash"] },
      { id: "unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL", aliases: ["gemma-4", "gemma-4-26b"] }
    ]);
    const discoveredModels = catalog.listModelsForTarget(discoveryTarget.id);
    expect(discoveredModels[0]).toMatchObject({
      id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
      targetIds: [discoveryTarget.id],
      aliases: expect.arrayContaining(["qwen-3.6", "qwen-3.6-35b-a3b"]),
      runtimeMeta: expect.objectContaining({ n_params: 35_000_000_000, size: 28_000_000_000 }),
      contextWindowTokens: 1_000_000,
      contextLabel: "1m"
    });
    expect(discoveredModels[1]).toMatchObject({
      id: "unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF:UD-Q6_K_XL",
      aliases: expect.arrayContaining(["glm-4.7-flash"])
    });
    expect(discoveredModels[2]).toMatchObject({
      id: "unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL",
      aliases: expect.arrayContaining(["gemma-4", "gemma-4-26b"])
    });
    expect(catalog.getModel("default")).toBeUndefined();
    expect(catalog.getModel("qwen-3.6")?.id).toBe("unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL");
    expect(catalog.getModel("glm-4.7-flash")?.id).toBe("unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF:UD-Q6_K_XL");
    expect(catalog.getModel("gemma-4")?.id).toBe("unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL");
    expect(discoveryTarget.modelIds).toEqual([
      "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
      "unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF:UD-Q6_K_XL",
      "unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL"
    ]);
  });

  it("refreshes discovered models with loaded runtime metadata", () => {
    const discoveryTarget: CapacityTarget = { id: "discovery", displayName: "Discovery", provider: "docker", modelIds: [], healthCheckUrl: "http://example.test/health" };
    const catalog = new ModelCatalog([], [discoveryTarget]);
    catalog.recordRuntimeModels(discoveryTarget.id, [{ id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL", aliases: ["qwen-3.6"] }]);
    catalog.recordRuntimeModels(discoveryTarget.id, [
      {
        id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
        aliases: ["qwen-3.6", "qwen-3.6-35b-a3b"],
        meta: {
          vocab_type: 2,
          n_vocab: 154_880,
          n_ctx: 202_752,
          n_ctx_train: 202_752,
          n_embd: 2_048,
          n_params: 22_996_118_432,
          size: 20_218_236_544
        }
      }
    ]);

    expect(catalog.getModel("qwen-3.6-35b-a3b")).toMatchObject({
      contextWindowTokens: 202_752,
      contextLabel: "202,752",
      runtimeMeta: expect.objectContaining({
        n_ctx: 202_752,
        n_params: 22_996_118_432,
        size: 20_218_236_544
      })
    });
  });

  it("marks active reservations failed when provider reports failure", async () => {
    const { reservations, reconciler, provider, repository } = harness();
    provider.statuses.set(target.id, { observed: "failed", message: "boom" });
    await reservations.createForUser({ username: "clint", isAdmin: false }, { modelIds: ["qwen"], durationMinutes: 30 });
    await reconciler.reconcile();
    expect((await repository.list())[0].status).toBe("failed");
  });
});

describe("traffic keepalive", () => {
  it("extends already healthy capacity with a synthetic reservation", async () => {
    const { repository, statuses } = harness();
    statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" });
    const service = new TrafficKeepaliveService(repository, statuses);
    expect(await service.recordTraffic(target, ["qwen"], new Date("2026-06-24T20:00:00.000Z"), new Date("2026-06-24T20:01:00.000Z"))).toBe(true);
    const reservation = (await repository.list())[0];
    expect(reservation.username).toBe("traffic");
    expect(reservation.expiresAt).toEqual(new Date("2026-06-24T20:05:00.000Z"));
  });

  it("does not resurrect failed target by itself", async () => {
    const { repository, statuses } = harness();
    statuses.set({ targetId: target.id, desired: "on", observed: "failed", message: "boom" });
    const service = new TrafficKeepaliveService(repository, statuses);
    expect(await service.recordTraffic(target, ["qwen"], new Date())).toBe(false);
    expect(await repository.list()).toHaveLength(0);
  });
});
