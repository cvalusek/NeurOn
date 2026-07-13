import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { HealthChecker } from "../reconciler/HealthChecker.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetActivationRepository } from "../repository/InMemoryTargetActivationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { HassleOffCapacityProvider } from "../safety/HassleOffCapacityProvider.js";
import { CostEstimationService } from "../services/CostEstimationService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import { TargetOperationConflictError, TargetOperationCoordinator } from "../services/TargetOperationCoordinator.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime model discovery lifecycle coordination", () => {
  it("atomically publishes discovery demand before a reconcile queued at discovery start can stop the target", async () => {
    const harness = discoveryHarness();
    const inspectionStarted = deferred<void>();
    const finishInspection = deferred<void>();
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    harness.provider.getTargetStatus.mockImplementationOnce(async () => {
      inspectionStarted.resolve();
      await finishInspection.promise;
      return { observed: "stopped", message: "Stopped" };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await inspectionStarted.promise;
    const concurrentReconcile = harness.reconciler.reconcile();
    finishInspection.resolve();
    await catalogReadStarted.promise;
    await concurrentReconcile;

    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(true);
    expect(harness.provider.ensureTargetOn).toHaveBeenCalled();
    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();

    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("keeps the target desired-on when reconciliation runs while the runtime catalog is being read", async () => {
    const harness = discoveryHarness();
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;

    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(true);
    await harness.reconciler.reconcile();
    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();

    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;

    expect(harness.provider.ensureTargetOn).toHaveBeenCalledTimes(2);
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
    expect(harness.catalog.listModelsForTarget(harness.target.id).map((model) => model.id)).toEqual(["runtime-model"]);
    expect(await harness.reservations.list()).toEqual([]);
  });

  it("keeps capacity on when real demand appears during discovery without creating synthetic attribution", async () => {
    const activations = new InMemoryTargetActivationRepository();
    const harness = discoveryHarness({
      targetPatch: { costEstimate: { hourlyUsd: 6 } },
      costEstimation: new CostEstimationService(activations)
    });
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;
    const reservation = await harness.reservations.create({
      username: "clint",
      modelIds: [],
      targetIds: [harness.target.id],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      status: "active"
    });
    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;

    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();
    expect(harness.statuses.get(harness.target.id)).toMatchObject({ desired: "on", observed: "healthy" });
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
    const storedReservations = await harness.reservations.list();
    expect(storedReservations).toMatchObject([{ id: reservation.id, username: "clint" }]);
    expect(storedReservations[0].synthetic).not.toBe(true);
    expect(await activations.listActivationsForTarget(harness.target.id)).toMatchObject([{ status: "open", estimatedCostUsd: 0 }]);
    expect(await activations.listReservationAllocations(reservation.id)).toEqual([]);
  });

  it("keeps capacity on when traffic keepalive demand appears during discovery", async () => {
    const harness = discoveryHarness();
    const trafficKeepalive = new TrafficKeepaliveService(harness.reservations, harness.statuses);
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;
    expect(await trafficKeepalive.recordTraffic(harness.target, [], new Date(), new Date())).toBe(true);
    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;

    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();
    expect(await harness.reservations.list()).toMatchObject([{ username: "traffic", synthetic: true, targetIds: [harness.target.id] }]);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("never shuts down capacity that was already running before discovery", async () => {
    const harness = discoveryHarness({ initialStatus: { observed: "healthy", message: "Already running" } });
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse("runtime-model")));

    await harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);

    expect(harness.provider.ensureTargetOn).toHaveBeenCalledTimes(1);
    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
    expect(await harness.reservations.list()).toEqual([]);
  });

  it("preserves pre-existing reservation demand and converges when that demand ends during discovery", async () => {
    const harness = discoveryHarness({ initialStatus: { observed: "healthy", message: "Already running" } });
    const reservation = await harness.reservations.create({
      username: "clint",
      modelIds: [],
      targetIds: [harness.target.id],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      status: "active"
    });
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;
    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();
    await harness.reservations.update(reservation.id, { status: "done", endedAt: new Date() });
    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;

    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.statuses.get(harness.target.id)).toMatchObject({ desired: "off", observed: "stopped" });
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("cleans up the hold and discovery-owned capacity after an activation failure", async () => {
    const harness = discoveryHarness({ startError: new Error("activation failed") });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker)).rejects.toThrow("activation failed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOn).toHaveBeenCalledTimes(1);
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(false);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
    expect(harness.statuses.get(harness.target.id)?.message).toContain("activation failed");
  });

  it("starts discovery-owned capacity through the HassleOff interlock", async () => {
    const harness = discoveryHarness({ targetPatch: { hassleOff: { protected: true } } });
    const interlocked = new HassleOffCapacityProvider(harness.provider);
    const reconciler = new Reconciler(
      [harness.target],
      harness.reservations,
      harness.statuses,
      interlocked,
      new NoopBackendConfigSync(),
      harness.healthChecker,
      harness.discovery,
      undefined,
      undefined,
      undefined,
      harness.operations
    );
    harness.operations.setDemandController({
      hasDemand: (targetId) => reconciler.hasDemand(targetId),
      reconcileTarget: (targetId) => reconciler.reconcileTarget(targetId)
    });

    await expect(harness.discovery.bootstrapTarget(harness.target, interlocked, harness.healthChecker)).rejects.toThrow(
      "HassleOff interlock blocked target discovery-target"
    );

    expect(harness.provider.ensureTargetOn).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("cleans up the hold and discovery-owned capacity after a provider-status failure", async () => {
    const harness = discoveryHarness({ statusErrorAtCall: 3 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker)).rejects.toThrow("status read failed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(false);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("does not publish desired-on state when the initial capacity inspection fails", async () => {
    const harness = discoveryHarness({ statusErrorAtCall: 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker)).rejects.toThrow("status read failed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOn).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOff).not.toHaveBeenCalled();
    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(false);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
    expect(harness.statuses.get(harness.target.id)).toMatchObject({ desired: "off", observed: "stopped" });
  });

  it("cleans up the hold and discovery-owned capacity after a bootstrap timeout", async () => {
    const harness = discoveryHarness({ targetPatch: { modelDiscovery: { bootstrapTimeoutSeconds: 0 } } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker)).rejects.toThrow(
      "Timed out waiting for discovery-target runtime model discovery"
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.hasDesiredOnDemand(harness.target.id)).toBe(false);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("coalesces duplicate discovery requests for the same target", async () => {
    const harness = discoveryHarness();
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    const fetchMock = vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    const second = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;

    expect(harness.provider.ensureTargetOn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    catalogRead.resolve(modelsResponse("runtime-model"));
    await Promise.all([first, second]);

    expect(harness.provider.ensureTargetOff).toHaveBeenCalledTimes(1);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });

  it("returns a conflict instead of force-stopping during discovery", async () => {
    const harness = discoveryHarness();
    const catalogRead = deferred<Response>();
    const catalogReadStarted = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    }));

    const discovery = harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);
    await catalogReadStarted.promise;
    await expect(
      harness.operations.runForceStop(harness.target.id, () => harness.provider.forceStopTarget(harness.target))
    ).rejects.toBeInstanceOf(TargetOperationConflictError);
    expect(harness.provider.forceStopTarget).not.toHaveBeenCalled();

    catalogRead.resolve(modelsResponse("runtime-model"));
    await discovery;
    await harness.operations.runForceStop(harness.target.id, () => harness.provider.forceStopTarget(harness.target));
    expect(harness.provider.forceStopTarget).toHaveBeenCalledTimes(1);
  });

  it("does not create an activation or reservation for discovery-only demand", async () => {
    const activations = new InMemoryTargetActivationRepository();
    const harness = discoveryHarness({
      targetPatch: { costEstimate: { hourlyUsd: 6 } },
      costEstimation: new CostEstimationService(activations)
    });
    vi.stubGlobal("fetch", vi.fn(async () => modelsResponse("runtime-model")));

    await harness.discovery.bootstrapTarget(harness.target, harness.provider, harness.healthChecker);

    expect(await harness.reservations.list()).toEqual([]);
    expect(await activations.listActivationsForTarget(harness.target.id)).toEqual([]);
    expect(harness.operations.activeDiscoveryCount()).toBe(0);
  });
});

function discoveryHarness(options: {
  initialStatus?: CapacityProviderStatus;
  startError?: Error;
  statusErrorAtCall?: number;
  targetPatch?: Partial<CapacityTarget>;
  costEstimation?: CostEstimationService;
} = {}) {
  const target: CapacityTarget = {
    id: "discovery-target",
    displayName: "Discovery target",
    provider: "fake",
    modelIds: [],
    apiUrl: "http://runtime.invalid/v1",
    ...options.targetPatch
  };
  let providerStatus: CapacityProviderStatus = options.initialStatus ?? { observed: "stopped", message: "Stopped" };
  let statusCalls = 0;
  const provider = {
    provisionTarget: vi.fn(async (_target: CapacityTarget) => undefined),
    ensureTargetOn: vi.fn(async (_target: CapacityTarget) => {
      if (options.startError) throw options.startError;
      providerStatus = { observed: "healthy", message: "Running" };
    }),
    ensureTargetOff: vi.fn(async (_target: CapacityTarget) => {
      providerStatus = { observed: "stopped", message: "Stopped" };
    }),
    getTargetStatus: vi.fn(async (_target: CapacityTarget) => {
      statusCalls += 1;
      if (statusCalls === options.statusErrorAtCall) throw new Error("status read failed");
      return { ...providerStatus };
    }),
    forceStopTarget: vi.fn(async (_target: CapacityTarget) => {
      providerStatus = { observed: "stopped", message: "Force stopped" };
    })
  } satisfies CapacityProvider;
  const reservations = new InMemoryReservationRepository();
  const statuses = new InMemoryTargetStatusRepository();
  const operations = new TargetOperationCoordinator();
  const catalog = new ModelCatalog([], [target]);
  const healthChecker = new HealthChecker(1);
  const discovery = new RuntimeModelDiscovery(catalog, undefined, operations, statuses);
  const reconciler = new Reconciler(
    [target],
    reservations,
    statuses,
    provider,
    new NoopBackendConfigSync(),
    healthChecker,
    discovery,
    undefined,
    undefined,
    options.costEstimation,
    operations
  );
  operations.setDemandController({
    hasDemand: (targetId) => reconciler.hasDemand(targetId),
    reconcileTarget: (targetId) => reconciler.reconcileTarget(targetId)
  });
  return { target, provider, reservations, statuses, operations, catalog, healthChecker, discovery, reconciler };
}

function modelsResponse(id: string): Response {
  return new Response(JSON.stringify({ data: [{ id }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
