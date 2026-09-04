import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { computeRemainingMs } from "../../shared/neuron-core/reservation.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

// Load the SOURCE entry (adapter over the shared core) so the dev loop needs
// no rebuild; the installed artifact is the esbuild bundle in plugins/.
const pluginUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "opencode-adapter.js")
).href;

async function loadFreshNeuronPlugin() {
  const url = `${pluginUrl}?test=${Date.now()}-${Math.random()}`;
  const mod = await import(url);
  return mod.NeurOnPlugin;
}

function makeStatusResponse(observed) {
  return {
    capacityTargets: [
      {
        id: "t1",
        modelIds: ["gemma-4-26b-a4b"],
        provider: "openai",
        observed
      }
    ],
    activeReservations: [],
    reservations: []
  };
}

function makeModelsResponse() {
  return {
    models: [
      {
        id: "gemma-4-26b-a4b",
        aliases: ["gemma-4"],
        backendModelIds: ["gemma-4-26b-a4b"],
        targetIds: ["t1"]
      }
    ]
  };
}

function makeReservationResponse(reservationId = "r1") {
  return {
    reservationId,
    createdAt: new Date().toISOString(),
    durationMinutes: 2,
    keepaliveMinutes: 2,
    status: "active",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    targets: [{ id: "t1", observed: "healthy" }]
  };
}

function makeReservationStatusResponse(observed) {
  return {
    reservationId: "r1",
    targets: [{ id: "t1", observed }]
  };
}

// Status with an ACTIVE reservation for target t1 (what the plugin adopts
// when the session's model resolves to t1).
function makeStatusWithActiveReservation(observed = "healthy") {
  const status = makeStatusResponse(observed);
  status.activeReservations = [makeReservationResponse("r1")];
  return status;
}

function setNeuronEnv(overrides = {}) {
  const env = {
    NEURON_API_BASE_URL: "http://neuron.test:8090",
    NEURON_API_KEY: "test-key",
    NEURON_WAIT_FOR_HEALTHY: "false",
    NEURON_WAIT_TIMEOUT_SECONDS: "1",
    NEURON_WAIT_POLL_SECONDS: "1",
    NEURON_PREFLIGHT_TIMEOUT_MS: "25",
    NEURON_REQUEST_TIMEOUT_MS: "25",
    NEURON_COOLDOWN_PERIOD_MS: "0",
    NEURON_RETRY_MAX_ATTEMPTS: "1",
    NEURON_RETRY_BASE_MS: "1",
    NEURON_RETRY_MAX_MS: "1",
    NEURON_RESERVATION_DURATION_MINUTES: "2",
    NEURON_RESERVATION_KEEPALIVE_MINUTES: "2",
    NEURON_BLOCK_ON_COLD_MESSAGE: "false",
    NEURON_STRICT_PROVIDER_MATCH: "false",
    NEURON_ALLOWED_PROVIDERS: "",
    ...overrides
  };

  process.env = { ...originalEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function jsonResponse(data) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}

function installNeuronFetch({
  statuses,
  reservationObserved = "healthy",
  extendError,
  extendResponse,
  doneError,
  doneResponse
}) {
  const calls = {
    status: 0,
    create: 0,
    extend: 0,
    done: 0,
    reservationStatus: 0,
    requests: [],
    extendBodies: []
  };

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.requests.push(path);

    if (path === "/api/status") {
      calls.status += 1;
      const status = statuses[calls.status - 1] ?? statuses[statuses.length - 1];
      if (status === "hang") return new Promise(() => {});
      if (status instanceof Error) throw status;
      // Full status objects (e.g. with activeReservations) pass through
      // unchanged; plain strings stay the "observed" shorthand.
      if (status && typeof status === "object") return jsonResponse(status);
      return jsonResponse(makeStatusResponse(status));
    }

    if (path === "/api/models") {
      return jsonResponse(makeModelsResponse());
    }

    if (path === "/api/reservations" && options.method === "POST") {
      calls.create += 1;
      return jsonResponse(makeReservationResponse());
    }

    if (path === "/api/reservations/r1/extend" && options.method === "POST") {
      calls.extend += 1;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.extendBodies.push(body);
      // Errors only apply to the COMMAND's additive extend (fromNow:false);
      // the warmup/keepalive refresh (fromNow:true) succeeds, so the command's
      // own call stays distinguishable.
      const isCommandExtend = body?.fromNow === false;
      if (isCommandExtend && extendError instanceof Error) throw extendError;
      if (isCommandExtend && extendError && typeof extendError === "object") {
        return new Response(extendError.body ?? "", {
          status: extendError.status,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse(extendResponse ?? makeReservationResponse());
    }

    if (path === "/api/reservations/r1/done" && options.method === "POST") {
      calls.done += 1;
      if (doneError instanceof Error) throw doneError;
      if (doneError && typeof doneError === "object") {
        return new Response(doneError.body ?? "", {
          status: doneError.status,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse(doneResponse ?? makeReservationResponse("r1", { status: "done" }));
    }

    if (path === "/api/reservations/r1/status") {
      calls.reservationStatus += 1;
      return jsonResponse(makeReservationStatusResponse(reservationObserved));
    }

    throw new Error(`unexpected fetch in test: ${path}`);
  };

  return calls;
}

function makeCtx() {
  return {
    client: {
      tui: {
        toasts: [],
        showToast({ body }) {
          this.toasts.push(body.message);
        }
      }
    }
  };
}

async function waitFor(count) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function primeStatusCache(hooks) {
  // Prime the module-level status cache via a background session-created
  // warmup so the next hot-path preflight can read fresh cached state without
  // awaiting network I/O itself.
  hooks.event({
    event: {
      type: "session.created",
      sessionID: "prime-session",
      properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
    }
  }).catch(() => {});
  await waitFor(12);
}

function userMessageEvent(sessionID, modelId) {
  return {
    event: {
      type: "message.updated",
      sessionID,
      role: "user",
      properties: {
        info: {
          model: {
            providerID: "openai",
            id: modelId
          },
          role: "user"
        }
      }
    }
  };
}

function toolInput(sessionID) {
  return {
    sessionID,
    info: { model: { providerID: "openai", id: "gemma-4" } }
  };
}

function sessionErrorEvent(sessionID, error) {
  return {
    event: {
      type: "session.error",
      sessionID,
      properties: { sessionID, error }
    }
  };
}

function retryStatusEvent(sessionID, message, attempt = 1) {
  return {
    event: {
      type: "session.status",
      sessionID,
      properties: {
        sessionID,
        status: { type: "retry", attempt, message, next: 1000 }
      }
    }
  };
}

beforeEach(() => {
  setNeuronEnv();
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

describe("NeurOn OpenCode plugin cold-start blocking", () => {
  it("uses the cold-start flow for cold messages", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["cold", "cold"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await primeStatusCache(hooks);
    await hooks.event(userMessageEvent("s-cold", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: warming up… please wait, up to 1m"
    ]);
  });

  it("uses the cold-start flow for stopped messages", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["stopped", "stopped"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await primeStatusCache(hooks);
    await hooks.event(userMessageEvent("s-stopped", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: warming up… please wait, up to 1m"
    ]);
  });

  it("uses a dedicated stopping warning for stopping messages", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["stopping", "stopping"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await primeStatusCache(hooks);
    await hooks.event(userMessageEvent("s-stopping", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: target stopping, restarting… please retry once warmup completes, up to 1m"
    ]);
  });

  it("fails open for unknown target states on messages", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["weird", "weird"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(userMessageEvent("s-unknown", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("fast-aborts cold, stopped, and stopping messages when NEURON_BLOCK_ON_COLD_MESSAGE=true", async () => {
    for (const state of ["cold", "stopped", "stopping"]) {
      setNeuronEnv({ NEURON_BLOCK_ON_COLD_MESSAGE: "true" });
      const ctx = makeCtx();
      installNeuronFetch({ statuses: [state, state, state, state] });
      const FreshNeuronPlugin = await loadFreshNeuronPlugin();
      const hooks = await FreshNeuronPlugin(ctx);
      await primeStatusCache(hooks);

      await assert.rejects(
        async () => hooks.event(userMessageEvent(`s-fast-${state}`, "gemma-4")),
        new RegExp(`NeurOn: target is ${state}, warming up`)
      );
      await waitFor(2);
    }
  });

  it("does not reserve from tool execution and fails open for unknown tool states", async () => {
    setNeuronEnv();
    const healthyCtx = makeCtx();
    const healthyCalls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const HealthyNeuronPlugin = await loadFreshNeuronPlugin();
    const healthyHooks = await HealthyNeuronPlugin(healthyCtx);
    await primeStatusCache(healthyHooks);
    await healthyHooks["tool.execute.before"](toolInput("s-tool-healthy"));
    await waitFor(8);
    assert.equal(healthyCalls.status >= 1, true);
    assert.equal(healthyCalls.create, 0);
    assert.deepEqual(healthyCtx.client.tui.toasts, []);

    setNeuronEnv();
    const coldCtx = makeCtx();
    const coldCalls = installNeuronFetch({ statuses: ["cold", "cold", "healthy"] });
    const ColdNeuronPlugin = await loadFreshNeuronPlugin();
    const coldHooks = await ColdNeuronPlugin(coldCtx);
    await primeStatusCache(coldHooks);
    await coldHooks["tool.execute.before"](toolInput("s-tool-cold"));
    await waitFor(10);
    assert.equal(coldCalls.status >= 1, true);
    assert.equal(coldCalls.create, 0);
    assert.deepEqual(coldCtx.client.tui.toasts, []);

    setNeuronEnv();
    const unknownCtx = makeCtx();
    const unknownCalls = installNeuronFetch({ statuses: ["weird", "weird"] });
    const UnknownNeuronPlugin = await loadFreshNeuronPlugin();
    const unknownHooks = await UnknownNeuronPlugin(unknownCtx);
    await unknownHooks["tool.execute.before"](toolInput("s-tool-unknown"));
    await waitFor(4);
    assert.equal(unknownCalls.create, 0);
    assert.deepEqual(unknownCtx.client.tui.toasts, []);
  });

  it("keeps chat.message non-throwing on cold start", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["cold", "cold", "cold"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);
    await primeStatusCache(hooks);

    await hooks["chat.message"]({
      sessionID: "s-chat-cold",
      info: { model: { providerID: "openai", id: "gemma-4" } }
    }, {});
    await waitFor(10);

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: warming up… please wait, up to 1m"
    ]);
  });

  it("hydrates resumed chat.message sessions from modelID/providerID", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks["chat.message"]({
      sessionID: "s-chat-resumed",
      model: { providerID: "openai", modelID: "gemma-4" }
    }, {});
    await waitFor(8);

    assert.equal(calls.status >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("bypasses message hooks without disabling session lifecycle hooks", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    setNeuronEnv({ NEURON_BYPASS_MESSAGE_HOOK: "true" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks["chat.message"]({
      sessionID: "s-chat-bypass",
      model: { providerID: "openai", modelID: "gemma-4" }
    }, {});
    await hooks.event({ event: userMessageEvent("s-event-bypass", "gemma-4").event });
    await waitFor(8);

    assert.equal(calls.status, 0);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("does not create reservations for idle sessions when the API is unreachable", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [new Error("api down"), new Error("api down")] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-idle",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await hooks.event({ event: { type: "session.idle", sessionID: "s-idle" } });
    await waitFor(10);

    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("fails open for messages when the stale live status check is unreachable", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [new Error("api down"), new Error("api down")] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(userMessageEvent("s-stale-down", "gemma-4"));
    await waitFor(8);

    assert.equal(calls.status, 1);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("fails open for tools when the stale live status check is unreachable", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [new Error("api down"), new Error("api down")] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks["tool.execute.before"](toolInput("s-tool-stale-down"));
    await waitFor(8);

    assert.equal(calls.status, 1);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("fails open for chat.message when the stale live status check is unreachable", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [new Error("api down"), new Error("api down"), new Error("api down")] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks["chat.message"]({
      sessionID: "s-chat-stale-down",
      info: { model: { providerID: "openai", id: "gemma-4" } }
    }, {});
    await waitFor(8);

    assert.equal(calls.status, 1);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("fails open for messages when the stale live status check times out", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["hang"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const started = Date.now();
    await hooks.event(userMessageEvent("s-stale-hang", "gemma-4"));
    await waitFor(8);

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `stale preflight must stay within its bounded budget, took ${elapsed}ms`);
    assert.equal(calls.status, 1);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("engages the cold-start flow when the stale live status check finds a cold target", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["cold", "cold", "cold"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(userMessageEvent("s-stale-cold", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: warming up… please wait, up to 1m"
    ]);
  });

  it("engages the cold-start flow for chat.message when the stale live check finds a cold target", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["cold", "cold", "cold"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks["chat.message"]({
      sessionID: "s-chat-stale-cold",
      info: { model: { providerID: "openai", id: "gemma-4" } }
    }, {});
    await waitFor(10);

    assert.equal(calls.create >= 1, true);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: warming up… please wait, up to 1m"
    ]);
  });

  it("does not extend the reservation per message while active (keepalive only)", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy", "healthy"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    // Selecting a model must not establish a reservation.
    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-keepalive",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await waitFor(10);
    assert.equal(calls.create, 0);

    // User messages while the reservation is live must NOT extend it.
    await hooks.event(userMessageEvent("s-keepalive", "gemma-4"));
    await hooks.event(userMessageEvent("s-keepalive", "gemma-4"));
    await waitFor(10);

    assert.equal(calls.extend, 0);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("stops keepalive on session.idle without extending the reservation", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy", "healthy"], reservationObserved: "healthy" });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-idle-stop",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await waitFor(10);
    assert.equal(calls.create, 0);

    // Idle: no extend call, no new reservation.
    await hooks.event({ event: { type: "session.idle", sessionID: "s-idle-stop" } });
    await waitFor(4);
    assert.equal(calls.extend, 0);
    assert.equal(calls.create, 0);

    // Returning user activity re-arms keepalive but still does not extend.
    await hooks.event(userMessageEvent("s-idle-stop", "gemma-4"));
    await waitFor(10);
    assert.equal(calls.extend, 0);
    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });

  it("backgrounds old-model cleanup on model switch without blocking the event path", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const started = Date.now();
    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-model-switch",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await hooks.event(userMessageEvent("s-model-switch", "gemma-4"));
    await waitFor(4);
    const elapsed = Date.now() - started;

    assert.equal(calls.status >= 1, true);
    assert.equal(calls.create, 0);
    assert.ok(elapsed < 1000, `model switch path should not block on network cleanup, took ${elapsed}ms`);
  });

  it("explains a model switch with the most recent recorded session.error", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy", "healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);
    await primeStatusCache(hooks);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-switch-err",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await hooks.event(sessionErrorEvent("s-switch-err", {
      name: "APIError",
      data: { message: "502 Bad Gateway", statusCode: 502, isRetryable: true }
    }));
    await hooks.event(userMessageEvent("s-switch-err", "other-model"));
    await waitFor(10);

    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: model switched openai/gemma-4 → openai/other-model — last failure: APIError 502: 502 Bad Gateway"
    ]);
  });

  it("explains a model switch with a recent retry status event", async () => {
    const ctx = makeCtx();
    installNeuronFetch({ statuses: ["healthy", "healthy", "healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);
    await primeStatusCache(hooks);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-switch-retry",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await hooks.event(retryStatusEvent("s-switch-retry", "Connection reset by peer", 2));
    await hooks.event(userMessageEvent("s-switch-retry", "other-model"));
    await waitFor(10);

    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: model switched openai/gemma-4 → openai/other-model — last failure: Retry 2: Connection reset by peer"
    ]);
  });

  it("toasts a neutral message when a model switch has no recorded failure", async () => {
    const ctx = makeCtx();
    installNeuronFetch({ statuses: ["healthy", "healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-switch-clean",
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } } }
      }
    });
    await hooks.event(userMessageEvent("s-switch-clean", "other-model"));
    await waitFor(10);

    assert.deepEqual(ctx.client.tui.toasts, [
      "NeurOn: model switched openai/gemma-4 → openai/other-model (no recorded failure)"
    ]);
  });

  it("does not toast model switches between non-NeurOn models", async () => {
    setNeuronEnv({ NEURON_ALLOWED_PROVIDERS: "openai" });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.created",
        sessionID: "s-switch-local",
        properties: { info: { model: { providerID: "local-a", id: "local-model" } } }
      }
    });
    await hooks.event({
      event: {
        type: "message.updated",
        sessionID: "s-switch-local",
        role: "user",
        properties: {
          info: {
            model: { providerID: "local-b", id: "other-local-model" },
            role: "user"
          }
        }
      }
    });
    await waitFor(10);

    assert.equal(calls.create, 0);
    assert.deepEqual(ctx.client.tui.toasts, []);
  });
});

describe("NeurOn /neuron-extend command (command.execute.before)", () => {
  // Every part the neuron-extend hook emits is framed as an automated
  // notification (see notificationPart in the plugin): OpenCode always runs
  // an LLM turn after the hook, so the framed parts reach the session model.
  const NEURON_NOTIFY_PREFIX =
    "NeurOn notification (automated — no action needed, reply with a one-line acknowledgement only): ";
  // Regex-escaped form of the same prefix.
  const NEURON_NOTIFY_PREFIX_RE =
    "NeurOn notification \\(automated — no action needed, reply with a one-line acknowledgement only\\): ";

  function sessionCreatedEvent(sessionID, providerID, modelId) {
    return {
      event: {
        type: "session.created",
        sessionID,
        properties: { info: { model: { providerID, id: modelId } } }
      }
    };
  }

  function commandInput(command, sessionID, argumentsText) {
    return { command, sessionID, arguments: argumentsText };
  }

  it("ignores other commands without touching parts or making any fetch", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [{ type: "text", text: "original template" }] };
    await hooks["command.execute.before"](commandInput("other-command", "s-other", "10"), output);
    await waitFor(4);

    assert.deepEqual(output.parts, [{ type: "text", text: "original template" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.extend, 0);
    assert.equal(calls.requests.length, 0);
  });

  it("reports a not-configured part when NEURON_API_KEY is missing", async () => {
    setNeuronEnv({ NEURON_API_KEY: undefined });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [{ type: "text", text: "template" }] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-nokey", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: plugin not configured" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.extend, 0);
  });

  it("reports a not-configured part when config fails to load", async () => {
    setNeuronEnv({ NEURON_API_BASE_URL: "ftp://invalid" });
    const ctx = makeCtx();
    installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [{ type: "text", text: "template" }] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-badcfg", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: plugin not configured" }]);
  });

  it("reports when no session model is recorded yet (no fetch)", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-fresh", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: no session model recorded yet" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.extend, 0);
  });

  it("rejects an unmanaged model via the provider filter without any API call", async () => {
    setNeuronEnv({ NEURON_ALLOWED_PROVIDERS: "openai" });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-local", "local-a", "local-model"));
    await waitFor(6);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-local", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: local-a/local-model is not managed" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.extend, 0);
  });

  it("rejects a model NeurOn does not manage without any extend call", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-unmanaged", "openai", "unknown-model"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-unmanaged", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: openai/unknown-model is not managed" }]);
    assert.equal(calls.status >= 1, true);
    assert.equal(calls.extend, 0);
  });

  it("reports when there is no active reservation for the target (no extend call)", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    // No active reservation in the status: the background warmup creates one,
    // but the (fake) status still shows none, so the command finds nothing.
    await hooks.event(sessionCreatedEvent("s-nores", "openai", "gemma-4"));
    await waitFor(12);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-nores", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: no active reservation — send a message to start one" }]);
    assert.equal(calls.extend, 0);
  });

  it("extends with fromNow:false and the configured default minutes", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [makeStatusWithActiveReservation()] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    // The session-created warmup adopts the active reservation (no create).
    await hooks.event(sessionCreatedEvent("s-extend-default", "openai", "gemma-4"));
    await waitFor(10);
    assert.equal(calls.create, 0);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-extend-default", ""), output);

    // The warmup refresh may also hit the extend endpoint (fromNow:true);
    // the command must have sent exactly one ADDITIVE extend.
    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 2, fromNow: false }]
    );
    assert.equal(output.parts.length, 1);
    assert.equal(output.parts[0].type, "text");
    assert.match(
      output.parts[0].text,
      new RegExp(`^${NEURON_NOTIFY_PREFIX_RE}NeurOn: reservation r1 extended to \\d{1,2}:\\d{2}:\\d{2} (AM|PM) \\(\\+2 min\\)$`)
    );
  });

  it("uses the argument minutes and reports the advanced wall-clock expiry", async () => {
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      extendResponse: { ...makeReservationResponse("r1"), expiresAt: expiry }
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-extend-arg", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-extend-arg", " 10 "), output);

    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 10, fromNow: false }]
    );
    // The reported wall clock is the (advanced) expiry from the extend response.
    const d = new Date(expiry);
    const pad = (n) => String(n).padStart(2, "0");
    const expectedClock = `${d.getHours() % 12 === 0 ? 12 : d.getHours() % 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() >= 12 ? "PM" : "AM"}`;
    assert.match(
      output.parts[0].text,
      new RegExp(`^${NEURON_NOTIFY_PREFIX_RE}NeurOn: reservation r1 extended to ${expectedClock} \\(\\+10 min\\)$`)
    );
  });

  it("rejects bad arguments with the usage line and no fetch", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    for (const bad of ["0", "721", "abc"]) {
      const output = { parts: [] };
      await hooks["command.execute.before"](commandInput("neuron-extend", "s-badargs", bad), output);
      assert.deepEqual(
        output.parts,
        [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: usage: /neuron-extend [minutes 1-720]" }],
        `bad argument ${JSON.stringify(bad)} must produce the usage line`
      );
    }
    assert.equal(calls.status, 0);
    assert.equal(calls.extend, 0);
  });

  it("surfaces a 400 rejection with the server error message", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      extendError: { status: 400, body: "duration must be between 1 and 720 minutes" }
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-extend-400", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-extend-400", ""), output);

    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 2, fromNow: false }]
    );
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: extend rejected — duration must be between 1 and 720 minutes"
    }]);
  });

  it("surfaces a 404 rejection with the server error message", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      extendError: { status: 404, body: "reservation not found" }
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-extend-404", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-extend-404", ""), output);

    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 2, fromNow: false }]
    );
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: extend rejected — reservation not found"
    }]);
  });

  it("reports the control plane as unreachable on a transport failure", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      extendError: new Error("fetch failed")
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-extend-down", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", "s-extend-down", ""), output);

    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 2, fromNow: false }]
    );
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: control plane unreachable — try again"
    }]);
  });

  it("saves the extended reservation locally, re-arms the keepalive timer, and logs the result", async () => {
    const logFile = join(tmpdir(), `neuron-extend-test-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    setNeuronEnv({ NEURON_LOG_FILE: logFile });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [makeStatusWithActiveReservation()] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const sessionID = "s-extend-state";
    await hooks.event(sessionCreatedEvent(sessionID, "openai", "gemma-4"));
    await waitFor(10);
    assert.equal(calls.create, 0);

    // No timer exists yet because model selection does not adopt reservations.
    await hooks.event({ event: { type: "session.idle", sessionID } });
    await waitFor(4);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-extend", sessionID, "10"), output);
    assert.deepEqual(
      calls.extendBodies.filter((b) => b?.fromNow === false),
      [{ durationMinutes: 10, fromNow: false }]
    );

    // The command's saveReservation(restart=true) arms the timer.
    await hooks.event({ event: { type: "session.idle", sessionID } });
    await waitFor(4);

    await new Promise((resolve) => setTimeout(resolve, 100)); // flush async log appends
    const logContent = await readFile(logFile, "utf8");
    const idleStopLine = "keepalive stopped (idle): session=s-extend-state key=s-extend-state::t1";
    assert.equal(
      logContent.split(idleStopLine).length - 1,
      1,
      "the command's saveReservation must arm the keepalive timer"
    );
    assert.match(logContent, /command extend: session=s-extend-state minutes=10 fromNow=false result=ok/);

    await hooks.dispose();
    try { await unlink(logFile); } catch { /* already rotated/absent */ }
  });

  it("never throws, even on an unexpected internal error", async () => {
    const ctx = makeCtx();
    // A malformed active reservation (targets is not an array) makes the
    // shared adoption lookup throw — the hook must absorb it.
    installNeuronFetch({
      statuses: [{
        ...makeStatusWithActiveReservation(),
        activeReservations: [{ reservationId: "r1", status: "active", targets: 42 }]
      }]
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-badstatus", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await assert.doesNotReject(
      async () => hooks["command.execute.before"](commandInput("neuron-extend", "s-badstatus", "5"), output)
    );
    assert.equal(output.parts.length, 1);
    assert.equal(output.parts[0].type, "text");
    assert.match(output.parts[0].text, new RegExp(`^${NEURON_NOTIFY_PREFIX_RE}NeurOn: extend failed — `));
  });
});

describe("NeurOn /neuron-done command (command.execute.before)", () => {
  const NEURON_NOTIFY_PREFIX =
    "NeurOn notification (automated — no action needed, reply with a one-line acknowledgement only): ";
  const NEURON_NOTIFY_PREFIX_RE =
    "NeurOn notification \\(automated — no action needed, reply with a one-line acknowledgement only\\): ";

  function sessionCreatedEvent(sessionID, providerID, modelId) {
    return {
      event: {
        type: "session.created",
        sessionID,
        properties: { info: { model: { providerID, id: modelId } } }
      }
    };
  }

  function commandInput(command, sessionID, argumentsText) {
    return { command, sessionID, arguments: argumentsText };
  }

  it("ignores other commands without touching parts or making any fetch", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [{ type: "text", text: "original template" }] };
    await hooks["command.execute.before"](commandInput("other-command", "s-other", ""), output);
    await waitFor(4);

    assert.deepEqual(output.parts, [{ type: "text", text: "original template" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.done, 0);
  });

  it("reports a not-configured part when NEURON_API_KEY is missing", async () => {
    setNeuronEnv({ NEURON_API_KEY: undefined });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [{ type: "text", text: "template" }] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-nokey", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: plugin not configured" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.done, 0);
  });

  it("reports when no session model is recorded yet (no fetch)", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-fresh", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: no session model recorded yet" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.done, 0);
  });

  it("rejects an unmanaged model via the provider filter without any API call", async () => {
    setNeuronEnv({ NEURON_ALLOWED_PROVIDERS: "openai" });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-local", "local-a", "local-model"));
    await waitFor(6);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-local", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: local-a/local-model is not managed" }]);
    assert.equal(calls.status, 0);
    assert.equal(calls.done, 0);
  });

  it("reports when there is no active reservation to end", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: ["healthy", "healthy"] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-nores", "openai", "gemma-4"));
    await waitFor(12);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-nores", ""), output);

    assert.deepEqual(output.parts, [{ type: "text", text: NEURON_NOTIFY_PREFIX + "NeurOn: no active reservation to end" }]);
    assert.equal(calls.done, 0);
  });

  it("marks the reservation done and reports the reservation id", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [makeStatusWithActiveReservation()] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-done", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-done", ""), output);

    assert.equal(calls.done, 1);
    assert.equal(output.parts.length, 1);
    assert.equal(output.parts[0].type, "text");
    assert.match(
      output.parts[0].text,
      new RegExp(`^${NEURON_NOTIFY_PREFIX_RE}NeurOn: reservation r1 ended$`)
    );
  });

  it("clears local reservation state and keepalive timer after done", async () => {
    const logFile = join(tmpdir(), `neuron-done-test-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    setNeuronEnv({ NEURON_LOG_FILE: logFile });
    const ctx = makeCtx();
    const calls = installNeuronFetch({ statuses: [makeStatusWithActiveReservation()] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    const sessionID = "s-done-state";
    await hooks.event(sessionCreatedEvent(sessionID, "openai", "gemma-4"));
    await waitFor(10);

    // Trigger a message to establish a local reservation + keepalive timer.
    await hooks.event({
      event: {
        type: "message.updated",
        sessionID,
        properties: { info: { model: { providerID: "openai", id: "gemma-4" } }, state: { status: "completed" } }
      }
    });
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", sessionID, ""), output);
    assert.equal(calls.done, 1);
    assert.match(output.parts[0].text, /NeurOn: reservation r1 ended/);

    // After done, the keepalive timer should be cleared. Verify by checking
    // that a subsequent idle event does NOT log "keepalive stopped (idle)".
    await hooks.event({ event: { type: "session.idle", sessionID } });
    await waitFor(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const logContent = await readFile(logFile, "utf8");
    assert.equal(
      logContent.split("keepalive stopped (idle): session=s-done-state").length - 1,
      0,
      "keepalive timer should be cleared after done"
    );
    assert.match(logContent, /command done: session=s-done-state reservationId=r1 result=ok/);

    await hooks.dispose();
    try { await unlink(logFile); } catch { /* already rotated/absent */ }
  });

  it("surfaces a 400 rejection with the server error message", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      doneError: { status: 400, body: "reservation is already done" }
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-done-400", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-done-400", ""), output);

    assert.equal(calls.done, 1);
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: end rejected — reservation is already done"
    }]);
  });

  it("surfaces a 404 rejection with the server error message", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      doneError: { status: 404, body: "reservation not found" }
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-done-404", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-done-404", ""), output);

    assert.equal(calls.done, 1);
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: end rejected — reservation not found"
    }]);
  });

  it("reports the control plane as unreachable on a transport failure", async () => {
    const ctx = makeCtx();
    const calls = installNeuronFetch({
      statuses: [makeStatusWithActiveReservation()],
      doneError: new Error("fetch failed")
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-done-down", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await hooks["command.execute.before"](commandInput("neuron-done", "s-done-down", ""), output);

    assert.equal(calls.done, 1);
    assert.deepEqual(output.parts, [{
      type: "text",
      text: NEURON_NOTIFY_PREFIX + "NeurOn: control plane unreachable — try again"
    }]);
  });

  it("never throws, even on an unexpected internal error", async () => {
    const ctx = makeCtx();
    installNeuronFetch({
      statuses: [{
        ...makeStatusWithActiveReservation(),
        activeReservations: [{ reservationId: "r1", status: "active", targets: 42 }]
      }]
    });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(ctx);

    await hooks.event(sessionCreatedEvent("s-badstatus-done", "openai", "gemma-4"));
    await waitFor(10);

    const output = { parts: [] };
    await assert.doesNotReject(
      async () => hooks["command.execute.before"](commandInput("neuron-done", "s-badstatus-done", ""), output)
    );
    assert.equal(output.parts.length, 1);
    assert.equal(output.parts[0].type, "text");
    assert.match(output.parts[0].text, new RegExp(`^${NEURON_NOTIFY_PREFIX_RE}NeurOn: done failed — `));
  });
});

// ── computeRemainingMs unit tests ─────────────────────────────────────────
// Validates the adoption timer-inflation fix: an adopted reservation's
// remaining lifetime is computed from expiresAt (preferred) or
// createdAt + durationMinutes (fallback), not the full duration.
describe("computeRemainingMs", () => {
  it("prefers expiresAt over createdAt", () => {
    const res = {
      reservationId: "r1",
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      durationMinutes: 30,
      expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString()
    };
    const remaining = computeRemainingMs(res);
    // Should use expiresAt (~25 min), not createdAt+duration (also ~25 min here).
    assert.ok(remaining > 24 * 60 * 1000, `expected >24min, got ${remaining / 60000}min`);
    assert.ok(remaining < 26 * 60 * 1000, `expected <26min, got ${remaining / 60000}min`);
  });

  it("uses expiresAt even when createdAt+duration would say expired", () => {
    // Reservation was extended: createdAt is 35 min ago with 30-min duration
    // (would be expired), but expiresAt shows it was extended to 10 min out.
    const res = {
      reservationId: "r1",
      createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      durationMinutes: 30,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    };
    const remaining = computeRemainingMs(res);
    assert.ok(remaining > 9 * 60 * 1000, `expected >9min, got ${remaining / 60000}min`);
    assert.ok(remaining < 11 * 60 * 1000, `expected <11min, got ${remaining / 60000}min`);
  });

  it("falls back to createdAt+duration when expiresAt is absent", () => {
    const res = {
      reservationId: "r1",
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      durationMinutes: 30
    };
    const remaining = computeRemainingMs(res);
    assert.ok(remaining > 24 * 60 * 1000, `expected >24min, got ${remaining / 60000}min`);
    assert.ok(remaining < 26 * 60 * 1000, `expected <26min, got ${remaining / 60000}min`);
  });

  it("returns null for an expired reservation (both sources agree)", () => {
    const res = {
      reservationId: "r1",
      createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      durationMinutes: 30,
      expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    };
    assert.equal(computeRemainingMs(res), null);
  });

  it("returns null when createdAt and expiresAt are both missing", () => {
    assert.equal(computeRemainingMs({ reservationId: "r1", durationMinutes: 30 }), null);
  });

  it("returns null when both dates are invalid", () => {
    assert.equal(
      computeRemainingMs({ reservationId: "r1", createdAt: "bad", expiresAt: "bad", durationMinutes: 30 }),
      null
    );
  });

  it("uses durationMinutes when keepaliveMinutes is absent", () => {
    const res = {
      reservationId: "r1",
      createdAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
      durationMinutes: 10
    };
    const remaining = computeRemainingMs(res);
    assert.ok(remaining > 8 * 60 * 1000, `expected >8min, got ${remaining / 60000}min`);
    assert.ok(remaining < 10 * 60 * 1000, `expected <10min, got ${remaining / 60000}min`);
  });

  it("refreshes once for OpenCode's completed-message and idle event pair", async () => {
    const calls = installNeuronFetch({ statuses: [makeStatusWithActiveReservation("cold")] });
    const NeurOnPlugin = await loadFreshNeuronPlugin();
    const hooks = await NeurOnPlugin(makeCtx());

    await hooks["chat.message"]({
      sessionID: "s1",
      model: { providerID: "openai", modelID: "gemma-4" }
    }, {});
    await hooks.event({
      event: {
        type: "message.updated",
        sessionID: "s1",
        properties: {
          info: {
            role: "assistant",
            model: { providerID: "openai", id: "gemma-4" },
            time: { completed: 123 }
          }
        }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } }
    });

    assert.deepEqual(
      calls.extendBodies.filter((body) => body?.fromNow === true),
      [{ durationMinutes: 2, fromNow: true }]
    );
    await hooks.dispose();
  });
});
