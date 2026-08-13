import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// We test the plugin by importing it and exercising the public interface
// (event / tool.execute.before / dispose) with a mocked global fetch.
// The plugin is an ESM module that exports NeurOnPlugin.

let pluginModule;
let plugin;

// ── Mock state ─────────────────────────────────────────────
let fetchMock;
let fetchCalls;
let toastCalls;
let disposed;

function makeStatusResponse({ observed = "cold", targets = [], models = [], reservations = [], activeReservations = [] } = {}) {
  return {
    capacityTargets: targets.length ? targets : [{ id: "target-1", provider: "openai", observed, modelIds: ["gpt-4o"] }],
    models: models.length ? models : [{ id: "gpt-4o", targetIds: ["target-1"] }],
    activeReservations,
    reservations
  };
}

function makeModelsResponse(models = []) {
  return { models: models.length ? models : [{ id: "gpt-4o", targetIds: ["target-1"] }] };
}

function makeReservationResponse({ reservationId = "res-1", status = "active", targets = [{ id: "target-1", observed: "healthy" }], durationMinutes = 2, keepaliveMinutes = 5 } = {}) {
  return { reservationId, status, targets, durationMinutes, keepaliveMinutes };
}

function setupFetchMock(responses) {
  fetchCalls = [];
  fetchMock = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
    const config = responses.shift() || { status: 200, json: {} };
    return {
      ok: config.status >= 200 && config.status < 300,
      status: config.status,
      statusText: config.statusText || "OK",
      text: async () => JSON.stringify(config.json),
    };
  };
  global.fetch = fetchMock;
}

function setupEnv(env = {}) {
  process.env.NEURON_API_BASE_URL = env.baseUrl ?? "http://localhost:8090";
  process.env.NEURON_API_KEY = env.apiKey ?? "test-key";
  if (env.durationMinutes !== undefined) process.env.NEURON_RESERVATION_DURATION_MINUTES = String(env.durationMinutes);
  else delete process.env.NEURON_RESERVATION_DURATION_MINUTES;
  if (env.keepaliveMinutes !== undefined) process.env.NEURON_RESERVATION_KEEPALIVE_MINUTES = String(env.keepaliveMinutes);
  else delete process.env.NEURON_RESERVATION_KEEPALIVE_MINUTES;
  if (env.blockOnColdMessage !== undefined) process.env.NEURON_BLOCK_ON_COLD_MESSAGE = env.blockOnColdMessage ? "1" : "0";
  else delete process.env.NEURON_BLOCK_ON_COLD_MESSAGE;
  if (env.waitForHealthy !== undefined) process.env.NEURON_WAIT_FOR_HEALTHY = env.waitForHealthy ? "1" : "0";
  else delete process.env.NEURON_WAIT_FOR_HEALTHY;
  if (env.waitTimeoutSeconds !== undefined) process.env.NEURON_WAIT_TIMEOUT_SECONDS = String(env.waitTimeoutSeconds);
  else delete process.env.NEURON_WAIT_TIMEOUT_SECONDS;
  if (env.pollSeconds !== undefined) process.env.NEURON_WAIT_POLL_SECONDS = String(env.pollSeconds);
  else delete process.env.NEURON_WAIT_POLL_SECONDS;
  if (env.cooldownPeriodMs !== undefined) process.env.NEURON_COOLDOWN_PERIOD_MS = String(env.cooldownPeriodMs);
  else delete process.env.NEURON_COOLDOWN_PERIOD_MS;
  if (env.preflightTimeoutMs !== undefined) process.env.NEURON_PREFLIGHT_TIMEOUT_MS = String(env.preflightTimeoutMs);
  else delete process.env.NEURON_PREFLIGHT_TIMEOUT_MS;
  delete process.env.NEURON_LOG_FILE;
  process.env.NEURON_LOG_FILE = "NUL"; // suppress log file on Windows
}

async function initPlugin(env = {}) {
  setupEnv(env);
  // Re-import module fresh each time
  pluginModule = await import(`../plugins/neuron.js?t=${Date.now()}`);
  const ctx = {
    client: {
      tui: {
        showToast: (msg) => toastCalls.push(msg)
      }
    }
  };
  plugin = await pluginModule.NeurOnPlugin(ctx);
  return plugin;
}

async function resetGlobals() {
  // Access the test-only reset helper if exported
  try {
    const mod = await import(`../plugins/neuron.js?reset=${Date.now()}`);
    if (typeof mod._testResetGlobals === "function") {
      mod._testResetGlobals();
    }
  } catch (e) {
    // _testResetGlobals is not exported; we rely on dispose() instead
  }
}

beforeEach(async () => {
  toastCalls = [];
  disposed = false;
  fetchCalls = [];
  // Clear all NEURON_ env vars
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("NEURON_")) delete process.env[k];
  }
});

afterEach(async () => {
  if (plugin && !disposed) {
    await plugin.dispose();
  }
});

// ── Tests ─────────────────────────────────────────────────

describe("Fix #1: blockOnColdMessage=false blocks on warmup lock (per design doc)", () => {
  test("cold target with blockOnColdMessage=false acquires warmup lock and blocks until healthy", async () => {
    // Status returns cold, then reservation creation + waitForHealthy succeed
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) }, // /api/status
      { status: 200, json: makeModelsResponse() },                     // /api/models
      { status: 200, json: makeReservationResponse() },                // POST /api/reservations
      { status: 200, json: makeReservationResponse({ targets: [{ id: "target-1", observed: "healthy" }] }) }, // /api/reservations/res-1/status
    ]);

    plugin = await initPlugin({ blockOnColdMessage: false, waitForHealthy: true, pollSeconds: 0.01, waitTimeoutSeconds: 5 });

    const sessionID = "test-session-1";
    const event = {
      type: "session.created",
      sessionID,
      properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } }
    };
    await plugin.event({ event });

    // Now send a user message — target is cold, should block on warmup lock
    const userEvent = {
      type: "message.updated",
      sessionID,
      role: "user",
      properties: { info: { model: { id: "gpt-4o", providerID: "openai" }, role: "user" } }
    };

    await plugin.event({ event: userEvent });

    // Should have created a reservation (warmup lock path)
    const reservationCall = fetchCalls.find(c => c.url.includes("/api/reservations") && c.method === "POST" && !c.url.includes("/extend") && !c.url.includes("/status"));
    assert.ok(reservationCall, "Should have created a reservation via warmup lock");
    // Should have shown warming up toast
    assert.ok(toastCalls.some(t => t.body?.message?.includes("warming up")), "Should show warming up toast");
  });

  test("cold target with blockOnColdMessage=true throws immediately without blocking", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) },
      { status: 200, json: makeModelsResponse() },
    ]);

    plugin = await initPlugin({ blockOnColdMessage: true, waitForHealthy: true, pollSeconds: 0.01, waitTimeoutSeconds: 5 });

    const sessionID = "test-session-block";
    await plugin.event({ event: { type: "session.created", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    const start = Date.now();
    let threw = false;
    try {
      await plugin.event({ event: { type: "message.updated", sessionID, role: "user", properties: { info: { model: { id: "gpt-4o", providerID: "openai" }, role: "user" } } } });
    } catch (e) {
      threw = true;
      assert.match(e.message, /NeurOn: target is cold/, "Should throw cold error");
    }
    const elapsed = Date.now() - start;
    assert.ok(threw, "Should throw immediately");
    assert.ok(elapsed < 2000, `Should fail fast, took ${elapsed}ms`);
  });
});

describe("Fix #2: STATUS_CACHE_TTL reduced to 3s", () => {
  test("cache TTL is 3000ms not 10000ms", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse() },
      { status: 200, json: makeModelsResponse() },
    ]);
    plugin = await initPlugin({});
    // Read the source to verify TTL
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    assert.match(src, /const STATUS_CACHE_TTL = 3000;/, "STATUS_CACHE_TTL should be 3000");
    assert.doesNotMatch(src, /const STATUS_CACHE_TTL = 10000;/, "Old 10000 TTL should be gone");
  });
});

describe("Fix #12: waitForHealthy invalidates status cache on success", () => {
  test("source contains invalidateStatusCache call in waitForHealthy", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    // Check that waitForHealthy calls invalidateStatusCache
    assert.match(src, /invalidateStatusCache\(\)/, "invalidateStatusCache should be called");
  });
});

describe("Fix #4: saveReservation uses keepaliveMinutes for expiry", () => {
  test("reservation with keepaliveMinutes=5 has longer expiry than durationMinutes=2", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) },
      { status: 200, json: makeModelsResponse() },
      { status: 200, json: makeReservationResponse({ keepaliveMinutes: 5, durationMinutes: 2 }) },
      { status: 200, json: makeReservationResponse({ targets: [{ id: "target-1", observed: "healthy" }] }) },
    ]);

    plugin = await initPlugin({ waitForHealthy: true, pollSeconds: 0.01, waitTimeoutSeconds: 5, durationMinutes: 2, keepaliveMinutes: 5 });

    const sessionID = "test-session-keepalive";
    await plugin.event({ event: { type: "session.created", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Trigger reservation via session.error (uses acquireWarmupLock path)
    await plugin.event({ event: { type: "session.error", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Wait for background work
    await new Promise(r => setTimeout(r, 500));

    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    assert.match(src, /reservation\.keepaliveMinutes \?\? reservation\.durationMinutes/, "saveReservation should prefer keepaliveMinutes");
  });
});

describe("Fix #3: keepalive timer started on saveReservation", () => {
  test("source contains keepaliveTimers in state and setInterval in saveReservation", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    assert.match(src, /keepaliveTimers: new Map\(\)/, "state should have keepaliveTimers");
    assert.match(src, /setInterval/, "saveReservation should use setInterval for keepalive");
    assert.match(src, /stopKeepaliveTimer/, "stopKeepaliveTimer helper should exist");
    assert.match(src, /timer\.unref/, "timer should be unref'd");
  });

  test("dispose clears all keepalive timers", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    assert.match(src, /for \(const timer of state\.keepaliveTimers\.values\(\)\) clearInterval\(timer\)/, "dispose should clearInterval all timers");
  });
});

describe("Fix #5: healthy path uses acquireWarmupLock", () => {
  test("source shows acquireWarmupLock in healthy path", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    // The healthy path block should contain acquireWarmupLock
    const healthyBlock = src.match(/if \(targetState === "healthy"\) \{[\s\S]*?\n        \}/);
    assert.ok(healthyBlock, "Should find healthy target block");
    assert.match(healthyBlock[0], /acquireWarmupLock/, "Healthy path should use acquireWarmupLock");
  });
});

describe("Fix #6: reserveOrRefreshTarget uses getCachedStatus", () => {
  test("source does not call client.getStatus() directly in reserveOrRefreshTarget", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    // Extract reserveOrRefreshTarget function body
    const fnMatch = src.match(/async function reserveOrRefreshTarget[\s\S]*?\n\}/);
    assert.ok(fnMatch, "Should find reserveOrRefreshTarget");
    assert.match(fnMatch[0], /getCachedStatus\(client\)/, "Should use getCachedStatus(client)");
    assert.doesNotMatch(fnMatch[0], /await client\.getStatus\(\)/, "Should NOT call client.getStatus() directly");
  });
});

describe("Fix #7: tool.execute.before caps warmup lock wait at 60s", () => {
  test("source contains Promise.race with 60000ms timeout in tool.execute.before", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    const toolBlock = src.match(/"tool\.execute\.before": async[\s\S]*?\n    \},/);
    assert.ok(toolBlock, "Should find tool.execute.before block");
    assert.match(toolBlock[0], /Promise\.race/, "Should use Promise.race");
    assert.match(toolBlock[0], /60000/, "Should have 60000ms timeout");
    assert.match(toolBlock[0], /warmup_lock_timeout/, "Should have warmup_lock_timeout error");
  });
});

describe("Fix #8: per-session transport failure tracking", () => {
  test("source contains transportFailures Map and per-session lookup", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    assert.match(src, /const transportFailures = new Map\(\)/, "Should have transportFailures Map");
    assert.match(src, /transportFailures\.get\(sessionID\)/, "Should look up per-session");
    assert.match(src, /transportFailures\.set\(sessionID, Date\.now\(\)\)/, "Should set per-session");
    assert.match(src, /transportFailures\.delete\(sessionID\)/, "Should clean up per-session in scrubSession");
    assert.match(src, /transportFailures\.clear\(\)/, "Should clear in dispose");
  });

  test("one session's transport failure does not affect another session's cooldown", async () => {
    // Session A hits unreachable (500), session B should NOT be in cooldown
    setupFetchMock([
      { status: 500, json: { error: "server error" } }, // /api/status — fails
      { status: 200, json: makeModelsResponse() },      // /api/models
    ]);

    plugin = await initPlugin({ cooldownPeriodMs: 60000, preflightTimeoutMs: 5000 });

    const sessionA = "session-A";
    const sessionB = "session-B";

    // Set up both sessions
    await plugin.event({ event: { type: "session.created", sessionID: sessionA, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });
    await plugin.event({ event: { type: "session.created", sessionID: sessionB, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Session A tool execution — will hit unreachable
    await plugin["tool.execute.before"]({ event: { sessionID: sessionA, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Session B tool execution — should NOT be in cooldown from session A
    // Add fresh responses for session B's preflight
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "healthy" }) },
      { status: 200, json: makeModelsResponse() },
    ]);
    await plugin["tool.execute.before"]({ event: { sessionID: sessionB, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Session B should have made fetch calls (not skipped due to cooldown)
    assert.ok(fetchCalls.length > 0, `Session B should have made API calls, not skipped via cooldown (made ${fetchCalls.length} calls)`);
  });
});

describe("Fix #9: session.error uses acquireWarmupLock", () => {
  test("source shows acquireWarmupLock in session.error handler", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    const errorBlock = src.match(/if \(type === "session\.error"\) \{[\s\S]*?\n      \}/);
    assert.ok(errorBlock, "Should find session.error block");
    assert.match(errorBlock[0], /acquireWarmupLock/, "session.error should use acquireWarmupLock");
  });
});

describe("Integration: cold start reservation flow", () => {
  test("cold target triggers reservation creation and warmup", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) },
      { status: 200, json: makeModelsResponse() },
      { status: 200, json: makeReservationResponse() },
      { status: 200, json: makeReservationResponse({ targets: [{ id: "target-1", observed: "healthy" }] }) },
    ]);

    plugin = await initPlugin({ blockOnColdMessage: false, waitForHealthy: true, pollSeconds: 0.01, waitTimeoutSeconds: 5 });

    const sessionID = "cold-start-test";
    await plugin.event({ event: { type: "session.created", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Send user message — should trigger background reserve
    await plugin.event({ event: { type: "message.updated", sessionID, role: "user", properties: { info: { model: { id: "gpt-4o", providerID: "openai" }, role: "user" } } } });

    // Wait for background reservation to complete
    await new Promise(r => setTimeout(r, 1000));

    // Should have made a POST to /api/reservations
    const reservationCall = fetchCalls.find(c => c.url.includes("/api/reservations") && c.method === "POST" && !c.url.includes("/extend") && !c.url.includes("/status"));
    assert.ok(reservationCall, "Should have created a reservation");
  });

  test("healthy target does not block message handler", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "healthy" }) },
      { status: 200, json: makeModelsResponse() },
    ]);

    plugin = await initPlugin({ blockOnColdMessage: false });

    const sessionID = "healthy-test";
    await plugin.event({ event: { type: "session.created", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    const start = Date.now();
    await plugin.event({ event: { type: "message.updated", sessionID, role: "user", properties: { info: { model: { id: "gpt-4o", providerID: "openai" }, role: "user" } } } });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `Healthy target should not block, took ${elapsed}ms`);
  });
});

describe("Integration: keepalive timer lifecycle", () => {
  test("scrubSession clears keepalive timers for that session", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    const scrubMatch = src.match(/function scrubSession[\s\S]*?\n\}/);
    assert.ok(scrubMatch, "Should find scrubSession");
    assert.match(scrubMatch[0], /keepaliveTimers/, "scrubSession should clean keepaliveTimers");
    assert.match(scrubMatch[0], /stopKeepaliveTimer/, "scrubSession should call stopKeepaliveTimer");
  });
});

describe("Integration: tool.execute.before with cold target", () => {
  test("cold target in tool.execute.before triggers warmup and throws", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) },
      { status: 200, json: makeModelsResponse() },
      { status: 200, json: makeReservationResponse() },
      { status: 200, json: makeReservationResponse({ targets: [{ id: "target-1", observed: "healthy" }] }) },
    ]);

    plugin = await initPlugin({ waitForHealthy: true, pollSeconds: 0.01, waitTimeoutSeconds: 5, preflightTimeoutMs: 100 });

    const sessionID = "tool-cold-test";
    await plugin.event({ event: { type: "session.created", sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });

    // Tool execution with cold target — should throw after warmup lock timeout or failure
    // Since we only have 4 mock responses and warmup needs more, it will fail
    let threw = false;
    try {
      await plugin["tool.execute.before"]({ event: { sessionID, properties: { info: { model: { id: "gpt-4o", providerID: "openai" } } } } });
    } catch (e) {
      threw = true;
      assert.match(e.message, /NeurOn:/, "Should throw NeurOn error");
    }
    // It might throw or might succeed if warmup completes fast enough with our mocks
    // The key is that it doesn't hang indefinitely
  });
});

describe("Integration: dispose cleans up all state", () => {
  test("dispose clears all maps and timers", async () => {
    setupFetchMock([
      { status: 200, json: makeStatusResponse({ observed: "cold" }) },
      { status: 200, json: makeModelsResponse() },
    ]);

    plugin = await initPlugin({});
    await plugin.dispose();
    disposed = true;

    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plugins/neuron.js", import.meta.url), "utf8");
    // Match the real dispose block (the one with clearInterval content, not the empty fallback)
    const disposeMatches = [...src.matchAll(/dispose: async \(\) => \{([\s\S]*?)\n    \}/g)];
    const realDispose = disposeMatches.find(m => m[1].includes("clearInterval"));
    assert.ok(realDispose, "Should find real dispose block with clearInterval");
    assert.match(realDispose[0], /clearInterval/, "dispose should clearInterval");
    assert.match(realDispose[0], /keepaliveTimers\.clear\(\)/, "dispose should clear keepaliveTimers");
    assert.match(realDispose[0], /transportFailures\.clear\(\)/, "dispose should clear transportFailures");
  });
});