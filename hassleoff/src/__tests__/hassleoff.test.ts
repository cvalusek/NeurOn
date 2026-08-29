import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisteredStopActionExecutor } from "../actions.js";
import { buildHassleOffApp } from "../app.js";
import { loadHassleOffConfig } from "../config.js";
import { InMemoryProviderCredentials } from "../credentials.js";
import type { HassleOffConfig, RegisteredTarget, StopActionExecutor } from "../types.js";

const token = "test-controller-token-123";
const createdDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HASSLEOFF_TEST_RUNPOD_KEY;
  delete process.env.HASSLEOFF_CONTROLLER_TOKEN;
  delete process.env.HASSLEOFF_TARGETS_JSON;
  delete process.env.HASSLEOFF_TARGETS_FILE;
  delete process.env.HASSLEOFF_SQLITE_PATH;
  delete process.env.HASSLEOFF_ALLOW_INSECURE_HTTP;
  delete process.env.HASSLEOFF_TRUST_PROXY;
  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("HassleOff safety path", () => {
  it("rejects unauthenticated protocol calls while exposing health and readiness", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    expect((await harness.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: "GET", url: "/readyz" })).json()).toMatchObject({ ok: true, armed: true });
    expect((await harness.app.inject({ method: "GET", url: "/v1/status" })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: "GET", url: "/v1/status", headers: { authorization: "Bearer wrong-token-value" } })).statusCode).toBe(401);
    await harness.app.close();
  });

  it("expires an exact lease, invokes its registered stop action, and preserves audit state across restart", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    await acceptLease(harness, "rented-a", 2_000);
    expect(harness.stop).not.toHaveBeenCalled();

    harness.advance(2_000);
    await harness.service.tick();

    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.stop.mock.calls[0][0].targetId).toBe("rented-a");
    const beforeRestart = harness.service.status();
    expect(beforeRestart.targets[0].lastTripResult).toMatchObject({ trigger: "lease-expired", outcome: "succeeded" });
    expect(beforeRestart.targets[0].recentDestructiveAudit.some((event) => event.eventType === "provider_stop_succeeded")).toBe(true);
    await harness.app.close();

    const restarted = createHarness([fakeTarget("rented-a")], { databasePath: harness.databasePath });
    const afterRestart = restarted.service.status();
    expect(afterRestart.targets[0].lastTripResult).toMatchObject({ trigger: "lease-expired", outcome: "succeeded" });
    expect(restarted.service.audit("rented-a").some((event) => event.eventType === "provider_stop_succeeded")).toBe(true);
    await restarted.app.close();
  });

  it("keeps a durable armed registration active when restart config accidentally omits it", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    await acceptLease(harness, "rented-a", 2_000);
    await harness.app.close();

    const restarted = createHarness([fakeTarget("hassleoff-failsafe-test", true)], { databasePath: harness.databasePath });
    expect(restarted.service.ready).toBe(false);
    expect(restarted.service.status().service.registrationIssues).toContain("Durable registration rented-a is missing from the configured target registrations");
    restarted.advance(2_000);
    await restarted.service.tick();
    expect(restarted.stop).toHaveBeenCalledTimes(1);
    expect(restarted.stop.mock.calls[0][0].targetId).toBe("rented-a");
    await restarted.app.close();
  });

  it("rejects cross-target lease and shutdown bodies without invoking either target", async () => {
    const harness = createHarness([fakeTarget("rented-a"), fakeTarget("rented-b")]);
    const lease = leaseBody(harness.now(), "rented-b", 2_000);
    const leaseResponse = await harness.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: authHeaders(),
      payload: lease
    });
    expect(leaseResponse.statusCode).toBe(400);

    const shutdownResponse = await harness.app.inject({
      method: "POST",
      url: "/v1/targets/rented-a/shutdown",
      headers: authHeaders(),
      payload: {
        protocolVersion: "1",
        targetId: "rented-b",
        controllerId: "neuron-test",
        requestId: "cross-target",
        reason: "test"
      }
    });
    expect(shutdownResponse.statusCode).toBe(400);
    expect(harness.stop).not.toHaveBeenCalled();
    await harness.app.close();
  });

  it("rejects excessive controller clock skew and an overlapping controller lease", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    const skewedNow = new Date(harness.now().getTime() + 1_000);
    const skewedResponse = await harness.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: authHeaders(),
      payload: leaseBody(skewedNow, "rented-a", 2_000)
    });
    expect(skewedResponse.statusCode).toBe(400);
    expect(skewedResponse.json().error).toContain("clock differs");

    await acceptLease(harness, "rented-a", 2_000);
    const competing = leaseBody(harness.now(), "rented-a", 2_000);
    competing.controllerId = "other-controller";
    competing.leaseId = "other-lease";
    const competingResponse = await harness.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: authHeaders(),
      payload: competing
    });
    expect(competingResponse.statusCode).toBe(409);
    expect(harness.stop).not.toHaveBeenCalled();
    await harness.app.close();
  });

  it("defers an expired lease only until a bounded maintenance hold expires", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    await acceptLease(harness, "rented-a", 2_000);
    const holdUntil = new Date(harness.now().getTime() + 5_000);
    const holdResponse = await harness.app.inject({
      method: "POST",
      url: "/v1/targets/rented-a/maintenance-hold",
      headers: authHeaders(),
      payload: { protocolVersion: "1", targetId: "rented-a", until: holdUntil.toISOString(), reason: "bounded test maintenance" }
    });
    expect(holdResponse.statusCode).toBe(200);

    harness.advance(3_000);
    await harness.service.tick();
    expect(harness.stop).not.toHaveBeenCalled();

    harness.advance(2_000);
    await harness.service.tick();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.service.audit("rented-a").some((event) => event.eventType === "maintenance_hold_expired")).toBe(true);
    await harness.app.close();
  });

  it("runs the complete synthetic fail-safe path and records its last durable success", async () => {
    const harness = createHarness([fakeTarget("hassleoff-failsafe-test", true)]);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/targets/hassleoff-failsafe-test/trip-test",
      headers: authHeaders(),
      payload: { protocolVersion: "1", targetId: "hassleoff-failsafe-test" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ targetId: "hassleoff-failsafe-test", succeeded: true });
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.service.status().lastFullTripTestSucceededAt).toBe(harness.now().toISOString());
    await harness.app.close();

    const restarted = createHarness([fakeTarget("hassleoff-failsafe-test", true)], { databasePath: harness.databasePath });
    expect(restarted.service.status().lastFullTripTestSucceededAt).toBe(harness.now().toISOString());
    expect(restarted.service.audit("hassleoff-failsafe-test").map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "lease_expiry_trip_decided",
      "provider_stop_succeeded",
      "trip_test_succeeded"
    ]));
    await restarted.app.close();
  });

  it("retries a failed idempotent stop after the configured delay and stops retrying after success", async () => {
    let attempts = 0;
    const executor: StopActionExecutor = {
      stop: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic provider failure");
        return { message: "stopped on retry" };
      })
    };
    const harness = createHarness([fakeTarget("rented-a")], { executor });
    await acceptLease(harness, "rented-a", 2_000);
    harness.advance(2_000);
    await harness.service.tick();
    expect(attempts).toBe(1);

    harness.advance(500);
    await harness.service.tick();
    expect(attempts).toBe(1);

    harness.advance(500);
    await harness.service.tick();
    expect(attempts).toBe(2);
    await harness.service.tick();
    expect(attempts).toBe(2);
    expect(harness.service.status().targets[0].lastTripResult).toMatchObject({ outcome: "succeeded", message: "stopped on retry" });
    await harness.app.close();
  });

  it("replays an intentional shutdown request without a second provider action", async () => {
    const harness = createHarness([fakeTarget("rented-a")]);
    const payload = {
      protocolVersion: "1",
      targetId: "rented-a",
      controllerId: "neuron-test",
      requestId: "stable-request-id",
      reason: "stale synthetic test"
    };
    const first = await harness.app.inject({ method: "POST", url: "/v1/targets/rented-a/shutdown", headers: authHeaders(), payload });
    const second = await harness.app.inject({ method: "POST", url: "/v1/targets/rented-a/shutdown", headers: authHeaders(), payload });
    expect(first.json()).toMatchObject({ stopped: true, replayed: false });
    expect(second.json()).toMatchObject({ stopped: true, replayed: true });
    expect(harness.stop).toHaveBeenCalledTimes(1);
    await harness.app.close();
  });

  it("requires HTTPS and an in-memory RunPod credential before accepting a protected lease", async () => {
    const credentials = new InMemoryProviderCredentials();
    const providerRequest = vi.fn(async () => new Response("", { status: 200 }));
    const executor = new RegisteredStopActionExecutor(providerRequest as typeof fetch, credentials);
    const harness = createHarness([runpodTarget("rented-a", "runpod-main")], {
      executor,
      credentials,
      config: { allowInsecureHttp: false, trustProxy: true }
    });

    const insecure = await harness.app.inject({
      method: "PUT",
      url: "/v1/credentials/runpod/runpod-main",
      headers: authHeaders(),
      payload: { protocolVersion: "1", credentialId: "runpod-main", apiKey: "memory-only-secret" }
    });
    expect(insecure.statusCode).toBe(426);

    const missing = await harness.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: { ...authHeaders(), "x-forwarded-proto": "https" },
      payload: leaseBody(harness.now(), "rented-a", 2_000)
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ code: "credential_unavailable" });
    expect(harness.service.ready).toBe(true);

    const supplied = await harness.app.inject({
      method: "PUT",
      url: "/v1/credentials/runpod/runpod-main",
      headers: { ...authHeaders(), "x-forwarded-proto": "https" },
      payload: { protocolVersion: "1", credentialId: "runpod-main", apiKey: "memory-only-secret" }
    });
    expect(supplied.statusCode).toBe(200);
    expect(supplied.json()).toMatchObject({ credentialId: "runpod-main", accepted: true, replaced: false });
    expect(harness.service.ready).toBe(true);

    const accepted = await harness.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: { ...authHeaders(), "x-forwarded-proto": "https" },
      payload: leaseBody(harness.now(), "rented-a", 2_000)
    });
    expect(accepted.statusCode).toBe(200);
    harness.advance(2_000);
    await harness.service.tick();

    expect(providerRequest).toHaveBeenCalledWith(
      "https://rest.runpod.io/v1/pods/pod-exact/stop",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer memory-only-secret" }) })
    );
    expect(JSON.stringify(harness.service.status())).not.toContain("memory-only-secret");
    expect(JSON.stringify(harness.service.audit())).not.toContain("memory-only-secret");
    await harness.app.close();
    expectDatabaseFilesNotToContain(harness.databasePath, "memory-only-secret");
  });

  it("forgets controller-supplied provider credentials on restart and becomes unready until NeurOn resupplies them", async () => {
    const firstCredentials = new InMemoryProviderCredentials();
    const first = createHarness([runpodTarget("rented-a", "runpod-main")], {
      credentials: firstCredentials,
      executor: new RegisteredStopActionExecutor(vi.fn(async () => new Response("", { status: 200 })) as typeof fetch, firstCredentials)
    });
    await first.app.inject({
      method: "PUT",
      url: "/v1/credentials/runpod/runpod-main",
      headers: authHeaders(),
      payload: { protocolVersion: "1", credentialId: "runpod-main", apiKey: "rotated-secret" }
    });
    expect(first.service.ready).toBe(true);
    const accepted = await first.app.inject({
      method: "PUT",
      url: "/v1/targets/rented-a/lease",
      headers: authHeaders(),
      payload: leaseBody(first.now(), "rented-a", 2_000)
    });
    expect(accepted.statusCode).toBe(200);
    await first.app.close();

    const secondCredentials = new InMemoryProviderCredentials();
    const restarted = createHarness([runpodTarget("rented-a", "runpod-main")], {
      databasePath: first.databasePath,
      credentials: secondCredentials,
      executor: new RegisteredStopActionExecutor(vi.fn(async () => new Response("", { status: 200 })) as typeof fetch, secondCredentials)
    });
    expect(restarted.service.ready).toBe(false);
    expect(restarted.service.status().targets[0].credential).toMatchObject({ storage: "memory", available: false });
    await restarted.app.close();
    expectDatabaseFilesNotToContain(restarted.databasePath, "rotated-secret");
  });

  it("upgrades only the legacy credential source when the durable RunPod action scope is otherwise unchanged", async () => {
    const legacy = createHarness([{
      targetId: "rented-a",
      registrationId: "rented-a-v1",
      action: { type: "runpod-stop", podId: "pod-exact", apiKeyEnv: "OLD_RUNPOD_KEY" }
    }]);
    await legacy.app.close();

    const upgraded = createHarness([runpodTarget("rented-a", "runpod-main")], { databasePath: legacy.databasePath });
    expect(upgraded.service.status().service.registrationIssues).toEqual([]);
    expect(upgraded.store.getRegistration("rented-a")?.action).toEqual({
      type: "runpod-stop",
      podId: "pod-exact",
      credentialId: "runpod-main"
    });
    expect(upgraded.service.audit("rented-a").some((event) => event.eventType === "registration_credential_mode_upgraded")).toBe(true);
    await upgraded.app.close();
  });

  it("continues to reject a credential-mode change that also remaps the protected Pod", async () => {
    const legacy = createHarness([{
      targetId: "rented-a",
      registrationId: "rented-a-v1",
      action: { type: "runpod-stop", podId: "pod-original", apiKeyEnv: "OLD_RUNPOD_KEY" }
    }]);
    await legacy.app.close();

    const changed = createHarness([runpodTarget("rented-a", "runpod-main")], { databasePath: legacy.databasePath });
    expect(changed.service.status().service.registrationIssues).toEqual([
      "Registration mismatch for rented-a; the durable registration remains authoritative"
    ]);
    expect(changed.store.getRegistration("rented-a")?.action).toMatchObject({ podId: "pod-original", apiKeyEnv: "OLD_RUNPOD_KEY" });
    await changed.app.close();
  });
});

describe("HassleOff target registration configuration", () => {
  it("keeps inline JSON registrations backward-compatible", () => {
    process.env.HASSLEOFF_CONTROLLER_TOKEN = token;
    process.env.HASSLEOFF_TARGETS_JSON = JSON.stringify([fakeTarget("hassleoff-failsafe-test", true)]);

    expect(loadHassleOffConfig().targets).toMatchObject([{
      targetId: "hassleoff-failsafe-test",
      registrationId: "hassleoff-failsafe-test-v1",
      testOnly: true,
      action: { type: "fake" }
    }]);
  });

  it("loads registrations from a file without requiring JSON inside an environment variable", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hassleoff-config-test-"));
    createdDirectories.push(directory);
    const targetsFile = path.join(directory, "targets.json");
    writeFileSync(targetsFile, JSON.stringify([fakeTarget("hassleoff-failsafe-test", true)]), "utf8");
    process.env.HASSLEOFF_CONTROLLER_TOKEN = token;
    process.env.HASSLEOFF_TARGETS_FILE = targetsFile;
    process.env.HASSLEOFF_SQLITE_PATH = path.join(directory, "configured.db");

    expect(loadHassleOffConfig()).toMatchObject({
      controllerToken: token,
      targets: [{
        targetId: "hassleoff-failsafe-test",
        registrationId: "hassleoff-failsafe-test-v1",
        testOnly: true,
        action: { type: "fake" }
      }]
    });
  });

  it("rejects ambiguous file and inline registration sources", () => {
    process.env.HASSLEOFF_CONTROLLER_TOKEN = token;
    process.env.HASSLEOFF_TARGETS_FILE = "targets.json";
    process.env.HASSLEOFF_TARGETS_JSON = JSON.stringify([fakeTarget("hassleoff-failsafe-test", true)]);

    expect(() => loadHassleOffConfig()).toThrow("Set only one of HASSLEOFF_TARGETS_JSON or HASSLEOFF_TARGETS_FILE");
  });

  it("rejects a plaintext RunPod action endpoint", () => {
    process.env.HASSLEOFF_CONTROLLER_TOKEN = token;
    process.env.HASSLEOFF_TARGETS_JSON = JSON.stringify([{
      ...runpodTarget("rented-a", "runpod-main"),
      action: { ...runpodTarget("rented-a", "runpod-main").action, apiBaseUrl: "http://runpod.invalid/v1" }
    }]);

    expect(() => loadHassleOffConfig()).toThrow("RunPod action apiBaseUrl must use HTTPS");
  });
});

describe("registered provider actions", () => {
  it("uses only the registered RunPod Pod ID and does not expose its credential", async () => {
    process.env.HASSLEOFF_TEST_RUNPOD_KEY = "not-logged-secret";
    const request = vi.fn(async () => new Response("", { status: 200 }));
    const executor = new RegisteredStopActionExecutor(request as typeof fetch);
    const result = await executor.stop({
      targetId: "rented-a",
      registrationId: "rented-a-v1",
      action: { type: "runpod-stop", podId: "pod-exact", apiBaseUrl: "https://runpod.example.test/v1", apiKeyEnv: "HASSLEOFF_TEST_RUNPOD_KEY" }
    }, { targetId: "rented-a", requestId: "request-1", trigger: "lease-expired" });

    expect(request).toHaveBeenCalledWith("https://runpod.example.test/v1/pods/pod-exact/stop", expect.objectContaining({ method: "POST" }));
    expect(JSON.stringify(result)).not.toContain("not-logged-secret");
  });

  it("does not persist or return a provider response body", async () => {
    process.env.HASSLEOFF_TEST_RUNPOD_KEY = "not-logged-secret";
    const executor = new RegisteredStopActionExecutor(
      vi.fn(async () => new Response("provider-debug-secret", { status: 502 })) as typeof fetch
    );

    await expect(executor.stop({
      targetId: "rented-a",
      registrationId: "rented-a-v1",
      action: { type: "runpod-stop", podId: "pod-exact", apiBaseUrl: "https://runpod.example.test/v1", apiKeyEnv: "HASSLEOFF_TEST_RUNPOD_KEY" }
    }, { targetId: "rented-a", requestId: "request-1", trigger: "lease-expired" }))
      .rejects.toThrow("RunPod stop returned HTTP 502");
  });
});

function createHarness(
  targets: RegisteredTarget[],
  options: {
    databasePath?: string;
    executor?: StopActionExecutor;
    credentials?: InMemoryProviderCredentials;
    config?: Partial<HassleOffConfig>;
  } = {}
) {
  const directory = options.databasePath ? path.dirname(options.databasePath) : mkdtempSync(path.join(tmpdir(), "hassleoff-test-"));
  if (!createdDirectories.includes(directory)) createdDirectories.push(directory);
  const databasePath = options.databasePath ?? path.join(directory, "hassleoff.db");
  let current = new Date("2026-07-13T12:00:00.000Z");
  const stop = vi.fn(async () => ({ message: "fake stop completed" }));
  const executor = options.executor ?? { stop };
  const config: HassleOffConfig = {
    port: 8091,
    controllerToken: token,
    databasePath,
    targets,
    checkIntervalMs: 100,
    maxClockSkewMs: 500,
    minLeaseMs: 1_000,
    maxLeaseMs: 10_000,
    maxMaintenanceHoldMs: 10_000,
    failedActionRetryMs: 1_000,
    allowInsecureHttp: true,
    trustProxy: false,
    ...options.config
  };
  const built = buildHassleOffApp(config, {
    actionExecutor: executor,
    credentials: options.credentials,
    clock: () => current,
    logger: false
  });
  return {
    ...built,
    databasePath,
    stop: (executor.stop as ReturnType<typeof vi.fn>),
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    }
  };
}

async function acceptLease(harness: ReturnType<typeof createHarness>, targetId: string, durationMs: number) {
  const response = await harness.app.inject({
    method: "PUT",
    url: `/v1/targets/${targetId}/lease`,
    headers: authHeaders(),
    payload: leaseBody(harness.now(), targetId, durationMs)
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ accepted: true, armed: true, targetArmed: true, targetId });
}

function leaseBody(now: Date, targetId: string, durationMs: number) {
  return {
    protocolVersion: "1",
    targetId,
    controllerId: "neuron-test",
    leaseId: `lease-${targetId}`,
    sequence: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString()
  };
}

function fakeTarget(targetId: string, testOnly = false): RegisteredTarget {
  return { targetId, registrationId: `${targetId}-v1`, testOnly, action: { type: "fake" } };
}

function runpodTarget(targetId: string, credentialId: string): RegisteredTarget {
  return {
    targetId,
    registrationId: `${targetId}-v1`,
    action: { type: "runpod-stop", podId: "pod-exact", credentialId }
  };
}

function authHeaders() {
  return { authorization: `Bearer ${token}` };
}

function expectDatabaseFilesNotToContain(databasePath: string, value: string): void {
  const databaseName = path.basename(databasePath);
  for (const file of readdirSync(path.dirname(databasePath)).filter((candidate) => candidate.startsWith(databaseName))) {
    expect(readFileSync(path.join(path.dirname(databasePath), file)).includes(Buffer.from(value))).toBe(false);
  }
}
