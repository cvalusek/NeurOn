// Unit tests for the pi adapter (../../.pi/src/neuron-pi.js).
//
// The stub pi ExtensionAPI captures on()/registerCommand(); the stub ctx
// carries model {provider,id}, isIdle(), ui.notify capture, and
// sessionManager.getSessionId(). The core is exercised through a fake fetch
// route table (same pattern as neuron-core.test.js). The keepalive tick is
// driven directly via the adapter's __test hook so tests stay deterministic
// and fast (no 5 s waits).
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatClock } from "../../shared/neuron-core/index.js";

// The adapter's file logger reads NEURON_LOG_FILE at module load, so point
// it at a temp file before the dynamic import (top-level await). Each test
// starts from a fresh log file; the temp dir is removed at the end.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "neuron-pi-log-"));
const LOG_FILE = path.join(LOG_DIR, "neuron-pi.log");
process.env.NEURON_LOG_FILE = LOG_FILE;
const { default: neuronPi, __test } = await import("../../.pi/src/neuron-pi.js");

const originalFetch = globalThis.fetch;
const originalClearInterval = globalThis.clearInterval;

// Every NEURON_* var the core/adapter read — deleted before each test so
// the developer's real environment can never leak into assertions.
const ENV_KEYS = [
  "NEURON_API_BASE_URL",
  "NEURON_API_KEY",
  "NEURON_ALLOWED_PROVIDERS",
  "NEURON_RESERVATION_DURATION_MINUTES",
  "NEURON_RESERVATION_KEEPALIVE_MINUTES",
  "NEURON_WAIT_TIMEOUT_SECONDS",
  "NEURON_WAIT_FOR_HEALTHY",
  "NEURON_WAIT_POLL_SECONDS",
  "NEURON_PREFLIGHT_TIMEOUT_MS",
  "NEURON_REQUEST_TIMEOUT_MS"
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Fast, deterministic defaults: 2-minute reservations, 3 s hard gate wait,
// 10 ms healthy-wait poll, 500 ms preflight budget.
const BASE_ENV = {
  NEURON_API_BASE_URL: "http://neuron.test:8090",
  NEURON_API_KEY: "test-key",
  NEURON_ALLOWED_PROVIDERS: "litellm",
  NEURON_RESERVATION_DURATION_MINUTES: "2",
  NEURON_RESERVATION_KEEPALIVE_MINUTES: "5",
  NEURON_WAIT_FOR_HEALTHY: "true",
  NEURON_WAIT_POLL_SECONDS: "0.01",
  NEURON_WAIT_TIMEOUT_SECONDS: "3",
  NEURON_PREFLIGHT_TIMEOUT_MS: "500"
};

let calls = null;

function jsonResponse(data) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
}

function makeReservation(id, overrides = {}) {
  return {
    reservationId: id,
    username: "testuser", // must match the /api/me mock (adoption scoping)
    status: "active",
    durationMinutes: 2,
    keepaliveMinutes: 2,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    targets: [{ id: "t1", observed: "healthy" }],
    ...overrides
  };
}

// Route-table fetch: two litellm targets (route-a → t1, route-b → t2).
// `observed` drives both the target state and the reservation-status polls
// (waitForHealthy). `activeReservations` seeds server-side adoptable
// reservations.
function installFetch(opts = {}) {
  const {
    observed = "healthy",
    activeReservations = [],
    failAll = false,
    extendExpiresAt = new Date(Date.now() + 300000).toISOString()
  } = opts;
  const warmupObserved = observed === "stopped" ? "healthy" : observed;
  calls = {
    requests: [],
    status: 0,
    models: 0,
    createBodies: [],
    extendBodies: [],
    done: 0,
    doneIds: [],
    extendExpiresAt
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = options.method ?? "GET";
    calls.requests.push(path);
    if (failAll) throw new Error("network down");
    if (path === "/api/me") {
      return jsonResponse({ username: "testuser", isAdmin: false });
    }
    if (path === "/api/status") {
      calls.status++;
      return jsonResponse({
        capacityTargets: [
          { id: "t1", modelIds: ["route-a"], provider: "litellm", observed },
          { id: "t2", modelIds: ["route-b"], provider: "litellm", observed }
        ],
        models: [],
        activeReservations,
        reservations: []
      });
    }
    if (path === "/api/models") {
      calls.models++;
      return jsonResponse({ models: [] });
    }
    if (path === "/api/reservations" && method === "POST") {
      calls.createBodies.push(JSON.parse(options.body));
      return jsonResponse(makeReservation("r-created"));
    }
    const extend = path.match(/^\/api\/reservations\/([^/]+)\/extend$/);
    if (extend && method === "POST") {
      calls.extendBodies.push({
        id: decodeURIComponent(extend[1]),
        body: JSON.parse(options.body)
      });
      return jsonResponse(makeReservation(extend[1], { expiresAt: extendExpiresAt }));
    }
    const done = path.match(/^\/api\/reservations\/([^/]+)\/done$/);
    if (done && method === "POST") {
      calls.done++;
      calls.doneIds.push(decodeURIComponent(done[1]));
      return jsonResponse(makeReservation(done[1], { status: "done" }));
    }
    const statusPath = path.match(/^\/api\/reservations\/([^/]+)\/status$/);
    if (statusPath) {
      return jsonResponse({
        reservationId: decodeURIComponent(statusPath[1]),
        status: "active",
        targets: [{ id: "t1", observed: warmupObserved === "healthy" ? "healthy" : "starting" }]
      });
    }
    throw new Error(`unexpected fetch in pi test: ${path}`);
  };
  return calls;
}

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    }
  };
}

function makeCtx({
  model = { provider: "litellm", id: "route-a" },
  sessionId = "sess-1",
  hasUI = true,
  idle = false
} = {}) {
  const notifications = [];
  const ctx = {
    model,
    hasUI,
    isIdle: () => idle,
    ui: {
      notify: (message, variant) =>
        notifications.push({ message, variant: variant ?? "info" })
    },
    sessionManager: { getSessionId: () => sessionId }
  };
  ctx.notifications = notifications;
  return ctx;
}

// Fresh module state + env + fetch, then register the extension.
async function loadPi(env = BASE_ENV, fetchOpts = {}) {
  __test.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  installFetch(fetchOpts);
  const pi = makePi();
  neuronPi(pi);
  return pi;
}

function input(pi, event, ctx) {
  return Promise.resolve(pi.handlers.get("input")[0](event, ctx));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The file logger is fire-and-forget (appendFile); poll briefly until the
// expected line lands so log assertions stay deterministic.
async function waitForLog(match, timeoutMs = 1500) {
  const t0 = Date.now();
  for (;;) {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
    if (match.test(content)) return content;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`log file never matched ${match}`);
    await sleep(10);
  }
}

beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error("fetch not installed in pi test");
  };
  globalThis.clearInterval = originalClearInterval;
  for (const k of ENV_KEYS) delete process.env[k];
  __test.reset();
  // Fresh log file per test (the logger is fire-and-forget; truncating here
  // keeps log assertions scoped to the current test).
  for (const f of [LOG_FILE, `${LOG_FILE}.1`])
    if (fs.existsSync(f)) fs.unlinkSync(f);
});

after(() => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.clearInterval = originalClearInterval;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __test.reset();
});

describe("pi extension registration", () => {
  it("registers the input gate, lifecycle events, and the native command", async () => {
    const pi = await loadPi();
    for (const event of [
      "input",
      "session_start",
      "session_shutdown",
      "model_select",
      "turn_start",
      "agent_start",
      "agent_end"
    ]) {
      assert.ok(pi.handlers.has(event), `missing handler: ${event}`);
    }
    assert.ok(pi.commands.has("neuron-extend"), "missing neuron-extend command");
    assert.match(
      pi.commands.get("neuron-extend").description,
      /1-720/
    );
  });
});

describe("pi input gate", () => {
  it("managed model + active reservation → continue (adopt, no create)", async () => {
    const pi = await loadPi(BASE_ENV, {
      activeReservations: [makeReservation("r-active")]
    });
    const ctx = makeCtx();
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(calls.createBodies.length, 0);
    // Healthy input does not refresh or create a reservation.
    assert.equal(calls.extendBodies.length, 0);
    assert.equal(ctx.notifications.length, 0);
  });

  it("managed model + no reservation → create + wait for healthy → continue", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(calls.createBodies.length, 1);
    // keepaliveMinutes comes from NEURON_RESERVATION_KEEPALIVE_MINUTES (5 in
    // BASE_ENV); durationMinutes from NEURON_RESERVATION_DURATION_MINUTES (2).
    assert.deepEqual(calls.createBodies[0], {
      modelIds: ["route-a"],
      targetIds: ["t1"],
      durationMinutes: 2,
      keepaliveMinutes: 5
    });
    // The bounded healthy wait polled the reservation status.
    assert.ok(calls.requests.includes("/api/reservations/r-created/status"));
    assert.equal(ctx.notifications.length, 0);
    // A second input reuses the local entry — no second create.
    await input(pi, { source: "interactive" }, makeCtx());
    assert.equal(calls.createBodies.length, 1);
  });

  it("hard wait timeout → notify + handled (turn dropped)", async () => {
    const pi = await loadPi(
      { ...BASE_ENV, NEURON_WAIT_TIMEOUT_SECONDS: "0.3" },
      { observed: "starting" }
    );
    const ctx = makeCtx();
    const t0 = Date.now();
    const result = await input(pi, { source: "interactive" }, ctx);
    const elapsed = Date.now() - t0;
    assert.deepEqual(result, { action: "handled" });
    assert.ok(elapsed < 2000, `wait should be bounded (took ${elapsed}ms)`);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].variant, "error");
    assert.match(ctx.notifications[0].message, /Timed out waiting for NeurOn reservation/);
  });

  it("control plane unreachable → notify + handled", async () => {
    const pi = await loadPi(BASE_ENV, { failAll: true });
    const ctx = makeCtx();
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].variant, "error");
    assert.match(ctx.notifications[0].message, /^NeurOn:/);
  });

  it("unmanaged provider → continue with zero fetches", async () => {
    const pi = await loadPi();
    const ctx = makeCtx({ model: { provider: "openai", id: "gpt-4o" } });
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(calls.requests.length, 0);
    assert.equal(ctx.notifications.length, 0);
  });

  it("managed provider, unknown route (no registry match) → continue, nothing reserved", async () => {
    const pi = await loadPi();
    const ctx = makeCtx({ model: { provider: "litellm", id: "route-unknown" } });
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    // The registry was consulted (that is how "not managed" is known), but
    // nothing was reserved and nothing was dropped.
    assert.ok(calls.status >= 1);
    assert.equal(calls.createBodies.length, 0);
    assert.equal(calls.extendBodies.length, 0);
    assert.equal(ctx.notifications.length, 0);
  });

  it("event.source 'extension' → skipped (no state, no fetches)", async () => {
    const pi = await loadPi();
    const ctx = makeCtx();
    const result = await input(pi, { source: "extension" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(calls.requests.length, 0);
    // Skipped before any session state is touched.
    assert.equal(__test.sessions.has("sess-1"), false);
  });

  it("throwing inner path → notify + handled (never pass-through)", async () => {
    const pi = await loadPi();
    // A model object whose id getter throws: the gate must catch it and
    // drop the turn instead of letting pi swallow the throw and let the
    // input pass through the gate.
    const ctx = makeCtx({
      model: {
        provider: "litellm",
        get id() {
          throw new Error("model access exploded");
        }
      }
    });
    const result = await input(pi, { source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].variant, "error");
    assert.match(ctx.notifications[0].message, /model access exploded/);
  });
});

describe("pi diagnostics go to the log file, not the terminal", () => {
  it("healthy local reservation → zero ui.notify; no reservation mutation", async () => {
    const pi = await loadPi(BASE_ENV, {
      activeReservations: [makeReservation("r-active")]
    });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // adopt existing lease
    assert.equal(ctx.notifications.length, 0);
    // A second message reuses the healthy local entry: the repeating
    // resolve/refresh diagnostics must not reach the terminal.
    const ctx2 = makeCtx();
    const result = await input(pi, { source: "interactive" }, ctx2);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(ctx2.notifications.length, 0);
    // The diagnostics landed in the log file instead.
    const content = await waitForLog(/input gate: healthy pass-through/);
    assert.doesNotMatch(content, /reservation decision: refresh local/);
    assert.match(content, /input gate: healthy pass-through/);
  });
});

describe("pi /neuron-extend command", () => {
  it("valid minutes → additive fromNow:false extend + exact success text", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // creates r-created
    const before = calls.extendBodies.length;
    await pi.commands.get("neuron-extend").handler("5", ctx);
    assert.equal(calls.extendBodies.length, before + 1);
    const ext = calls.extendBodies[before];
    assert.equal(ext.id, "r-created");
    assert.deepEqual(ext.body, { durationMinutes: 5, fromNow: false });
    const expected = `NeurOn: reservation r-created extended to ${formatClock(
      calls.extendExpiresAt
    )} (+5 min)`;
    const success = ctx.notifications.find((n) =>
      n.message.startsWith("NeurOn: reservation ")
    );
    assert.ok(success, "success notification missing");
    assert.equal(success.message, expected);
  });

  it("no argument → configured default minutes", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx);
    await pi.commands.get("neuron-extend").handler("", ctx);
    assert.equal(calls.extendBodies.length, 1);
    assert.deepEqual(calls.extendBodies[0].body, { durationMinutes: 2, fromNow: false });
  });

  it("bad arguments → usage notice, no extend call", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // session model + reservation
    const extendsBefore = calls.extendBodies.length;
    for (const bad of ["abc", "0", "721", "1.5", "-3"]) {
      const n0 = ctx.notifications.length;
      await pi.commands.get("neuron-extend").handler(bad, ctx);
      assert.equal(ctx.notifications.length, n0 + 1);
      assert.equal(
        ctx.notifications[n0].message,
        "NeurOn: usage: /neuron-extend [minutes 1-720]"
      );
    }
    assert.equal(calls.extendBodies.length, extendsBefore);
  });

  it("no session model → notice, no API call", async () => {
    const pi = await loadPi();
    // null (not undefined — the destructuring default would apply) so ctx
    // truly carries no model and nothing was recorded for the session.
    const ctx = makeCtx({ model: null });
    await pi.commands.get("neuron-extend").handler("", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].message, "NeurOn: no session model recorded yet");
    assert.equal(calls.requests.length, 0);
  });

  it("session model not managed → notice, no API call", async () => {
    const pi = await loadPi();
    const ctx = makeCtx({ model: { provider: "openai", id: "gpt-4o" } });
    await input(pi, { source: "interactive" }, ctx); // records model, passes through
    await pi.commands.get("neuron-extend").handler("5", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].message, "NeurOn: openai/gpt-4o is not managed");
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.extendBodies.length, 0);
  });

  it("no active reservation → notice, no extend/create", async () => {
    const pi = await loadPi();
    const ctx = makeCtx();
    // Record the session model via model_select (re-resolve only — no reserve).
    await pi.handlers.get("model_select")[0](
      {
        model: { provider: "litellm", id: "route-a" },
        previousModel: null,
        source: "user"
      },
      ctx
    );
    await sleep(20); // let the bounded resolution finish
    await pi.commands.get("neuron-extend").handler("5", ctx);
    assert.equal(
      ctx.notifications[0].message,
      "NeurOn: no active reservation — send a message to start one"
    );
    assert.equal(calls.extendBodies.length, 0);
    assert.equal(calls.createBodies.length, 0);
  });

  it("control plane unreachable → notice, no extend", async () => {
    const pi = await loadPi(BASE_ENV, { failAll: true });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // gate fails closed (fine)
    await pi.commands.get("neuron-extend").handler("5", ctx);
    const last = ctx.notifications[ctx.notifications.length - 1];
    assert.equal(last.message, "NeurOn: control plane unreachable — try again");
    assert.equal(calls.extendBodies.length, 0);
  });
});

describe("pi /neuron-done command", () => {
  it("marks the reservation done and reports the reservation id", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // creates r-created
    const doneBefore = calls.done;
    await pi.commands.get("neuron-done").handler("", ctx);
    assert.equal(calls.done, doneBefore + 1);
    assert.equal(calls.doneIds[calls.doneIds.length - 1], "r-created");
    const success = ctx.notifications.find((n) =>
      n.message.startsWith("NeurOn: reservation ")
    );
    assert.ok(success, "success notification missing");
    assert.equal(success.message, "NeurOn: reservation r-created ended");
  });

  it("clears local reservation state and keepalive timer after done", async () => {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    pi.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    await input(pi, { source: "interactive" }, ctx); // create + arm
    const s = __test.sessions.get("sess-1");
    assert.ok(s, "session entry missing");
    assert.ok(s.timer, "keepalive timer should be armed");

    await pi.commands.get("neuron-done").handler("", ctx);
    assert.equal(calls.done, 1);

    // Timer should be cleared
    const sAfter = __test.sessions.get("sess-1");
    assert.equal(sAfter.timer, null, "keepalive timer should be cleared after done");
    // Local reservation entry should be deleted
    assert.equal(
      __test.state.reservations.has("sess-1::t1"),
      false,
      "local reservation should be deleted after done"
    );
  });

  it("no session model → notice, no API call", async () => {
    const pi = await loadPi();
    const ctx = makeCtx({ model: null });
    await pi.commands.get("neuron-done").handler("", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].message, "NeurOn: no session model recorded yet");
    assert.equal(calls.requests.length, 0);
  });

  it("session model not managed → notice, no API call", async () => {
    const pi = await loadPi();
    const ctx = makeCtx({ model: { provider: "openai", id: "gpt-4o" } });
    await input(pi, { source: "interactive" }, ctx); // records model, passes through
    await pi.commands.get("neuron-done").handler("", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].message, "NeurOn: openai/gpt-4o is not managed");
    assert.equal(calls.done, 0);
  });

  it("no active reservation → notice, no done call", async () => {
    const pi = await loadPi();
    const ctx = makeCtx();
    await pi.handlers.get("model_select")[0](
      {
        model: { provider: "litellm", id: "route-a" },
        previousModel: null,
        source: "user"
      },
      ctx
    );
    await sleep(20);
    await pi.commands.get("neuron-done").handler("", ctx);
    assert.equal(
      ctx.notifications[0].message,
      "NeurOn: no active reservation to end"
    );
    assert.equal(calls.done, 0);
  });

  it("control plane unreachable → notice, no done", async () => {
    const pi = await loadPi(BASE_ENV, { failAll: true });
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx);
    await pi.commands.get("neuron-done").handler("", ctx);
    const last = ctx.notifications[ctx.notifications.length - 1];
    assert.equal(last.message, "NeurOn: control plane unreachable — try again");
    assert.equal(calls.done, 0);
  });
});

describe("pi keepalive", () => {
  async function seededSession() {
    const pi = await loadPi(BASE_ENV, { observed: "stopped" });
    const ctx = makeCtx();
    pi.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    await input(pi, { source: "interactive" }, ctx); // create + arm
    const s = __test.sessions.get("sess-1");
    assert.ok(s, "session entry missing");
    assert.ok(s.resKey, "resKey not set by saveReservation");
    return { pi, ctx, s };
  }

  it("session_start arms the 5 s interval", async () => {
    const { s } = await seededSession();
    assert.ok(s.timer, "keepalive timer not started");
  });

  it("due tick extends additively (fromNow:false)", async () => {
    const { s } = await seededSession();
    // Age the baseline past the due threshold (max(0.5·2min, 30s) = 60 s)
    // with recent activity since the last extend.
    s.lastExtendAt = Date.now() - 61000;
    s.lastActivityAt = Date.now() - 5000;
    __test.state.sessionActivity.set("sess-1", Date.now() - 5000);
    const before = calls.extendBodies.length;
    __test.tick("sess-1");
    await sleep(20); // let the extend resolve
    assert.equal(calls.extendBodies.length, before + 1);
    assert.deepEqual(calls.extendBodies[before].body, {
      durationMinutes: 2,
      fromNow: false
    });
    assert.ok(s.lastExtendAt > Date.now() - 61000, "lastExtendAt not advanced");
  });

  it("not-due tick makes no call", async () => {
    const { s } = await seededSession();
    s.lastExtendAt = Date.now(); // fresh baseline — not due
    s.lastActivityAt = Date.now();
    __test.state.sessionActivity.set("sess-1", Date.now());
    const before = calls.extendBodies.length;
    __test.tick("sess-1");
    await sleep(20);
    assert.equal(calls.extendBodies.length, before);
  });

  it("no activity since last extend → no call", async () => {
    const { s } = await seededSession();
    s.lastExtendAt = Date.now() - 61000; // due
    s.lastActivityAt = s.lastExtendAt; // but nothing new since that extend
    __test.state.sessionActivity.set("sess-1", s.lastExtendAt);
    const before = calls.extendBodies.length;
    __test.tick("sess-1");
    await sleep(20);
    assert.equal(calls.extendBodies.length, before);
  });

  it("session_shutdown clears the timer and stops fetches", async () => {
    const cleared = [];
    globalThis.clearInterval = (t) => {
      cleared.push(t);
      return originalClearInterval(t);
    };
    const { pi, ctx, s } = await seededSession();
    const timer = s.timer;
    assert.ok(timer, "expected a live timer");
    pi.handlers.get("session_shutdown")[0]({ reason: "quit" }, ctx);
    assert.equal(__test.sessions.has("sess-1"), false, "session not scrubbed");
    assert.ok(cleared.includes(timer), "timer not cleared on session_shutdown");
    const before = calls.requests.length;
    __test.tick("sess-1"); // must be a no-op after the scrub
    await sleep(20);
    assert.equal(calls.requests.length, before);
  });
});

describe("pi model_select", () => {
  it("re-resolves the target for the new model without reserving eagerly", async () => {
    const pi = await loadPi();
    const ctx = makeCtx();
    await input(pi, { source: "interactive" }, ctx); // route-a → t1, creates
    const creates = calls.createBodies.length;
    const extendsBefore = calls.extendBodies.length;
    await pi.handlers.get("model_select")[0](
      {
        model: { provider: "litellm", id: "route-b" },
        previousModel: { provider: "litellm", id: "route-a" },
        source: "user"
      },
      ctx
    );
    await sleep(20); // let the bounded resolution finish
    const s = __test.sessions.get("sess-1");
    assert.equal(s.model.bareModelId, "route-b");
    assert.equal(s.targetId, "t2");
    assert.equal(calls.createBodies.length, creates, "no eager create");
    assert.equal(calls.extendBodies.length, extendsBefore, "no eager extend");
  });
});
