import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivateOrReprovisionCapacityProvider } from "../capacity/ActivateOrReprovisionCapacityProvider.js";
import { CompositeCapacityProvider } from "../capacity/CompositeCapacityProvider.js";
import { RecoverableTargetUnavailableError } from "../capacity/RecoverableTargetUnavailableError.js";
import { RunPodCapacityProvider } from "../capacity/RunPodCapacityProvider.js";
import { loadConfig } from "../config/loadConfig.js";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, HassleOffClientConfig } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryCapacityTargetRepository } from "../repository/InMemoryCapacityTargetRepository.js";
import { InMemoryTargetModelDiscoveryRepository } from "../repository/InMemoryTargetModelDiscoveryRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { HassleOffCapacityProvider } from "../safety/HassleOffCapacityProvider.js";
import { HassleOffClient } from "../safety/HassleOffClient.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { TargetService } from "../services/TargetService.js";

const protectedTarget: CapacityTarget = {
  id: "rented-a",
  displayName: "Rented A",
  provider: "runpod",
  modelIds: ["model-a"],
  hassleOff: {
    protected: true,
    leaseDurationSeconds: 60
  }
};

const clientConfig: HassleOffClientConfig = {
  baseUrl: "https://hassleoff.example.test",
  controllerToken: "controller-secret-token",
  controllerId: "neuron-test",
  requestTimeoutSeconds: 2,
  failSafeTestTargetId: "hassleoff-failsafe-test"
};

const managedEnv = [
  "CAPACITY_TARGETS_JSON",
  "CAPACITY_TARGET_KEYS",
  "CAPACITY_TARGET_GPU_DISPLAY_NAME",
  "CAPACITY_TARGET_GPU_PROVIDER",
  "CAPACITY_TARGET_GPU_HASSLEOFF_PROTECTED",
  "CAPACITY_TARGET_GPU_HASSLEOFF_LEASE_DURATION_SECONDS",
  "CAPACITY_TARGET_GPU_HASSLEOFF_SHUTDOWN_ON_STALE_TRIP_TEST",
  "CAPACITY_TARGET_GPU_HASSLEOFF_TRIP_TEST_MAX_AGE_SECONDS",
  "CAPACITY_TARGET_GPU_REPROVISION_ON_RECOVERABLE_UNAVAILABLE",
  "HASSLEOFF_URL",
  "HASSLEOFF_CONTROLLER_TOKEN",
  "HASSLEOFF_CONTROLLER_ID",
  "HASSLEOFF_FAILSAFE_TEST_TARGET_ID"
];

afterEach(() => {
  for (const key of managedEnv) delete process.env[key];
  vi.restoreAllMocks();
});

describe("NeurOn HassleOff start interlock", () => {
  it("refuses a protected start when HassleOff is unreachable and never calls the provider", async () => {
    const provider = providerSpy();
    const client = new HassleOffClient(clientConfig, vi.fn(async () => {
      throw new Error("connection refused");
    }) as typeof fetch);
    const interlocked = new HassleOffCapacityProvider(provider, client);

    await expect(interlocked.ensureTargetOn(protectedTarget)).rejects.toThrow("HassleOff interlock blocked target rented-a: connection refused");
    expect(provider.ensureTargetOn).not.toHaveBeenCalled();
  });

  it("requires confirmation of the exact target lease before starting or provisioning", async () => {
    const provider = providerSpy();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      return jsonResponse({
        protocolVersion: "1",
        accepted: true,
        armed: true,
        targetArmed: true,
        targetId: body.targetId,
        leaseId: body.leaseId,
        sequence: body.sequence,
        acceptedUntil: new Date(Date.now() + 60_000).toISOString()
      });
    });
    const interlocked = new HassleOffCapacityProvider(provider, new HassleOffClient(clientConfig, fetchImplementation as typeof fetch));

    await interlocked.ensureTargetOn(protectedTarget);
    await interlocked.provisionTarget(protectedTarget);

    expect(provider.ensureTargetOn).toHaveBeenCalledTimes(1);
    expect(provider.provisionTarget).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url.endsWith("/v1/targets/rented-a/lease") && request.body.targetId === "rented-a")).toBe(true);
  });

  it("refuses a mismatched lease response", async () => {
    const provider = providerSpy();
    const client = new HassleOffClient(clientConfig, vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        protocolVersion: "1",
        accepted: true,
        armed: true,
        targetArmed: true,
        targetId: "rented-b",
        leaseId: body.leaseId,
        sequence: body.sequence,
        acceptedUntil: new Date(Date.now() + 60_000).toISOString()
      });
    }) as typeof fetch);
    const interlocked = new HassleOffCapacityProvider(provider, client);

    await expect(interlocked.ensureTargetOn(protectedTarget)).rejects.toThrow("did not confirm the exact armed lease");
    expect(provider.ensureTargetOn).not.toHaveBeenCalled();
  });

  it("makes an interlock refusal visible through reconciler status and reservation failure", async () => {
    const provider = providerSpy();
    const interlocked = new HassleOffCapacityProvider(provider);
    const reservations = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const now = new Date("2026-07-13T12:00:00.000Z");
    await reservations.create({
      username: "clint",
      modelIds: ["model-a"],
      targetIds: [protectedTarget.id],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      status: "active"
    });
    const reconciler = new Reconciler([protectedTarget], reservations, statuses, interlocked, new NoopBackendConfigSync());

    await reconciler.reconcile(now);

    expect(statuses.get(protectedTarget.id)).toMatchObject({
      observed: "failed",
      message: expect.stringContaining("HassleOff interlock blocked target rented-a")
    });
    expect((await reservations.list())[0]).toMatchObject({ status: "failed", failureMessage: expect.stringContaining("HassleOff interlock blocked") });
    expect(provider.ensureTargetOn).not.toHaveBeenCalled();
  });
});

describe("HassleOff fail-safe test client", () => {
  it("runs only the configured synthetic testOnly fake target", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const succeededAt = "2026-07-13T12:00:00.000Z";
    const client = new HassleOffClient(clientConfig, vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/v1/status")) {
        return jsonResponse({
          protocolVersion: "1",
          service: { healthy: true, ready: true, armed: true },
          targets: [{
            targetId: "hassleoff-failsafe-test",
            registrationId: "hassleoff-failsafe-test-v1",
            actionType: "fake",
            testOnly: true,
            armed: false
          }]
        });
      }
      return jsonResponse({
        protocolVersion: "1",
        targetId: "hassleoff-failsafe-test",
        succeeded: true,
        lastFullTripTestSucceededAt: succeededAt,
        auditEventId: 42
      });
    }) as typeof fetch);

    await expect(client.runFailSafeTest()).resolves.toEqual({
      targetId: "hassleoff-failsafe-test",
      succeeded: true,
      lastFullTripTestSucceededAt: succeededAt,
      auditEventId: 42
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://hassleoff.example.test/v1/status",
      "https://hassleoff.example.test/v1/targets/hassleoff-failsafe-test/trip-test"
    ]);
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      protocolVersion: "1",
      targetId: "hassleoff-failsafe-test"
    });
  });

  it("refuses a real registration before calling the trip-test endpoint", async () => {
    const request = vi.fn(async (_url: string) => jsonResponse({
      protocolVersion: "1",
      service: { healthy: true, ready: true, armed: true },
      targets: [{
        targetId: "hassleoff-failsafe-test",
        registrationId: "real-target-v1",
        actionType: "runpod-stop",
        testOnly: false,
        armed: true
      }]
    }));
    const client = new HassleOffClient(clientConfig, request as typeof fetch);

    await expect(client.runFailSafeTest()).rejects.toThrow("must be registered as testOnly with a fake action");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("https://hassleoff.example.test/v1/status");
  });
});

describe("stale trip-test intentional shutdown", () => {
  it("routes only the exact intended shutdown through HassleOff when the full trip test is stale", async () => {
    const provider = providerSpy();
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImplementation = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, body });
      if (url.endsWith("/v1/status")) {
        return jsonResponse({ protocolVersion: "1", service: { armed: true, ready: true }, targets: [] });
      }
      return jsonResponse({ protocolVersion: "1", targetId: body?.targetId, requestId: body?.requestId, stopped: true });
    });
    const target: CapacityTarget = {
      ...protectedTarget,
      hassleOff: {
        ...protectedTarget.hassleOff!,
        staleTripTestShutdown: { enabled: true, maxAgeSeconds: 3_600 }
      }
    };
    const interlocked = new HassleOffCapacityProvider(provider, new HassleOffClient(clientConfig, fetchImplementation as typeof fetch));

    await interlocked.ensureTargetOff(target);
    await interlocked.ensureTargetOff(target);

    expect(provider.ensureTargetOff).not.toHaveBeenCalled();
    const shutdowns = requests.filter((request) => request.url.endsWith("/v1/targets/rented-a/shutdown"));
    expect(shutdowns).toHaveLength(2);
    expect(shutdowns[0].body).toMatchObject({ targetId: "rented-a", reason: "neuron-intentional-shutdown-stale-trip-test" });
    expect(shutdowns[1].body?.requestId).toBe(shutdowns[0].body?.requestId);
    expect(requests.some((request) => request.url.includes("rented-b"))).toBe(false);
  });

  it("uses the direct provider stop when the test is fresh or HassleOff is unavailable", async () => {
    const target: CapacityTarget = {
      ...protectedTarget,
      hassleOff: {
        ...protectedTarget.hassleOff!,
        staleTripTestShutdown: { enabled: true, maxAgeSeconds: 3_600 }
      }
    };
    const freshProvider = providerSpy();
    const freshClient = new HassleOffClient(clientConfig, vi.fn(async () => jsonResponse({
      protocolVersion: "1",
      service: { armed: true, ready: true },
      targets: [],
      lastFullTripTestSucceededAt: new Date().toISOString()
    })) as typeof fetch);
    await new HassleOffCapacityProvider(freshProvider, freshClient).ensureTargetOff(target);
    expect(freshProvider.ensureTargetOff).toHaveBeenCalledTimes(1);

    const unavailableProvider = providerSpy();
    const unavailableClient = new HassleOffClient(clientConfig, vi.fn(async () => {
      throw new Error("watchdog unavailable");
    }) as typeof fetch);
    await new HassleOffCapacityProvider(unavailableProvider, unavailableClient).ensureTargetOff(target);
    expect(unavailableProvider.ensureTargetOff).toHaveBeenCalledTimes(1);
  });
});

describe("provider-neutral activate-or-reprovision boundary", () => {
  it("reprovisions only after the typed recoverable availability condition and retries activation with the durable patch", async () => {
    const activationTargets: CapacityTarget[] = [];
    let activationAttempts = 0;
    const provider = providerSpy({
      ensureTargetOn: vi.fn(async (target: CapacityTarget) => {
        activationTargets.push(target);
        activationAttempts += 1;
        if (activationAttempts === 1) throw new RecoverableTargetUnavailableError("resource no longer exists");
      }),
      reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "replacement-pod" } }))
    });
    const sink = {
      canPersistReplacement: vi.fn(async () => true),
      applyReplacementPatch: vi.fn(async (_targetId: string, patch: Partial<CapacityTarget>) => ({
        ...protectedTarget,
        activationPolicy: { reprovisionOnRecoverableUnavailable: true },
        ...patch
      }))
    };
    const boundary = new ActivateOrReprovisionCapacityProvider(provider, sink);
    const target = { ...protectedTarget, activationPolicy: { reprovisionOnRecoverableUnavailable: true } };

    await boundary.ensureTargetOn(target);

    expect(provider.reprovisionTarget).toHaveBeenCalledTimes(1);
    expect(sink.canPersistReplacement).toHaveBeenCalledWith("rented-a");
    expect(sink.applyReplacementPatch).toHaveBeenCalledWith("rented-a", { runpod: { podId: "replacement-pod" } });
    expect(activationTargets[1].runpod?.podId).toBe("replacement-pod");
  });

  it("rechecks the HassleOff lease immediately before replacement provisioning", async () => {
    const provider = providerSpy({
      ensureTargetOn: vi.fn(async () => { throw new RecoverableTargetUnavailableError("resource unavailable"); }),
      reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "must-not-be-created" } }))
    });
    let leaseCalls = 0;
    const fetchImplementation = vi.fn(async (_url: string, init?: RequestInit) => {
      leaseCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (leaseCalls === 2) return jsonResponse({ error: "watchdog lost readiness" }, 503);
      return jsonResponse({
        protocolVersion: "1",
        accepted: true,
        armed: true,
        targetArmed: true,
        targetId: body.targetId,
        leaseId: body.leaseId,
        sequence: body.sequence,
        acceptedUntil: new Date(Date.now() + 60_000).toISOString()
      });
    });
    const interlocked = new HassleOffCapacityProvider(provider, new HassleOffClient(clientConfig, fetchImplementation as typeof fetch));
    const boundary = new ActivateOrReprovisionCapacityProvider(interlocked, {
      canPersistReplacement: vi.fn(async () => true),
      applyReplacementPatch: vi.fn()
    });

    await expect(boundary.ensureTargetOn({
      ...protectedTarget,
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    })).rejects.toThrow("watchdog lost readiness");
    expect(leaseCalls).toBe(2);
    expect(provider.reprovisionTarget).not.toHaveBeenCalled();
  });

  it("does not reprovision for generic failures, disabled policy, or a non-durable target binding", async () => {
    const genericProvider = providerSpy({
      ensureTargetOn: vi.fn(async () => { throw new Error("generic provider failure"); }),
      reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "must-not-exist" } }))
    });
    const permissiveSink = { canPersistReplacement: vi.fn(async () => true), applyReplacementPatch: vi.fn() };
    await expect(new ActivateOrReprovisionCapacityProvider(genericProvider, permissiveSink).ensureTargetOn({
      ...protectedTarget,
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    })).rejects.toThrow("generic provider failure");
    expect(genericProvider.reprovisionTarget).not.toHaveBeenCalled();

    const disabledProvider = providerSpy({
      ensureTargetOn: vi.fn(async () => { throw new RecoverableTargetUnavailableError("recoverable"); }),
      reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "must-not-exist" } }))
    });
    await expect(new ActivateOrReprovisionCapacityProvider(disabledProvider, permissiveSink).ensureTargetOn(protectedTarget)).rejects.toBeInstanceOf(RecoverableTargetUnavailableError);
    expect(disabledProvider.reprovisionTarget).not.toHaveBeenCalled();

    const nonDurableProvider = providerSpy({
      ensureTargetOn: vi.fn(async () => { throw new RecoverableTargetUnavailableError("recoverable"); }),
      reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "must-not-exist" } }))
    });
    const nonDurableSink = { canPersistReplacement: vi.fn(async () => false), applyReplacementPatch: vi.fn() };
    await expect(new ActivateOrReprovisionCapacityProvider(nonDurableProvider, nonDurableSink).ensureTargetOn({
      ...protectedTarget,
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    })).rejects.toThrow("stored durably");
    expect(nonDurableProvider.reprovisionTarget).not.toHaveBeenCalled();
  });

  it("keeps replacement provisioning behind provider permission and an explicit adapter method", async () => {
    const target = { ...protectedTarget, providerId: "runpod-main", runpod: { podId: "locked-pod" } };
    const adapter = providerSpy({ reprovisionTarget: vi.fn(async () => ({ runpod: { podId: "replacement" } })) });
    const disabled = new CompositeCapacityProvider({ runpod: adapter }, [{ id: "runpod-main", displayName: "RunPod", type: "runpod" }]);
    await expect(disabled.reprovisionTarget(target)).rejects.toThrow("does not allow replacement provisioning");
    expect(adapter.reprovisionTarget).not.toHaveBeenCalled();

    const deferred = new CompositeCapacityProvider(
      { runpod: new RunPodCapacityProvider() },
      [{ id: "runpod-main", displayName: "RunPod", type: "runpod", provisioning: { enabled: true } }]
    );
    await expect(deferred.reprovisionTarget(target)).rejects.toThrow("does not implement replacement provisioning");
  });

  it("requires and updates a durable target binding before activation can use a replacement", async () => {
    const configured = { ...protectedTarget, runpod: { podId: "old-pod" } };
    const repository = new InMemoryCapacityTargetRepository();
    const runtimeTargets = [{ ...configured }];
    const service = new TargetService(
      [configured],
      repository,
      new ModelCatalog([], runtimeTargets),
      runtimeTargets,
      new InMemoryTargetModelDiscoveryRepository()
    );
    expect(await service.canPersistReplacementPatch(configured.id)).toBe(false);

    await service.copyConfiguredToPersistence(configured.id);
    expect(await service.canPersistReplacementPatch(configured.id)).toBe(true);
    await service.applyReplacementPatch(configured.id, { runpod: { podId: "replacement-pod" } });

    expect((await repository.get(configured.id))?.runpod?.podId).toBe("replacement-pod");
    expect(runtimeTargets[0].runpod?.podId).toBe("replacement-pod");
  });
});

describe("safety configuration", () => {
  it("loads JSON and env-expanded opt-in policies without changing unprotected defaults", async () => {
    process.env.HASSLEOFF_URL = "https://hassleoff.example.test";
    process.env.HASSLEOFF_CONTROLLER_TOKEN = "controller-token";
    process.env.HASSLEOFF_CONTROLLER_ID = "neuron-prod";
    process.env.HASSLEOFF_FAILSAFE_TEST_TARGET_ID = "hassleoff-failsafe-test";
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([{
      id: "rented-a",
      displayName: "Rented A",
      provider: "runpod",
      modelIds: [],
      hassleOff: {
        protected: true,
        leaseDurationSeconds: 90,
        staleTripTestShutdown: { enabled: true, maxAgeSeconds: 7_200 }
      },
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    }]);
    const jsonConfig = await loadConfig();
    expect(jsonConfig.config.hassleOff).toMatchObject({
      baseUrl: "https://hassleoff.example.test",
      controllerId: "neuron-prod",
      failSafeTestTargetId: "hassleoff-failsafe-test"
    });
    expect(jsonConfig.config.capacityTargets[0]).toMatchObject({
      hassleOff: { protected: true, leaseDurationSeconds: 90, staleTripTestShutdown: { enabled: true, maxAgeSeconds: 7_200 } },
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    });

    delete process.env.CAPACITY_TARGETS_JSON;
    process.env.CAPACITY_TARGET_KEYS = "GPU";
    process.env.CAPACITY_TARGET_GPU_DISPLAY_NAME = "GPU";
    process.env.CAPACITY_TARGET_GPU_PROVIDER = "runpod";
    process.env.CAPACITY_TARGET_GPU_HASSLEOFF_PROTECTED = "true";
    process.env.CAPACITY_TARGET_GPU_HASSLEOFF_LEASE_DURATION_SECONDS = "120";
    process.env.CAPACITY_TARGET_GPU_HASSLEOFF_SHUTDOWN_ON_STALE_TRIP_TEST = "true";
    process.env.CAPACITY_TARGET_GPU_HASSLEOFF_TRIP_TEST_MAX_AGE_SECONDS = "3600";
    process.env.CAPACITY_TARGET_GPU_REPROVISION_ON_RECOVERABLE_UNAVAILABLE = "true";
    const envConfig = await loadConfig();
    expect(envConfig.config.capacityTargets[0]).toMatchObject({
      hassleOff: { protected: true, leaseDurationSeconds: 120, staleTripTestShutdown: { enabled: true, maxAgeSeconds: 3_600 } },
      activationPolicy: { reprovisionOnRecoverableUnavailable: true }
    });
  });
});

function providerSpy(overrides: Partial<CapacityProvider> = {}): CapacityProvider & Record<string, ReturnType<typeof vi.fn>> {
  return {
    provisionTarget: vi.fn(async () => undefined),
    ensureTargetOn: vi.fn(async () => undefined),
    ensureTargetOff: vi.fn(async () => undefined),
    getTargetStatus: vi.fn(async (): Promise<CapacityProviderStatus> => ({ observed: "stopped", message: "fake" })),
    forceStopTarget: vi.fn(async () => undefined),
    ...overrides
  } as CapacityProvider & Record<string, ReturnType<typeof vi.fn>>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
