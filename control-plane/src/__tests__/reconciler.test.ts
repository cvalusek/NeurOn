import { describe, expect, it } from "vitest";
import { FakeCapacityProvider } from "../capacity/FakeCapacityProvider.js";
import type { CapacityTarget } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";

const target: CapacityTarget = { id: "t1", displayName: "T1", provider: "aws-ecs", modelIds: ["m1"], healthUrl: "http://example.test" };

describe("reconciler decisions", () => {
  it("turns targets off when no active reservation needs them", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync());
    await reconciler.reconcile();
    expect(provider.desired.get("t1")).toBe("off");
  });

  it("does not crash when provider throws", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    provider.ensureTargetOn = async () => {
      throw new Error("provider failed");
    };
    await repository.create({ username: "clint", modelIds: ["m1"], targetIds: ["t1"], createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: "active" });
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync());
    await reconciler.reconcile();
    expect(statuses.get("t1")?.observed).toBe("failed");
  });

  it("records startup duration estimates from Starting to healthy", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync());
    const startedAt = new Date("2026-06-25T10:00:00.000Z");
    await repository.create({ username: "clint", modelIds: ["m1"], targetIds: ["t1"], createdAt: startedAt, expiresAt: new Date("2026-06-25T11:00:00.000Z"), status: "active" });
    provider.statuses.set("t1", { observed: "starting", message: "starting" });
    await reconciler.reconcile(startedAt);
    provider.statuses.set("t1", { observed: "healthy", message: "Running" });
    await reconciler.reconcile(new Date("2026-06-25T10:02:00.000Z"));
    expect(statuses.get("t1")?.startupEstimate).toEqual({ minSeconds: 120, maxSeconds: 120, avgSeconds: 120, sampleCount: 1 });
  });

  it("polls recent traffic before shutting down a previously active target", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    const now = new Date("2026-06-25T10:00:00.000Z");
    statuses.set({ targetId: "t1", desired: "on", observed: "healthy", message: "Ready" });
    provider.statuses.set("t1", { observed: "healthy", message: "Running" });
    const trafficPoller = {
      poll: async () => {
        await repository.create({
          username: "traffic",
          modelIds: ["m1"],
          targetIds: ["t1"],
          createdAt: now,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
          status: "active",
          synthetic: true
        });
      }
    };
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync(), undefined, undefined, undefined, trafficPoller as never);
    await reconciler.reconcile(now);
    expect(provider.desired.get("t1")).toBe("on");
  });

  it("keeps a target starting until requested model warmup succeeds", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    provider.statuses.set("t1", { observed: "healthy", message: "Running" });
    await repository.create({
      username: "clint",
      modelIds: ["m1"],
      targetIds: ["t1"],
      createdAt: new Date("2026-06-25T10:00:00.000Z"),
      expiresAt: new Date("2026-06-25T11:00:00.000Z"),
      status: "active"
    });
    const modelWarmup = {
      calls: [] as string[][],
      async warmupTargetModels(_target: CapacityTarget, modelIds: string[]) {
        this.calls.push(modelIds);
        throw new Error("model still loading");
      }
    };
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync(), undefined, undefined, modelWarmup as never);

    await reconciler.reconcile(new Date("2026-06-25T10:00:00.000Z"));

    expect(modelWarmup.calls).toEqual([["m1"]]);
    expect(statuses.get("t1")).toMatchObject({ desired: "on", observed: "starting", message: "model still loading" });
    expect((await repository.list())[0].status).toBe("active");
  });

  it("marks a target healthy after requested model warmup succeeds", async () => {
    const repository = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const provider = new FakeCapacityProvider();
    provider.statuses.set("t1", { observed: "healthy", message: "Running" });
    await repository.create({
      username: "clint",
      modelIds: ["m1"],
      targetIds: ["t1"],
      createdAt: new Date("2026-06-25T10:00:00.000Z"),
      expiresAt: new Date("2026-06-25T11:00:00.000Z"),
      status: "active"
    });
    const modelWarmup = {
      calls: [] as string[][],
      async warmupTargetModels(_target: CapacityTarget, modelIds: string[]) {
        this.calls.push(modelIds);
      }
    };
    const reconciler = new Reconciler([target], repository, statuses, provider, new NoopBackendConfigSync(), undefined, undefined, modelWarmup as never);

    await reconciler.reconcile(new Date("2026-06-25T10:00:00.000Z"));

    expect(modelWarmup.calls).toEqual([["m1"]]);
    expect(statuses.get("t1")).toMatchObject({ desired: "on", observed: "healthy" });
  });
});
