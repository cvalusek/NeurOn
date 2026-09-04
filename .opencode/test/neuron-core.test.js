// Unit tests for the shared NeurOn core (../../shared/neuron-core).
// Fake-fetch pattern mirrors test/neuron.test.js: globalThis.fetch is
// swapped for a route table, and assertions target the exact payload
// contracts the control plane relies on.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  matchesAllowedProvider,
  splitProvider,
  canonicalizeModel,
  matchLiteLlmModel,
  findTargetStatus,
  NeurOnClient,
  NeurOnApiError,
  getCachedStatus,
  invalidateStatusCache,
  ensureReservation,
  resolveTargetForModel,
  reserveOrRefreshTarget,
  adoptExistingReservation,
  saveReservation,
  currentSessionGeneration,
  isSessionGenerationCurrent,
  invalidateSessionGeneration,
  markActivity,
  isSessionActive,
  effectiveKeepaliveMinutes,
  keepaliveIntervalMs,
  isExtendDue,
  formatClock,
  formatWarmupTimeoutMs
} from "../../shared/neuron-core/index.js";

const originalFetch = globalThis.fetch;

function jsonResponse(data) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}

// Route-table fetch: entries are { path, method?, respond? | body? | error? | response? }.
function installFetch(routes) {
  const calls = { requests: [], extendBodies: [], createBodies: [] };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.requests.push(path);
    // Username discovery (adoption scoping) — always available in tests.
    if (path === "/api/me") return jsonResponse({ username: TEST_USERNAME, isAdmin: false });
    const route = routes.find((r) => r.path === path && (!r.method || options.method === r.method));
    if (!route) throw new Error(`unexpected fetch in core test: ${path}`);
    if (route.respond) return route.respond(options);
    if (route.error instanceof Error) throw route.error;
    if (route.response) return route.response;
    if (options.method === "POST" && path.endsWith("/extend")) calls.extendBodies.push(JSON.parse(options.body ?? "null"));
    if (options.method === "POST" && path === "/api/reservations") calls.createBodies.push(JSON.parse(options.body ?? "null"));
    return jsonResponse(route.body ?? {});
  };
  return calls;
}

function makeCoreState() {
  return {
    reservations: new Map(),
    inflight: new Map(),
    inflightTarget: new Map(),
    retryState: new Map(),
    sessionActivity: new Map(),
    sessionGenerations: new Map(),
    statusCache: { value: null, at: 0, inflight: null }
  };
}

const silentLog = () => {};
function makeDeps(overrides = {}) {
  return {
    log: silentLog,
    armKeepalive: () => {},
    ...overrides
  };
}

function makeConfig(overrides = {}) {
  return {
    apiBaseUrl: "http://neuron.test:8090",
    apiKey: "test-key",
    durationMinutes: 2,
    keepaliveMinutes: 2,
    waitForHealthy: false,
    waitTimeoutMs: 1000,
    pollMs: 1,
    requestTimeoutMs: 500,
    preflightTimeoutMs: 20,
    strictProviderMatch: false,
    retryMaxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 8000,
    ...overrides
  };
}

function makeStatus(observed = "healthy", { activeReservation } = {}) {
  return {
    capacityTargets: [
      {
        id: "t1",
        modelIds: ["t1"],
        provider: "litellm",
        observed
      }
    ],
    models: [],
    activeReservations: activeReservation ? [activeReservation] : [],
    reservations: []
  };
}

// The control-plane username for the test API key. Adoption scoping compares
// this against res.username, so the fake /api/me and makeReservation must
// agree.
const TEST_USERNAME = "testuser";

function makeReservation(reservationId = "r1", username = TEST_USERNAME) {
  return {
    reservationId,
    username,
    createdAt: new Date().toISOString(),
    durationMinutes: 2,
    keepaliveMinutes: 2,
    status: "active",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    targets: [{ id: "t1", observed: "healthy" }]
  };
}

beforeEach(() => {
  // Fresh fetch for every test unless the test installs its own.
  globalThis.fetch = async () => {
    throw new Error("fetch not installed in core test");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("neuron-core config loading", () => {
  it("parses env values, trims the base URL, and splits the provider filter", () => {
    const cfg = loadConfig({
      NEURON_API_BASE_URL: "http://neuron.test:8090/",
      NEURON_API_KEY: "k",
      NEURON_ALLOWED_PROVIDERS: "litellm, openai ,",
      NEURON_RESERVATION_DURATION_MINUTES: "5",
      NEURON_RESERVATION_KEEPALIVE_MINUTES: "3",
      NEURON_WAIT_TIMEOUT_SECONDS: "40",
      NEURON_WAIT_POLL_SECONDS: "2",
      NEURON_WAIT_FOR_HEALTHY: "false",
      NEURON_STRICT_PROVIDER_MATCH: "1",
      NEURON_BYPASS_MESSAGE_HOOK: "true"
    });
    assert.equal(cfg.apiBaseUrl, "http://neuron.test:8090");
    assert.equal(cfg.apiKey, "k");
    assert.deepEqual(cfg.allowedProviders, ["litellm", "openai"]);
    assert.equal(cfg.durationMinutes, 5);
    assert.equal(cfg.keepaliveMinutes, 3);
    assert.equal(cfg.waitTimeoutMs, 40000);
    assert.equal(cfg.pollMs, 2000);
    assert.equal(cfg.waitForHealthy, false);
    assert.equal(cfg.strictProviderMatch, true);
    assert.equal(cfg.bypassMessageHook, true);
    // Unset knobs keep their defaults.
    assert.equal(cfg.retryMaxAttempts, 3);
    assert.equal(cfg.requestTimeoutMs, 8000);
    assert.equal(cfg.preflightTimeoutMs, 2000);
    assert.equal(cfg.cooldownPeriodMs, 30000);
    assert.equal(cfg.retryBaseMs, 1000);
    assert.equal(cfg.retryMaxMs, 8000);
    assert.equal(cfg.blockOnColdMessage, false);
    assert.equal(cfg.warmupLockTimeoutMs, 60000);
  });

  it("falls back to documented defaults when env is empty", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.apiBaseUrl, "http://localhost:8090");
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.durationMinutes, 2);
    assert.equal(cfg.keepaliveMinutes, 2);
    assert.equal(cfg.waitTimeoutMs, 600000);
    assert.equal(cfg.pollMs, 5000);
    assert.equal(cfg.waitForHealthy, true);
    assert.deepEqual(cfg.allowedProviders, []);
    assert.equal(cfg.bypassMessageHook, false);
  });

  it("rejects a non-http base URL", () => {
    assert.throws(
      () => loadConfig({ NEURON_API_BASE_URL: "ftp://invalid" }),
      /NEURON_API_BASE_URL must be a valid http:\/\/ or https:\/\/ URL/
    );
  });

  it("falls back on invalid numeric values (non-positive or non-numeric)", () => {
    const cfg = loadConfig({
      NEURON_RESERVATION_DURATION_MINUTES: "abc",
      NEURON_RESERVATION_KEEPALIVE_MINUTES: "0",
      NEURON_WAIT_TIMEOUT_SECONDS: "-5"
    });
    assert.equal(cfg.durationMinutes, 2);
    assert.equal(cfg.keepaliveMinutes, 2);
    assert.equal(cfg.waitTimeoutMs, 600000);
  });
});

describe("neuron-core allowed-provider matching", () => {
  it("matches everything when the filter is empty", () => {
    assert.equal(matchesAllowedProvider("openai", "openai/m", [], silentLog), true);
    assert.equal(matchesAllowedProvider(undefined, "m", [], silentLog), true);
  });

  it("matches an explicit provider case-insensitively", () => {
    assert.equal(matchesAllowedProvider("OpenAI", "OpenAI/m", ["openai"], silentLog), true);
  });

  it("matches a provider-prefixed model id when no provider is given", () => {
    assert.equal(matchesAllowedProvider(undefined, "openai/gemma", ["openai"], silentLog), true);
  });

  it("skips disallowed providers and logs the skip", () => {
    const logs = [];
    const log = (m) => logs.push(m);
    assert.equal(matchesAllowedProvider("local-a", "local-a/local-model", ["openai"], log), false);
    assert.deepEqual(logs, [
      "allowed-provider skip: provider=local-a model=local-a/local-model allowed=openai"
    ]);
  });

  it("skips un-prefixed models without a matching provider prefix and logs the skip", () => {
    const logs = [];
    const log = (m) => logs.push(m);
    assert.equal(matchesAllowedProvider(undefined, "other/local-model", ["openai"], log), false);
    assert.deepEqual(logs, [
      "allowed-provider skip: provider=none model=other/local-model allowed=openai"
    ]);
  });
});

describe("neuron-core client payload contracts", () => {
  it("merges /api/status and /api/models in getStatus", async () => {
    const calls = installFetch([
      { path: "/api/status", body: { capacityTargets: [{ id: "t1" }] } },
      { path: "/api/models", body: { models: [{ id: "m1" }] } }
    ]);
    const client = new NeurOnClient(makeConfig());
    const status = await client.getStatus();
    assert.deepEqual(status.capacityTargets, [{ id: "t1" }]);
    assert.deepEqual(status.models, [{ id: "m1" }]);
    assert.deepEqual(calls.requests.sort(), ["/api/models", "/api/status"]);
  });

  it("sends modelIds, targetIds, config duration + keepalive in createReservation", async () => {
    const calls = installFetch([
      { path: "/api/reservations", method: "POST", body: makeReservation() }
    ]);
    const client = new NeurOnClient(makeConfig());
    await client.createReservation({ modelIds: ["m1"], targetIds: ["t1"] });
    assert.deepEqual(calls.createBodies, [
      { modelIds: ["m1"], targetIds: ["t1"], durationMinutes: 2, keepaliveMinutes: 2 }
    ]);
  });

  it("sends fromNow:true with the config duration in refreshReservation", async () => {
    const calls = installFetch([
      { path: "/api/reservations/r1/extend", method: "POST", body: makeReservation() }
    ]);
    const client = new NeurOnClient(makeConfig());
    await client.refreshReservation("r1");
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 2, fromNow: true }]);
  });

  it("sends the caller-supplied additive payload in extendReservation (fromNow:false)", async () => {
    const calls = installFetch([
      { path: "/api/reservations/r1/extend", method: "POST", body: makeReservation() }
    ]);
    const client = new NeurOnClient(makeConfig({ durationMinutes: 2 }));
    await client.extendReservation("r1", 10, { fromNow: false });
    // Additive manual extend: caller minutes, fromNow:false — never the
    // config duration, never fromNow:true.
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 10, fromNow: false }]);
  });

  it("sends the bearer token and json content type on requests with a body", async () => {
    let seenHeaders;
    globalThis.fetch = async (url, options) => {
      seenHeaders = options.headers;
      return jsonResponse({});
    };
    const client = new NeurOnClient(makeConfig());
    // GET (no body): no content-type header.
    await client.request("/api/status");
    assert.equal(seenHeaders.authorization, "Bearer test-key");
    assert.equal(seenHeaders["content-type"], undefined);
    // POST (with body): content-type is set.
    await client.request("/api/reservations", { method: "POST", body: "{}" });
    assert.equal(seenHeaders["content-type"], "application/json");
  });

  it("surfaces non-OK responses as NeurOnApiError with .status and verbatim .body", async () => {
    installFetch([
      { path: "/api/status", response: new Response("duration must be between 1 and 720 minutes", { status: 400 }) }
    ]);
    const client = new NeurOnClient(makeConfig());
    await assert.rejects(
      () => client.request("/api/status"),
      (err) => {
        assert.ok(err instanceof NeurOnApiError);
        assert.equal(err.status, 400);
        assert.equal(err.body, "duration must be between 1 and 720 minutes");
        assert.equal(err.message, "NeurOn API 400 for /api/status: duration must be between 1 and 720 minutes");
        return true;
      }
    );
  });

  it("falls back to statusText when the error body is empty", async () => {
    installFetch([
      { path: "/api/status", response: new Response("", { status: 404, statusText: "Not Found" }) }
    ]);
    const client = new NeurOnClient(makeConfig());
    await assert.rejects(
      () => client.request("/api/status"),
      (err) => {
        assert.ok(err instanceof NeurOnApiError);
        assert.equal(err.status, 404);
        assert.equal(err.body, "Not Found");
        return true;
      }
    );
  });

  it("maps aborts to a status-0 timeout error", async () => {
    installFetch([
      {
        path: "/api/status",
        error: (() => { const e = new Error("aborted"); e.name = "AbortError"; return e; })()
      }
    ]);
    const client = new NeurOnClient(makeConfig());
    await assert.rejects(
      () => client.request("/api/status"),
      (err) => {
        assert.ok(err instanceof NeurOnApiError);
        assert.equal(err.status, 0);
        assert.equal(err.body, "Request timed out");
        return true;
      }
    );
  });

  it("maps unparsable bodies to a status-0 invalid_json error", async () => {
    installFetch([
      { path: "/api/status", response: new Response("<html>nope</html>", { status: 200 }) }
    ]);
    const client = new NeurOnClient(makeConfig());
    await assert.rejects(
      () => client.request("/api/status"),
      (err) => {
        assert.ok(err instanceof NeurOnApiError);
        assert.equal(err.status, 0);
        assert.equal(err.body, "Failed to parse response: <html>nope</html>");
        return true;
      }
    );
  });

  it("requires an API key before touching the network", async () => {
    const calls = installFetch([
      { path: "/api/status", body: {} }
    ]);
    const client = new NeurOnClient(makeConfig({ apiKey: undefined }));
    await assert.rejects(
      () => client.request("/api/status"),
      /NEURON_API_KEY is required for the NeurOn OpenCode plugin/
    );
    assert.equal(calls.requests.length, 0);
  });

  it("waitForHealthy resolves on healthy, invoking the injected cache invalidation", async () => {
    const calls = installFetch([
      { path: "/api/reservations/r1/status", body: { reservationId: "r1", targets: [{ id: "t1", observed: "healthy" }] } }
    ]);
    let invalidated = 0;
    const client = new NeurOnClient(makeConfig());
    const result = await client.waitForHealthy("r1", () => { invalidated += 1; });
    assert.equal(result.reservationId, "r1");
    assert.equal(calls.requests.length, 1);
    assert.equal(invalidated, 1);
  });

  it("waitForHealthy polls until healthy", async () => {
    let n = 0;
    installFetch([
      {
        path: "/api/reservations/r1/status",
        respond: () => jsonResponse({
          reservationId: "r1",
          targets: [{ id: "t1", observed: ++n < 3 ? "warming" : "healthy" }]
        })
      }
    ]);
    const client = new NeurOnClient(makeConfig({ waitTimeoutMs: 1000, pollMs: 1 }));
    const result = await client.waitForHealthy("r1");
    assert.equal(result.targets[0].observed, "healthy");
  });

  it("waitForHealthy throws on a failed target", async () => {
    installFetch([
      {
        path: "/api/reservations/r1/status",
        body: { reservationId: "r1", targets: [{ id: "t1", observed: "failed", message: "crash loop" }] }
      }
    ]);
    const client = new NeurOnClient(makeConfig());
    await assert.rejects(
      () => client.waitForHealthy("r1"),
      /NeurOn target t1 failed: crash loop/
    );
  });

  it("waitForHealthy times out with the last observed states", async () => {
    installFetch([
      { path: "/api/reservations/r1/status", body: { reservationId: "r1", targets: [{ id: "t1", observed: "warming" }] } }
    ]);
    const client = new NeurOnClient(makeConfig({ waitTimeoutMs: 60, pollMs: 10 }));
    await assert.rejects(
      () => client.waitForHealthy("r1"),
      /Timed out waiting for NeurOn reservation r1 to become healthy \(t1:warming\)/
    );
  });
});

describe("neuron-core model → target resolution", () => {
  const ROUTE = "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL";
  const targets = [
    { id: ROUTE, modelIds: [ROUTE], provider: "litellm", observed: "healthy" },
    { id: "t2", modelIds: ["gemma-4-26b-a4b"], provider: "openai", observed: "cold" }
  ];
  const models = [
    { id: "gemma-4-26b-a4b", aliases: ["gemma-4"], backendModelIds: ["gemma-4-26b-a4b"], targetIds: ["t2"] }
  ];

  it("matches a litellm route name directly against the target registry", () => {
    const match = matchLiteLlmModel(targets, models, ROUTE, undefined);
    assert.deepEqual(match, { modelIds: [ROUTE], targetIds: [ROUTE] });
  });

  it("resolves registry models via alias to their target", () => {
    const match = matchLiteLlmModel(targets, models, "gemma-4", undefined);
    assert.deepEqual(match, { modelIds: ["gemma-4-26b-a4b"], targetIds: ["t2"] });
  });

  it("resolves registry models with an explicit matching provider", () => {
    const match = matchLiteLlmModel(targets, models, "gemma-4", "openai");
    assert.deepEqual(match, { modelIds: ["gemma-4-26b-a4b"], targetIds: ["t2"] });
  });

  it("returns undefined for a model no target hosts (unmanaged)", () => {
    assert.equal(matchLiteLlmModel(targets, models, "some-other-model", undefined), undefined);
  });

  it("matches the target id itself (pass 3) when no model id matches", () => {
    const withT3 = [...targets, { id: "t3", modelIds: [], provider: "litellm" }];
    const match = matchLiteLlmModel(withT3, models, "t3", undefined);
    assert.deepEqual(match, { targetIds: ["t3"] });
  });

  it("reports a provider_mapping_error when the provider hosts the model nowhere", () => {
    const twoProviders = [
      { id: "a", modelIds: ["m"], provider: "openai" },
      { id: "b", modelIds: ["m"], provider: "anthropic" }
    ];
    const m = [{ id: "m", targetIds: ["a", "b"] }];
    // Non-strict: the two foreign hosts make it a mapping ambiguity…
    const loose = matchLiteLlmModel(twoProviders, m, "m", "google");
    assert.equal(loose.error, "provider_mapping_error");
    assert.match(loose.detail, /is on multiple NeurOn providers \(openai, anthropic\)/);
    // Strict: no fallback target is acceptable → explicit not-found.
    const strict = matchLiteLlmModel(twoProviders, m, "m", "google", true);
    assert.equal(strict.error, "provider_mapping_error");
    assert.match(strict.detail, /not found on provider "google"/);
  });

  it("reports ambiguous_model_mapping when no provider is given and several host the model", () => {
    const twoProviders = [
      { id: "a", modelIds: ["m"], provider: "openai" },
      { id: "b", modelIds: ["m"], provider: "anthropic" }
    ];
    const m = [{ id: "m", targetIds: ["a", "b"] }];
    const match = matchLiteLlmModel(twoProviders, m, "m", undefined);
    assert.equal(match.error, "ambiguous_model_mapping");
    assert.match(match.detail, /Specify provider explicitly/);
  });

  it("splits provider prefixes from model ids", () => {
    assert.deepEqual(splitProvider("openai/gemma"), { provider: "openai", bareModelId: "gemma" });
    assert.deepEqual(splitProvider("gemma"), { provider: undefined, bareModelId: "gemma" });
    assert.deepEqual(splitProvider("/x"), { provider: undefined, bareModelId: "/x" });
    assert.deepEqual(splitProvider("a/"), { provider: undefined, bareModelId: "a/" });
  });

  it("canonicalizes provider/model ids without re-splitting target hints", () => {
    assert.deepEqual(
      canonicalizeModel("openai", "openai/target/model"),
      { provider: "openai", bareModelId: "target/model", fullModel: "openai/target/model" }
    );
    assert.deepEqual(
      canonicalizeModel("openai", "target/model"),
      { provider: "openai", bareModelId: "target/model", fullModel: "openai/target/model" }
    );
    assert.deepEqual(
      canonicalizeModel(undefined, "openai/gemma"),
      { provider: "openai", bareModelId: "gemma", fullModel: "openai/gemma" }
    );
  });

  it("finds the target entry inside a status", () => {
    assert.equal(findTargetStatus(targets, "t2").observed, "cold");
    assert.equal(findTargetStatus(targets, "nope"), undefined);
  });
});

describe("neuron-core regression: exact litellm route gating (Qwen3.8-27B)", () => {
  // The full OpenCode model id, e.g.
  // litellm/g7e.2xlarge.general/unsloth/Qwen3.8-27B-GGUF:Q6_K_XL
  const FULL_MODEL = "litellm/g7e.2xlarge.general/unsloth/Qwen3.8-27B-GGUF:Q6_K_XL";
  const EXACT_TARGET = "g7e.2xlarge.general";
  const EXACT_ROUTE = `${EXACT_TARGET}/unsloth/Qwen3.8-27B-GGUF:Q6_K_XL`;
  // A foreign (homellm) target hosting the same route-shaped model id.
  const FOREIGN_TARGET = "hml.g7e.2xlarge.qwen38";
  const FOREIGN_ROUTE = `${FOREIGN_TARGET}/unsloth/Qwen3.8-27B-GGUF:Q6_K_XL`;
  const split = { provider: "litellm", bareModelId: FULL_MODEL.slice("litellm/".length) };

  it("resolves the exact model only to g7e.2xlarge.general when that target is present", () => {
    const targets = [
      { id: EXACT_TARGET, modelIds: [EXACT_ROUTE], provider: "litellm", observed: "cold" },
      { id: FOREIGN_TARGET, modelIds: [FOREIGN_ROUTE], provider: "homellm", observed: "healthy" }
    ];
    const models = [];
    const match = matchLiteLlmModel(targets, models, split.bareModelId, split.provider, true);
    assert.deepEqual(match, { modelIds: [split.bareModelId], targetIds: [EXACT_TARGET] });
  });

  it("returns provider_mapping_error (not a foreign target) when the exact target is absent and strict matching is on", () => {
    const targets = [
      { id: FOREIGN_TARGET, modelIds: [FOREIGN_ROUTE], provider: "homellm", observed: "healthy" }
    ];
    const models = [];
    const match = matchLiteLlmModel(targets, models, split.bareModelId, split.provider, true);
    assert.equal(match.error, "provider_mapping_error");
    assert.match(match.detail, /not found on provider "litellm"/);
    // Never silently route to the foreign target.
    assert.equal(match.targetIds, undefined);
  });

  it("resolves the exact target when both litellm and foreign targets are present (strict)", () => {
    const targets = [
      { id: FOREIGN_TARGET, modelIds: [FOREIGN_ROUTE], provider: "homellm", observed: "healthy" },
      { id: EXACT_TARGET, modelIds: [EXACT_ROUTE], provider: "litellm", observed: "stopped" }
    ];
    const models = [];
    const match = matchLiteLlmModel(targets, models, split.bareModelId, split.provider, true);
    assert.deepEqual(match, { modelIds: [split.bareModelId], targetIds: [EXACT_TARGET] });
  });
});

describe("neuron-core ensure-reservation flow", () => {
  function setup({ observed = "healthy", activeReservation } = {}) {
    const state = makeCoreState();
    const armCalls = [];
    const deps = makeDeps({
      armKeepalive: (...args) => armCalls.push(args)
    });
    const status = makeStatus(observed, { activeReservation });
    // installFetch records create/extend bodies itself; routes only answer.
    const calls = installFetch([
      { path: "/api/status", body: status },
      { path: "/api/models", body: { models: [] } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/extend", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r-remote/extend", method: "POST", body: makeReservation("r-remote") }
    ]);
    const client = new NeurOnClient(makeConfig());
    return { state, deps, armCalls, calls, client, status };
  }

  it("creates a reservation when none is active", async () => {
    const { state, deps, armCalls, calls, client } = setup({ observed: "healthy" });
    const reservation = await ensureReservation(client, state, "t1", "s1", deps);

    assert.equal(reservation.reservationId, "r1");
    const entry = state.reservations.get("s1::t1");
    assert.ok(entry, "the created reservation must be saved locally");
    assert.equal(entry.reservation.reservationId, "r1");
    assert.ok(entry.expiresAt > Date.now() + 90000 && entry.expiresAt <= Date.now() + 121000);
    // One create, no extend.
    assert.equal(calls.createBodies.length, 1);
    assert.deepEqual(calls.createBodies[0], { modelIds: ["t1"], targetIds: ["t1"], durationMinutes: 2, keepaliveMinutes: 2 });
    assert.equal(calls.extendBodies.length, 0);
    // The keepalive arm was handed to the adapter (restart=true, generation 0).
    assert.equal(armCalls.length, 1);
    assert.deepEqual(armCalls[0].slice(0, 3), ["s1::t1", "t1", "s1"]);
    assert.equal(armCalls[0][5], true);
  });

  it("adopts an existing active reservation and refreshes it (no create)", async () => {
    const { state, deps, calls, client } = setup({
      observed: "healthy",
      activeReservation: makeReservation("r-remote")
    });
    const result = await ensureReservation(client, state, "t1", "s1", deps);

    assert.equal(result.reservationId, "r-remote");
    assert.equal(state.reservations.get("s1::t1").reservation.reservationId, "r-remote");
    // Adoption: zero creates, exactly one keepalive refresh (fromNow:true,
    // config duration) for the adopted reservation.
    assert.equal(calls.createBodies.length, 0);
    assert.equal(calls.extendBodies.length, 1);
    assert.deepEqual(calls.extendBodies[0], { durationMinutes: 2, fromNow: true });
  });

  it("never writes state for a stale session generation (adopt path)", async () => {
    const { state, deps, client, status } = setup({
      observed: "healthy",
      activeReservation: makeReservation("r-remote")
    });
    // The session was deleted (generation bumped) while this work was in flight.
    state.sessionGenerations.set("s1", 1);
    const adopted = await adoptExistingReservation(client, state, "t1", status, "s1", 0, deps);
    assert.equal(adopted, null);
    assert.equal(state.reservations.size, 0);
  });

  it("never creates a reservation for a stale session generation", async () => {
    const state = makeCoreState();
    const armCalls = [];
    const deps = makeDeps({ armKeepalive: (...args) => armCalls.push(args) });
    installFetch([
      { path: "/api/status", body: makeStatus("healthy") },
      { path: "/api/models", body: { models: [] } },
      { path: "/api/reservations", method: "POST", body: makeReservation() }
    ]);
    const client = new NeurOnClient(makeConfig());
    // The caller captured generation 0; the session was deleted afterwards.
    invalidateSessionGeneration(state, "s2");
    const created = await reserveOrRefreshTarget(
      client, state, "t1", { modelIds: ["t1"], targetIds: ["t1"] }, "s2", 0, deps
    );
    assert.equal(created, undefined);
    assert.equal(state.reservations.size, 0);
    assert.equal(armCalls.length, 0);
  });

  it("drops the local reservation when the post-create healthy wait fails", async () => {
    const state = makeCoreState();
    const deps = makeDeps();
    installFetch([
      { path: "/api/status", body: makeStatus("healthy") },
      { path: "/api/models", body: { models: [] } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      {
        path: "/api/reservations/r1/status",
        body: { reservationId: "r1", targets: [{ id: "t1", observed: "failed", message: "crash loop" }] }
      }
    ]);
    const client = new NeurOnClient(makeConfig({ waitForHealthy: true }));
    await assert.rejects(
      () => ensureReservation(client, state, "t1", "s3", deps),
      /NeurOn target t1 failed: crash loop/
    );
    assert.equal(state.reservations.size, 0);
  });

  it("dedups concurrent ensure calls for the same session+model", async () => {
    const { state, deps, calls, client } = setup({ observed: "healthy" });
    const [a, b] = await Promise.all([
      ensureReservation(client, state, "t1", "s4", deps),
      ensureReservation(client, state, "t1", "s4", deps)
    ]);
    assert.equal(a, b);
    assert.equal(calls.createBodies.length, 1);
  });

  it("tracks and bumps session generations (stale-work guards)", () => {
    const state = makeCoreState();
    const logs = [];
    assert.equal(currentSessionGeneration(state, "s1"), 0);
    assert.equal(isSessionGenerationCurrent(state, "s1", 0, (m) => logs.push(m)), true);
    invalidateSessionGeneration(state, "s1");
    assert.equal(currentSessionGeneration(state, "s1"), 1);
    assert.equal(isSessionGenerationCurrent(state, "s1", 0, (m) => logs.push(m)), false);
    assert.equal(isSessionGenerationCurrent(state, "s1", 1, (m) => logs.push(m)), true);
    // A missed capture fails closed and logs.
    assert.equal(isSessionGenerationCurrent(state, "s1", undefined, (m) => logs.push(m)), false);
    assert.deepEqual(logs, [
      "isSessionGenerationCurrent: generation not captured (failing closed) session=s1"
    ]);
  });

  it("resolveTargetForModel throws the mapping error for unmanaged models", async () => {
    const { state, deps, client } = setup({ observed: "healthy" });
    await assert.rejects(
      () => resolveTargetForModel(client, state, "unknown-model", "s5", 0, deps),
      /NeurOn could not map OpenCode model "unknown-model" to a capacity target/
    );
  });

  it("saveReservation recomputes expiry from the reservation's keepalive minutes", () => {
    const state = makeCoreState();
    const deps = makeDeps();
    const client = new NeurOnClient(makeConfig());
    const before = Date.now();
    saveReservation(client, state, "t1", { reservationId: "r9", keepaliveMinutes: 5 }, "s6", 0, deps);
    const entry = state.reservations.get("s6::t1");
    assert.ok(entry.expiresAt >= before + 5 * 60 * 1000 && entry.expiresAt <= Date.now() + 5 * 60 * 1000);
  });

  it("caches the status within the TTL and refetches after invalidation", async () => {
    let n = 0;
    globalThis.fetch = async (url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      n += 1;
      return jsonResponse(path === "/api/status" ? { capacityTargets: [] } : { models: [] });
    };
    const state = makeCoreState();
    const client = new NeurOnClient(makeConfig());
    await getCachedStatus(state.statusCache, client);
    await getCachedStatus(state.statusCache, client); // served from cache
    assert.equal(n, 2); // one /api/status + one /api/models
    invalidateStatusCache(state.statusCache);
    await getCachedStatus(state.statusCache, client); // refetched
    assert.equal(n, 4);
  });
});

describe("neuron-core keepalive policy arithmetic", () => {
  it("keeps the effective lifetime at half the reservation, floored at 30s", () => {
    assert.equal(keepaliveIntervalMs(2), 60000); // 2m → 1m
    assert.equal(keepaliveIntervalMs(1), 30000); // 1m → 30s
    assert.equal(keepaliveIntervalMs(0.5), 30000); // 30s → floor 30s
    assert.equal(keepaliveIntervalMs(0.4), 30000); // 24s → floor 30s
    assert.equal(keepaliveIntervalMs(120), 3600000); // 120m → 60m
  });

  it("reads the keepalive lifetime from the reservation with the config default fallback", () => {
    assert.equal(effectiveKeepaliveMinutes({ keepaliveMinutes: 3 }), 3);
    assert.equal(effectiveKeepaliveMinutes({ durationMinutes: 5 }), 5);
    assert.equal(effectiveKeepaliveMinutes({}), 2);
  });

  it("isExtendDue fires at (not before) half the lifetime, with the 30s floor", () => {
    const now = 1_000_000;
    // 2m lifetime → due at 60s.
    assert.equal(isExtendDue(now, now - 60000, 120000), true);
    assert.equal(isExtendDue(now, now - 59999, 120000), false);
    // 20s lifetime → the 30s floor wins, due at 30s.
    assert.equal(isExtendDue(now, now - 30000, 20000), true);
    assert.equal(isExtendDue(now, now - 29999, 20000), false);
  });

  it("isSessionActive uses the keepalive grace window", () => {
    const state = makeCoreState();
    const client = new NeurOnClient(makeConfig({ keepaliveMinutes: 2 }));
    assert.equal(isSessionActive(state, "s1", client), false); // no activity recorded
    markActivity(state, "s1");
    assert.equal(isSessionActive(state, "s1", client), true);
    state.sessionActivity.set("s1", Date.now() - 3 * 60 * 1000); // beyond the 2m grace
    assert.equal(isSessionActive(state, "s1", client), false);
    // An empty session id is a no-op.
    const empty = makeCoreState();
    markActivity(empty, undefined);
    assert.equal(empty.sessionActivity.size, 0);
  });
});

describe("neuron-core time formatting", () => {
  it("formats Date and ISO values as a local 12-hour wall clock", () => {
    assert.equal(formatClock(new Date(2026, 0, 2, 15, 7, 42)), "3:07:42 PM");
    assert.equal(formatClock(new Date(2026, 0, 2, 3, 7, 42)), "3:07:42 AM");
    assert.equal(formatClock(new Date(2026, 0, 2, 0, 0, 0)), "12:00:00 AM");
    assert.equal(formatClock(new Date(2026, 0, 2, 12, 0, 5)), "12:00:05 PM");
    const iso = new Date(2026, 0, 2, 15, 7, 42).toISOString();
    assert.equal(formatClock(iso), "3:07:42 PM");
  });

  it("passes unparseable values through as strings", () => {
    assert.equal(formatClock("garbage"), "garbage");
  });

  it("formats warmup timeouts in whole minutes", () => {
    assert.equal(formatWarmupTimeoutMs(600000), "10m");
    assert.equal(formatWarmupTimeoutMs(15000), "1m");
    assert.equal(formatWarmupTimeoutMs(1), "1m");
  });
});
