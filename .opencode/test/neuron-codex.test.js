// Unit tests for the Codex CLI adapter (../../.codex/src/neuron-codex.js).
// Fake-fetch pattern mirrors test/neuron-core.test.js: globalThis.fetch is
// swapped for a route table. The state dir is overridden via NEURON_STATE_DIR
// (temp dir) and the codex home via the injected codexHome option, so the
// real ~/.codex is never touched.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_LABEL,
  loadCodexConfig,
  stateDirFromEnv,
  parseArgs,
  extractTomlValue,
  resolveCodexModel,
  resolveModelStatus,
  findActiveReservationForTarget,
  writeLeaseAtomic,
  listLeases,
  pickLatestActiveLease,
  parseMinutes,
  keeperLoop,
  cmdResolve,
  cmdEnsure,
  cmdExtend,
  cmdDone,
  cmdLeases,
  cmdStatus,
  cmdHook,
  hookTrustHash,
  canonicalJsonString,
  hookWaitSeconds,
  handleMcpMessage,
  HOOK_WAIT_CAP_S,
  tomlEscape,
  NeurOnApiError
} from "../../.codex/src/neuron-codex.js";

const originalFetch = globalThis.fetch;

const ROUTE = "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL";
const TARGET = "g6.xlarge.qwen-9b";
const MODEL_ID = "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL";

// ── Fixtures ──────────────────────────────────────────────

function jsonResponse(data) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
  );
}

// Route-table fetch: entries are { path, method?, respond? | body? | error? }.
function installFetch(routes) {
  const calls = { requests: [], extendBodies: [], createBodies: [] };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.requests.push(path);
    // Username discovery (adoption scoping) — always available in tests.
    if (path === "/api/me") return jsonResponse({ username: "testuser", isAdmin: false });
    const route = routes.find((r) => r.path === path && (!r.method || options.method === r.method));
    if (!route) throw new Error(`unexpected fetch in codex test: ${path}`);
    if (route.respond) return route.respond(options);
    if (route.error instanceof Error) throw route.error;
    if (options.method === "POST" && path.endsWith("/extend")) calls.extendBodies.push(JSON.parse(options.body ?? "null"));
    if (options.method === "POST" && path === "/api/reservations") calls.createBodies.push(JSON.parse(options.body ?? "null"));
    return jsonResponse(route.body ?? {});
  };
  return calls;
}

function makeStatus({ observed = "healthy", activeReservation } = {}) {
  return {
    capacityTargets: [
      { id: TARGET, modelIds: [MODEL_ID], provider: "aws-ec2", observed }
    ],
    models: [{ id: MODEL_ID, targetIds: [TARGET] }],
    activeReservations: activeReservation ? [activeReservation] : [],
    reservations: []
  };
}

function makeReservation(reservationId = "r1", expiresMs = 120000) {
  return {
    reservationId,
    username: "testuser", // must match the /api/me mock (adoption scoping)
    status: "active",
    expiresAt: new Date(Date.now() + expiresMs).toISOString(),
    keepaliveMinutes: 2,
    modelIds: [MODEL_ID],
    targets: [{ id: TARGET, observed: "healthy" }]
  };
}

function makeReservationStatus(observed = "healthy") {
  return { reservationId: "r1", targets: [{ id: TARGET, observed }] };
}

// A realistic ~/.codex: base config (sections that must NOT confuse the
// flat `model = "..."` extraction) + one profile with its own model.
async function makeCodexHome() {
  const home = await mkdtemp(join(tmpdir(), "neuron-codex-home-"));
  await writeFile(
    join(home, "config.toml"),
    [
      'model_provider = "litellm"',
      `model = "${ROUTE}"`,
      "model_catalog_json = 'C:\\fake\\catalog.json'",
      'model_reasoning_effort = "medium"',
      "",
      "[model_providers.litellm]",
      'name = "litellm"',
      'base_url = "http://127.0.0.1:8931/v1"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(home, "p1.config.toml"),
    ['model = "g6e.xlarge.qwen-35b-a3b/qwen-3.6-35b-a3b"', "model_provider = \"litellm\"", ""].join("\n"),
    "utf8"
  );
  // A profile with no model key — must fall through to the base config.
  await writeFile(join(home, "p2.config.toml"), ['model_provider = "litellm"', ""].join("\n"), "utf8");
  return home;
}

function makeEnv(overrides = {}) {
  return {
    NEURON_API_BASE_URL: "http://neuron.test:8090",
    NEURON_API_KEY: "test-key",
    NEURON_WAIT_TIMEOUT_SECONDS: "0.2",
    NEURON_WAIT_POLL_SECONDS: "0.02",
    ...overrides
  };
}

function makeIo() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

let stateDir;
let codexHome;

beforeEach(async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch not installed in codex test");
  };
  stateDir = await mkdtemp(join(tmpdir(), "neuron-codex-state-"));
  codexHome = await makeCodexHome();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(stateDir, { recursive: true, force: true });
  await rm(codexHome, { recursive: true, force: true });
});

// ── Config / paths / argv ─────────────────────────────────

describe("neuron-codex config and paths", () => {
  it("labels the harness Codex and reads the wait timeout in seconds", () => {
    assert.equal(HARNESS_LABEL, "Codex");
    const cfg = loadCodexConfig({
      NEURON_API_BASE_URL: "http://neuron.test:8090",
      NEURON_API_KEY: "k",
      NEURON_WAIT_TIMEOUT_SECONDS: "90",
      NEURON_RESERVATION_DURATION_MINUTES: "30"
    });
    assert.equal(cfg.harnessLabel, "Codex");
    assert.equal(cfg.waitTimeoutMs, 90000);
    assert.equal(cfg.durationMinutes, 30);
    // Default: hard 40 s.
    const def = loadCodexConfig({ NEURON_API_BASE_URL: "http://n:1", NEURON_API_KEY: "k" });
    assert.equal(def.waitTimeoutMs, 40000);
  });

  it("derives the state dir from ~/.codex with NEURON_STATE_DIR override", () => {
    assert.equal(
      stateDirFromEnv({ USERPROFILE: "C:\\u", NEURON_STATE_DIR: "C:\\override" }),
      "C:\\override"
    );
    assert.equal(stateDirFromEnv({ USERPROFILE: "C:\\u" }), join("C:\\u", ".codex", "neuron"));
    assert.equal(
      stateDirFromEnv({ USERPROFILE: "C:\\u", NEURON_CODEX_HOME: "C:\\alt" }),
      join("C:\\alt", "neuron")
    );
  });

  it("parses --flag value and --flag=value forms", () => {
    assert.deepEqual(
      parseArgs(["ensure", "--model", "m", "--lease-file", "f.json"]),
      { _: ["ensure"], model: "m", "lease-file": "f.json" }
    );
    assert.deepEqual(parseArgs(["extend", "--minutes=5"]), { _: ["extend"], minutes: "5" });
  });

  it("parses minutes: integer 1-720 else the configured default", () => {
    assert.equal(parseMinutes("5", 2), 5);
    assert.equal(parseMinutes("720", 2), 720);
    assert.equal(parseMinutes("", 2), 2);
    assert.equal(parseMinutes(undefined, 30), 30);
    assert.equal(parseMinutes("0", 2), 2);
    assert.equal(parseMinutes("721", 2), 2);
    assert.equal(parseMinutes("abc", 2), 2);
    assert.equal(parseMinutes("2.5", 2), 2);
    assert.equal(parseMinutes("-3", 2), 2);
  });
});

// ── Codex launch-model resolution (toml fixtures) ─────────

describe("neuron-codex model resolution precedence (toml fixtures)", () => {
  // resolveCodexModel is synchronous — the reader must be too.
  function opts() {
    return { codexHome, readText: (p) => readFileSync(p, "utf8") };
  }

  it("extractTomlValue matches exact top-level keys only", async () => {
    const text = await readFile(join(codexHome, "config.toml"), "utf8");
    assert.equal(extractTomlValue(text, "model"), ROUTE);
    assert.equal(extractTomlValue(text, "model_provider"), "litellm");
    assert.equal(extractTomlValue(text, "model_catalog_json"), "C:\\fake\\catalog.json");
    // model must not match model_provider / model_catalog_json / section keys.
    assert.equal(extractTomlValue(text, "sandbox"), undefined); // inside [windows]
    assert.equal(extractTomlValue(text, "name"), undefined); // inside [model_providers.litellm] — sections never shadow top-level keys
  });

  it("supports double- and single-quoted values", () => {
    assert.equal(extractTomlValue('model = "a/b"', "model"), "a/b");
    assert.equal(extractTomlValue("model = 'a/b'", "model"), "a/b");
    assert.equal(extractTomlValue("# model = \"commented\"", "model"), undefined);
  });

  it("-m/--model argument wins over profile and config", async () => {
    const r = resolveCodexModel(["exec", "-m", "arg-model", "--profile", "p1"], opts());
    assert.equal(r.model, "arg-model");
    assert.equal(r.source, "arg");
    const r2 = resolveCodexModel(["--model=eq-model"], opts());
    assert.equal(r2.model, "eq-model");
    assert.equal(r2.source, "arg");
  });

  it("--profile <p> reads ~/.codex/<p>.config.toml model", async () => {
    const r = resolveCodexModel(["--profile", "p1"], opts());
    assert.equal(r.model, "g6e.xlarge.qwen-35b-a3b/qwen-3.6-35b-a3b");
    assert.equal(r.source, "profile:p1");
    assert.equal(r.provider, "litellm");
  });

  it("a missing profile file falls through to the base config", async () => {
    const r = resolveCodexModel(["--profile", "nope"], opts());
    assert.equal(r.model, ROUTE);
    assert.equal(r.source, "config");
  });

  it("a profile without a model key falls through to the base config", async () => {
    const r = resolveCodexModel(["--profile", "p2"], opts());
    assert.equal(r.model, ROUTE);
    assert.equal(r.source, "config");
  });

  it("no arguments → base config model + provider", async () => {
    const r = resolveCodexModel([], opts());
    assert.equal(r.model, ROUTE);
    assert.equal(r.source, "config");
    assert.equal(r.provider, "litellm");
  });

  it("nothing resolvable → no model", async () => {
    const empty = await mkdtemp(join(tmpdir(), "neuron-codex-empty-"));
    const r = resolveCodexModel([], { codexHome: empty });
    assert.equal(r.model, undefined);
    assert.equal(r.source, undefined);
    await rm(empty, { recursive: true, force: true });
  });
});

// ── resolve: managed / unmanaged / unreachable ────────────

describe("neuron-codex resolve subcommand", () => {
  const status = makeStatus({ observed: "stopped" });
  const baseRoutes = () => [
    { path: "/api/status", body: status },
    { path: "/api/models", body: { models: status.models } }
  ];

  it("reports managed models with the dedicated target id", async () => {
    const calls = installFetch(baseRoutes());
    const { io, out } = makeIo();
    const code = await cmdResolve({
      args: { model: ROUTE },
      env: makeEnv(),
      io,
      codexHome
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.join("\n")), { managed: true, targetId: TARGET });
    assert.deepEqual(calls.requests.sort(), ["/api/models", "/api/status"]);
  });

  it("reports unmanaged models with a reason", async () => {
    installFetch(baseRoutes());
    const { io, out } = makeIo();
    const code = await cmdResolve({
      args: { model: "totally/unknown-model" },
      env: makeEnv(),
      io,
      codexHome
    });
    assert.equal(code, 0);
    const r = JSON.parse(out.join("\n"));
    assert.equal(r.managed, false);
    assert.match(r.reason, /^not_managed:/);
  });

  it("applies the NEURON_ALLOWED_PROVIDERS filter on the agent-side provider", async () => {
    installFetch(baseRoutes());
    const { io, out } = makeIo();
    const code = await cmdResolve({
      args: { model: ROUTE },
      env: makeEnv({ NEURON_ALLOWED_PROVIDERS: "openai" }),
      io,
      codexHome
    });
    assert.equal(code, 0);
    const r = JSON.parse(out.join("\n"));
    assert.equal(r.managed, false);
    assert.match(r.reason, /^provider_not_allowed: provider=litellm allowed=openai$/);
  });

  it("fails open with a control_plane_unreachable reason (exit 0)", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8090");
    };
    const { io, out } = makeIo();
    const code = await cmdResolve({
      args: { model: ROUTE },
      env: makeEnv(),
      io,
      codexHome
    });
    assert.equal(code, 0);
    const r = JSON.parse(out.join("\n"));
    assert.equal(r.managed, false);
    assert.match(r.reason, /^control_plane_unreachable: /);
  });
});

// ── ensure: adopt vs create, bounded wait, fail-open ──────

describe("neuron-codex ensure subcommand", () => {
  function env() {
    return makeEnv({ NEURON_STATE_DIR: stateDir });
  }

  it("creates a reservation when none is active and writes the lease atomically", async () => {
    const calls = installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("healthy") }
    ]);
    const { io, out, err } = makeIo();
    const code = await cmdEnsure({ args: { model: ROUTE }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 0);

    assert.equal(calls.createBodies.length, 1);
    assert.deepEqual(calls.createBodies[0], {
      modelIds: [MODEL_ID],
      targetIds: [TARGET],
      durationMinutes: 2,
      keepaliveMinutes: 2
    });

    // stdout carries exactly the lease path (the machine contract for the
    // launcher); human lines go to stderr.
    const leaseFile = out.join("\n").trim();
    assert.match(leaseFile, /r1\.json$/);
    const lease = JSON.parse(await readFile(leaseFile, "utf8"));
    assert.equal(lease.reservationId, "r1");
    assert.equal(lease.targetId, TARGET);
    assert.equal(lease.model, ROUTE);
    assert.ok(lease.expiresAt, "lease records the server expiry");
    assert.ok(lease.lifetimeMs > 90000 && lease.lifetimeMs <= 120000);
    assert.equal(lease.pid, null); // placeholder until the launcher stamps it
    assert.match(err.join("\n"), /reservation r1 created for target g6\.xlarge\.qwen-9b/);
    // Atomic write: no tmp leftovers.
    const entries = await readdir(stateDir);
    assert.equal(entries.filter((n) => n.includes(".tmp-")).length, 0);
  });

  it("adopts an existing active reservation for the target (no create)", async () => {
    const status = makeStatus({ activeReservation: makeReservation("r-adopt") });
    const calls = installFetch([
      { path: "/api/status", body: status },
      { path: "/api/models", body: { models: status.models } },
      { path: "/api/reservations/r-adopt/status", body: { reservationId: "r-adopt", targets: [{ id: TARGET, observed: "healthy" }] } }
    ]);
    const { io, out } = makeIo();
    const code = await cmdEnsure({ args: { model: ROUTE }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 0);
    assert.equal(calls.createBodies.length, 0);
    const lease = JSON.parse(await readFile(out.join("\n").trim(), "utf8"));
    assert.equal(lease.reservationId, "r-adopt");
  });

  it("honors --lease-file and does not adopt reservations for other targets", async () => {
    const other = { ...makeReservation("r-other"), targets: [{ id: "some-other-target", observed: "healthy" }] };
    const status = makeStatus({ activeReservation: other });
    installFetch([
      { path: "/api/status", body: status },
      { path: "/api/models", body: { models: status.models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("healthy") }
    ]);
    const { io, out } = makeIo();
    const custom = join(stateDir, "custom", "my-lease.json");
    const code = await cmdEnsure({
      args: { model: ROUTE, "lease-file": custom },
      env: env(),
      io,
      codexHome,
      stateDir
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), custom);
    const lease = JSON.parse(await readFile(custom, "utf8"));
    assert.equal(lease.reservationId, "r1"); // created fresh, not the other-target reservation
  });

  it("fails closed (exit 2) when the healthy wait hits the hard timeout", async () => {
    installFetch([
      { path: "/api/status", body: makeStatus({ observed: "stopped" }) },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("warming") }
    ]);
    const { io, err, out } = makeIo();
    const code = await cmdEnsure({ args: { model: ROUTE }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /timed out after 200ms waiting for NeurOn reservation r1 to become healthy \(g6\.xlarge\.qwen-9b:warming\)/);
    assert.equal(out.join("\n").trim(), "");
    assert.equal((await readdir(stateDir)).filter((n) => n.endsWith(".json")).length, 0);
  });

  it("fails closed (exit 2) immediately on a failed target", async () => {
    installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      {
        path: "/api/reservations/r1/status",
        body: { reservationId: "r1", targets: [{ id: TARGET, observed: "failed", message: "crash loop" }] }
      }
    ]);
    const { io, err } = makeIo();
    const code = await cmdEnsure({ args: { model: ROUTE }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /NeurOn target g6\.xlarge\.qwen-9b failed: crash loop/);
  });

  it("fails open (exit 0 + warning, no lease) when the control plane is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { io, err, out } = makeIo();
    const code = await cmdEnsure({ args: { model: ROUTE }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 0);
    assert.match(err.join("\n"), /control plane unreachable/);
    assert.equal(out.join("\n").trim(), "");
    assert.equal((await readdir(stateDir)).filter((n) => n.endsWith(".json")).length, 0);
  });

  it("fails closed (exit 2) for an unmanaged model", async () => {
    installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } }
    ]);
    const { io, err } = makeIo();
    const code = await cmdEnsure({ args: { model: "nope/unknown" }, env: env(), io, codexHome, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /not_managed/);
  });
});

// ── keeper: policy tick with injected timer + PID liveness ─

describe("neuron-codex keeper loop", () => {
  function setup({ aliveUntilTick = 13, extendBehavior = "ok" } = {}) {
    let t = 1_000_000;
    const now = () => t;
    const sleepFn = async () => {
      t += 5000; // one tick = 5 s
    };
    let checks = 0;
    const isPidAliveFn = async () => {
      checks += 1;
      return checks <= aliveUntilTick;
    };
    const extendCalls = [];
    const client = {
      extendReservation: async (id, minutes, { fromNow }) => {
        extendCalls.push({ id, minutes, fromNow });
        if (extendBehavior === "reject400") {
          throw new NeurOnApiError(400, "/api/reservations/r1/extend", "duration must be between 1 and 720 minutes", "Bad Request");
        }
        if (extendBehavior === "reject404") {
          throw new NeurOnApiError(404, "/api/reservations/r1/extend", "Not Found", "Not Found");
        }
        return { reservationId: id, expiresAt: new Date(now() + 240000).toISOString() };
      }
    };
    const logs = [];
    const leaseWrites = [];
    const lease = {
      reservationId: "r1",
      targetId: TARGET,
      model: ROUTE,
      expiresAt: new Date(now() + 120000).toISOString(),
      lifetimeMs: 120000,
      pid: 4242
    };
    return {
      now,
      sleepFn,
      isPidAliveFn,
      client,
      extendCalls,
      logs,
      lease,
      leaseWrites,
      config: { durationMinutes: 2 }
    };
  }

  it("extends when due (half the lifetime), never before, with the additive payload", async () => {
    const s = setup();
    const code = await keeperLoop({
      lease: s.lease,
      pid: 4242,
      client: s.client,
      config: s.config,
      tickMs: 5000,
      stateDir,
      leaseFile: join(stateDir, "r1.json"),
      now: s.now,
      sleepFn: s.sleepFn,
      isPidAlive: s.isPidAliveFn,
      log: (l) => s.logs.push(l),
      writeLease: async (dir, lease, name) => {
        s.leaseWrites.push({ dir, lease, name });
      }
    });
    assert.equal(code, 0);
    // Lifetime 120 s → due exactly at 60 s = tick 13 (12 sleeps of 5 s).
    assert.equal(s.extendCalls.length, 1);
    assert.deepEqual(s.extendCalls[0], { id: "r1", minutes: 2, fromNow: false });
    assert.ok(s.logs.some((l) => l.includes("extended to") && l.includes("(+2 min, fromNow:false)")));
    assert.match(s.logs.at(-1), /keeper stop: codex pid=4242 exited/);
    // The lease was rewritten with the advanced expiry.
    assert.equal(s.leaseWrites.length, 1);
    assert.equal(s.leaseWrites[0].name, "r1.json");
    assert.ok(Date.parse(s.leaseWrites[0].lease.expiresAt) > Date.parse(s.lease.expiresAt));
  });

  it("stops cleanly when the PID is already gone (no extends, exit 0)", async () => {
    const s = setup({ aliveUntilTick: 0 });
    const code = await keeperLoop({
      lease: s.lease,
      pid: 4242,
      client: s.client,
      config: s.config,
      tickMs: 5000,
      stateDir,
      leaseFile: join(stateDir, "r1.json"),
      now: s.now,
      sleepFn: s.sleepFn,
      isPidAlive: s.isPidAliveFn,
      log: (l) => s.logs.push(l)
    });
    assert.equal(code, 0);
    assert.equal(s.extendCalls.length, 0);
    assert.match(s.logs.at(-1), /keeper stop: codex pid=4242 exited/);
  });

  it("treats an unknown PID state as alive (keeps polling)", async () => {
    const s = setup({ aliveUntilTick: 3 });
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 2) return null; // unknown
      return calls <= 3;
    };
    const code = await keeperLoop({
      lease: s.lease,
      pid: 4242,
      client: s.client,
      config: s.config,
      tickMs: 5000,
      stateDir,
      leaseFile: join(stateDir, "r1.json"),
      now: s.now,
      sleepFn: s.sleepFn,
      isPidAlive: flaky,
      log: (l) => s.logs.push(l),
      maxTicks: 4
    });
    // Four liveness checks ran (ticks 1-4): the null at tick 2 never stopped
    // the loop — it ran to the real death at tick 4, so unknown = alive.
    assert.equal(code, 0);
    assert.equal(calls, 4);
    assert.equal(s.extendCalls.length, 0); // only ~20 s elapsed — not due
    assert.match(s.logs.at(-1), /keeper stop: codex pid=4242 exited/);
  });

  it("stops with exit 1 when the server permanently rejects the extend (404)", async () => {
    const s = setup({ extendBehavior: "reject404", aliveUntilTick: 99 });
    const code = await keeperLoop({
      lease: s.lease,
      pid: 4242,
      client: s.client,
      config: s.config,
      tickMs: 5000,
      stateDir,
      leaseFile: join(stateDir, "r1.json"),
      now: s.now,
      sleepFn: s.sleepFn,
      isPidAlive: s.isPidAliveFn,
      log: (l) => s.logs.push(l),
      maxTicks: 20
    });
    assert.equal(code, 1);
    assert.match(s.logs.at(-1), /keeper stop: extend rejected \(HTTP 404\)/);
  });

  it("retries transient extend errors on the next due tick instead of stopping", async () => {
    const s = setup({ extendBehavior: "ok", aliveUntilTick: 99 });
    let n = 0;
    const flakyClient = {
      extendReservation: async (id, minutes, opts) => {
        n += 1;
        if (n === 1) throw new Error("socket hang up"); // transient
        return { reservationId: id, expiresAt: new Date(s.now() + 240000).toISOString() };
      }
    };
    const code = await keeperLoop({
      lease: s.lease,
      pid: 4242,
      client: flakyClient,
      config: s.config,
      tickMs: 5000,
      stateDir,
      leaseFile: join(stateDir, "r1.json"),
      now: s.now,
      sleepFn: s.sleepFn,
      isPidAlive: s.isPidAliveFn,
      log: (l) => s.logs.push(l),
      maxTicks: 15
    });
    assert.equal(code, 0); // maxTicks — the loop survived the transient failure
    assert.equal(n, 2); // one failed attempt + one successful retry at the next due tick
    assert.ok(s.logs.some((l) => l.startsWith("keepalive error (will retry next tick)")));
  });
});

// ── extend: minutes validation, additive result, lease pick ─

describe("neuron-codex extend subcommand", () => {
  function env(overrides = {}) {
    return makeEnv({ NEURON_STATE_DIR: stateDir, ...overrides });
  }
  async function seedLeases() {
    const expired = makeReservation("r-expired", -60000);
    await writeLeaseAtomic(stateDir, {
      reservationId: expired.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: expired.expiresAt,
      lifetimeMs: 60000,
      pid: 1111
    });
    const active = makeReservation("r-active", 300000);
    await writeLeaseAtomic(stateDir, {
      reservationId: active.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: active.expiresAt,
      lifetimeMs: 300000,
      pid: 2222
    });
  }

  it("extends the latest active lease additively and prints the clock line", async () => {
    await seedLeases();
    const calls = installFetch([
      { path: "/api/reservations/r-active/extend", method: "POST", body: makeReservation("r-active", 330000) }
    ]);
    const { io, out } = makeIo();
    const code = await cmdExtend({ args: { minutes: "5" }, env: env(), io, stateDir });
    assert.equal(code, 0);
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 5, fromNow: false }]);
    assert.match(out.join("\n"), /^NeurOn: reservation r-active extended to \d{1,2}:\d{2}:\d{2} (AM|PM) \(\+5 min\)$/);
  });

  it("accepts the minutes positionally (extend 5), as parseArgs produces them", async () => {
    await seedLeases();
    const calls = installFetch([
      { path: "/api/reservations/r-active/extend", method: "POST", body: makeReservation("r-active", 330000) }
    ]);
    const { io, out } = makeIo();
    // parseArgs(["extend", "5"]) → { _: ["extend", "5"] } (no minutes key).
    const code = await cmdExtend({ args: { _: ["extend", "5"] }, env: env(), io, stateDir });
    assert.equal(code, 0);
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 5, fromNow: false }]);
    assert.match(out.join("\n"), /\(\+5 min\)$/);
  });

  it("falls back to the configured default on bad minutes input (never throws)", async () => {
    await seedLeases();
    for (const bad of ["0", "721", "abc", "2.5"]) {
      const calls = installFetch([
        { path: "/api/reservations/r-active/extend", method: "POST", body: makeReservation("r-active", 330000) }
      ]);
      const { io } = makeIo();
      const code = await cmdExtend({ args: { minutes: bad }, env: env(), io, stateDir });
      assert.equal(code, 0);
      assert.deepEqual(calls.extendBodies, [{ durationMinutes: 2, fromNow: false }]); // default 2
    }
  });

  it("uses NEURON_RESERVATION_DURATION_MINUTES as the default when set", async () => {
    await seedLeases();
    const calls = installFetch([
      { path: "/api/reservations/r-active/extend", method: "POST", body: makeReservation("r-active", 330000) }
    ]);
    const { io } = makeIo();
    const code = await cmdExtend({
      args: {},
      env: env({ NEURON_RESERVATION_DURATION_MINUTES: "30" }),
      io,
      stateDir
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 30, fromNow: false }]);
  });

  it("honors --lease-id explicitly", async () => {
    await seedLeases();
    const calls = installFetch([
      { path: "/api/reservations/r-expired/extend", method: "POST", body: makeReservation("r-expired", 600000) }
    ]);
    const { io } = makeIo();
    const code = await cmdExtend({ args: { minutes: "10", "lease-id": "r-expired" }, env: env(), io, stateDir });
    assert.equal(code, 0);
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 10, fromNow: false }]);
  });

  it("surfaces a 400 rejection verbatim and exits 2", async () => {
    await seedLeases();
    installFetch([
      {
        path: "/api/reservations/r-active/extend",
        method: "POST",
        error: new NeurOnApiError(400, "/api/reservations/r-active/extend", "duration must be between 1 and 720 minutes", "Bad Request")
      }
    ]);
    const { io, err } = makeIo();
    const code = await cmdExtend({ args: { minutes: "5" }, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /NeurOn: extend rejected — duration must be between 1 and 720 minutes/);
  });

  it("reports a transport failure as unreachable and exits 2", async () => {
    await seedLeases();
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { io, err } = makeIo();
    const code = await cmdExtend({ args: { minutes: "5" }, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /control plane unreachable — try again/);
  });

  it("exits 2 when there is no active lease", async () => {
    const { io, err } = makeIo();
    const code = await cmdExtend({ args: { minutes: "5" }, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /no active lease found/);
  });
});

describe("neuron-codex done subcommand", () => {
  function env(overrides = {}) {
    return makeEnv({ NEURON_STATE_DIR: stateDir, ...overrides });
  }
  async function seedLeases() {
    const expired = makeReservation("r-expired", -60000);
    await writeLeaseAtomic(stateDir, {
      reservationId: expired.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: expired.expiresAt,
      lifetimeMs: 60000,
      pid: 1111
    });
    const active = makeReservation("r-active", 300000);
    await writeLeaseAtomic(stateDir, {
      reservationId: active.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: active.expiresAt,
      lifetimeMs: 300000,
      pid: 2222
    });
  }

  it("marks the latest active lease done and prints the ended line", async () => {
    await seedLeases();
    installFetch([
      { path: "/api/reservations/r-active/done", method: "POST", body: makeReservation("r-active", 0) }
    ]);
    const { io, out } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /^NeurOn: reservation r-active ended$/);
  });

  it("marks the lease file inactive after done", async () => {
    await seedLeases();
    installFetch([
      { path: "/api/reservations/r-active/done", method: "POST", body: makeReservation("r-active", 0) }
    ]);
    const { io } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 0);
    const leaseFile = join(stateDir, "r-active.json");
    const lease = JSON.parse(await readFile(leaseFile, "utf8"));
    assert.equal(lease.active, false);
    assert.ok(lease.endedAt, "endedAt should be set");
  });

  it("honors --lease-id explicitly", async () => {
    await seedLeases();
    installFetch([
      { path: "/api/reservations/r-expired/done", method: "POST", body: makeReservation("r-expired", 0) }
    ]);
    const { io, out } = makeIo();
    const code = await cmdDone({ args: { "lease-id": "r-expired" }, env: env(), io, stateDir });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /^NeurOn: reservation r-expired ended$/);
  });

  it("surfaces a 400 rejection verbatim and exits 2", async () => {
    await seedLeases();
    installFetch([
      {
        path: "/api/reservations/r-active/done",
        method: "POST",
        error: new NeurOnApiError(400, "/api/reservations/r-active/done", "reservation is already done", "Bad Request")
      }
    ]);
    const { io, err } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /NeurOn: end rejected — reservation is already done/);
  });

  it("surfaces a 404 rejection verbatim and exits 2", async () => {
    await seedLeases();
    installFetch([
      {
        path: "/api/reservations/r-active/done",
        method: "POST",
        error: new NeurOnApiError(404, "/api/reservations/r-active/done", "reservation not found", "Not Found")
      }
    ]);
    const { io, err } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /NeurOn: end rejected — reservation not found/);
  });

  it("reports a transport failure as unreachable and exits 2", async () => {
    await seedLeases();
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { io, err } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /control plane unreachable — try again/);
  });

  it("exits 2 when there is no active lease", async () => {
    const { io, err } = makeIo();
    const code = await cmdDone({ args: {}, env: env(), io, stateDir });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /no active lease found/);
  });
});

// ── lease files: atomic write, list, pick ─────────────────

describe("neuron-codex lease file handling", () => {
  const lease = () => ({
    reservationId: "r1",
    targetId: TARGET,
    model: ROUTE,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    lifetimeMs: 120000,
    pid: null
  });

  it("writeLeaseAtomic creates the dir, writes valid JSON, leaves no tmp files", async () => {
    const dir = join(stateDir, "nested", "dir");
    const l = lease();
    const file = await writeLeaseAtomic(dir, l);
    assert.equal(file, join(dir, "r1.json"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), l);
    assert.equal((await readdir(dir)).filter((n) => n.includes(".tmp-")).length, 0);
  });

  it("writeLeaseAtomic overwrites an existing lease (rename-in-place)", async () => {
    const l1 = lease();
    await writeLeaseAtomic(stateDir, l1);
    const l2 = { ...l1, expiresAt: new Date(Date.now() + 240000).toISOString(), pid: 777 };
    await writeLeaseAtomic(stateDir, l2);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "r1.json"), "utf8")), l2);
    assert.equal((await readdir(stateDir)).filter((n) => n.includes(".tmp-")).length, 0);
  });

  it("concurrent writes serialize via the lock and the file stays valid", async () => {
    await Promise.all([
      writeLeaseAtomic(stateDir, { ...lease(), pid: 1 }),
      writeLeaseAtomic(stateDir, { ...lease(), pid: 2 }),
      writeLeaseAtomic(stateDir, { ...lease(), pid: 3 })
    ]);
    const parsed = JSON.parse(await readFile(join(stateDir, "r1.json"), "utf8"));
    assert.ok([1, 2, 3].includes(parsed.pid)); // exactly one writer won
    assert.equal((await readdir(stateDir)).filter((n) => n.includes(".tmp-")).length, 0);
  });

  it("listLeases flags active vs expired and skips corrupt files", async () => {
    await writeLeaseAtomic(stateDir, { ...lease(), expiresAt: new Date(Date.now() + 60000).toISOString() });
    await writeFile(join(stateDir, "r2.json"), "{not json", "utf8");
    const leases = await listLeases(stateDir);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].reservationId, "r1");
    assert.equal(leases[0].active, true);
    assert.equal(leases[0].pid, null);
  });

  it("pickLatestActiveLease picks the furthest-future active lease", async () => {
    const soon = new Date(Date.now() + 120000).toISOString();
    const far = new Date(Date.now() + 600000).toISOString();
    await writeLeaseAtomic(stateDir, { ...lease(), reservationId: "r-soon", expiresAt: soon });
    await writeLeaseAtomic(stateDir, { ...lease(), reservationId: "r-far", expiresAt: far });
    await writeLeaseAtomic(stateDir, { ...lease(), reservationId: "r-dead", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const picked = await pickLatestActiveLease(stateDir);
    assert.equal(picked.reservationId, "r-far");
  });
});

// ── leases / status subcommands ───────────────────────────

describe("neuron-codex leases and status subcommands", () => {
  it("leases prints a JSON summary of the state dir", async () => {
    const r = makeReservation("r1", 120000);
    await writeLeaseAtomic(stateDir, {
      reservationId: r.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: r.expiresAt,
      lifetimeMs: 120000,
      pid: 31337
    });
    const { io, out } = makeIo();
    const code = await cmdLeases({ env: makeEnv({ NEURON_STATE_DIR: stateDir }), io, stateDir });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join("\n"));
    assert.equal(summary.count, 1);
    assert.equal(summary.leases[0].reservationId, "r1");
    assert.equal(summary.leases[0].pid, 31337);
    assert.equal(summary.leases[0].active, true);
  });

  it("leases ignores foreign JSON files such as the ESM marker package.json", async () => {
    const r = makeReservation("r1", 120000);
    await writeLeaseAtomic(stateDir, {
      reservationId: r.reservationId,
      targetId: TARGET,
      model: ROUTE,
      expiresAt: r.expiresAt,
      lifetimeMs: 120000,
      pid: 31337
    });
    // The marker sync.ps1 installs next to the bundle: valid JSON, not a lease.
    await writeFile(join(stateDir, "package.json"), '{"type":"module"}', "utf8");
    const { io, out } = makeIo();
    const code = await cmdLeases({ env: makeEnv({ NEURON_STATE_DIR: stateDir }), io, stateDir });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join("\n"));
    assert.equal(summary.count, 1);
    assert.deepEqual(summary.leases.map((l) => l.reservationId), ["r1"]);
    const listed = await listLeases(stateDir);
    assert.deepEqual(listed.map((l) => l.file), [join(stateDir, "r1.json")]);
  });

  it("status includes the control plane when reachable and degrades gracefully when not", async () => {
    const status = makeStatus();
    installFetch([
      { path: "/api/status", body: status },
      { path: "/api/models", body: { models: status.models } }
    ]);
    const { io, out } = makeIo();
    const code = await cmdStatus({ env: makeEnv(), io, stateDir });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join("\n"));
    assert.equal(summary.controlPlane.capacityTargets[0].id, TARGET);
    assert.equal(summary.count, 0);

    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const io2 = makeIo();
    const code2 = await cmdStatus({ env: makeEnv(), io: io2.io, stateDir });
    assert.equal(code2, 0);
    const summary2 = JSON.parse(io2.out.join("\n"));
    assert.equal(summary2.controlPlane.reachable, false);
    assert.match(summary2.controlPlane.error, /ECONNREFUSED/);
  });
});

// ── lifecycle-hook gate (Codex ≥0.148; plan 004 §4) ───────
// Stdout discipline is contract-critical: on success the hook prints NOTHING
// to stdout (plain text would be injected into the model context); the only
// stdout the gate may produce is the explicit block decision.

describe("neuron-codex hook subcommand (lifecycle-hook gate)", () => {
  function env(overrides = {}) {
    return makeEnv({ NEURON_STATE_DIR: stateDir, ...overrides });
  }
  const stdin = (payload) => async () => JSON.stringify(payload);
  const payload = (model) => ({
    session_id: "s1",
    turn_id: "t1",
    cwd: "C:\\work",
    model,
    permission_mode: "default",
    prompt: "ping"
  });

  it("gates a managed healthy prompt: reservation secured, EMPTY stdout, exit 0", async () => {
    const calls = installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("healthy") }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "", "success must print nothing to stdout");
    assert.equal(calls.createBodies.length, 0);
    // The lease was written by the reused ensure path.
    const entries = await readdir(stateDir);
    assert.equal(entries.filter((n) => n.endsWith(".json")).length, 0);
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /gate: target healthy with no reservation — pass/);
  });

  it("blocks a managed stopped prompt: explicit block JSON on stdout, exit 0", async () => {
    installFetch([
      { path: "/api/status", body: makeStatus({ observed: "stopped" }) },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("warming") }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 0, "an explicit block is exit 0 with a decision payload");
    const decision = JSON.parse(out.join("\n"));
    assert.equal(decision.decision, "block");
    assert.match(
      decision.reason,
      /^NeurOn: .*timed out after 200ms waiting for NeurOn reservation r1 to become healthy \(g6\.xlarge\.qwen-9b:warming\)/
    );
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /gate: blocking the turn/);
  });

  it("passes through an unmanaged model: no reservation, EMPTY stdout", async () => {
    const calls = installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload("some/other-model"))
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    assert.equal(calls.createBodies.length, 0);
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /not_managed/);
  });

  it("falls back to the config model when payload.model is missing", async () => {
    const status = makeStatus({ activeReservation: makeReservation("r-adopt") });
    const calls = installFetch([
      { path: "/api/status", body: status },
      { path: "/api/models", body: { models: status.models } },
      { path: "/api/reservations/r-adopt/status", body: { reservationId: "r-adopt", targets: [{ id: TARGET, observed: "healthy" }] } }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin({ ...payload(ROUTE), model: undefined })
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    // The config model is ROUTE → resolved to TARGET → adopted r-adopt.
    assert.ok(calls.requests.includes("/api/reservations/r-adopt/status"));
    assert.equal(calls.createBodies.length, 0);
  });

  it("fails open when the control plane is unreachable: EMPTY stdout, exit 0", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { io, out, err } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    // Diagnostics go to the hook log, not to stdout.
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /control plane unreachable .* pass \(fail-open\)/);
  });

  it("PostToolUse: marks activity and extends when the policy floor is due", async () => {
    const nowMs = Date.now();
    await writeLeaseAtomic(stateDir, {
      reservationId: "r-act",
      targetId: TARGET,
      model: ROUTE,
      expiresAt: new Date(nowMs + 6 * 60000).toISOString(),
      lifetimeMs: 6 * 60000,
      pid: 1234,
      createdAt: new Date(nowMs - 4 * 60000).toISOString(),
      lastExtendAt: new Date(nowMs - 4 * 60000).toISOString()
    });
    // floor = max(6min/2, 30s) = 3min; last extend 4min ago → due.
    const calls = installFetch([
      { path: "/api/reservations/r-act/extend", method: "POST", body: makeReservation("r-act", 480000) }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "PostToolUse"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin({ ...payload(ROUTE), tool_name: "shell" })
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "", "PostToolUse must never print to stdout");
    assert.deepEqual(calls.extendBodies, [{ durationMinutes: 2, fromNow: false }]);
    const lease = JSON.parse(await readFile(join(stateDir, "r-act.json"), "utf8"));
    assert.ok(lease.lastActivityAt, "activity is stamped on the lease");
    assert.match(lease.lastExtendAt, /^\d{4}-/);
    assert.ok(Date.parse(lease.expiresAt) > nowMs + 6 * 60000, "expiry advanced additively");
  });

  it("PostToolUse: not due → activity mark only, no extend, no fetch", async () => {
    const nowMs = Date.now();
    await writeLeaseAtomic(stateDir, {
      reservationId: "r-fresh",
      targetId: TARGET,
      model: ROUTE,
      expiresAt: new Date(nowMs + 10 * 60000).toISOString(),
      lifetimeMs: 10 * 60000,
      pid: 1234,
      createdAt: new Date(nowMs).toISOString(),
      lastExtendAt: new Date(nowMs).toISOString()
    });
    installFetch([]); // any fetch would throw
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "PostToolUse"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin({ ...payload(ROUTE), tool_name: "shell" })
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    const lease = JSON.parse(await readFile(join(stateDir, "r-fresh.json"), "utf8"));
    assert.ok(lease.lastActivityAt, "activity still stamped");
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /extend not due/);
  });

  it("PostToolUse with no active lease: no-op, exit 0", async () => {
    installFetch([]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "PostToolUse"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin({ ...payload(ROUTE), tool_name: "shell" })
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
  });

  it("SessionStart is a no-op unless NEURON_CODEX_PREWARM is set", async () => {
    installFetch([]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "SessionStart"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    const log = await readFile(join(stateDir, "hook.log"), "utf8");
    assert.match(log, /reservations start only on UserPromptSubmit/);
  });

  it("SessionStart remains a no-op even when prewarm is requested", async () => {
    const calls = installFetch([
      { path: "/api/status", body: makeStatus() },
      { path: "/api/models", body: { models: makeStatus().models } },
      { path: "/api/reservations", method: "POST", body: makeReservation() },
      { path: "/api/reservations/r1/status", body: makeReservationStatus("healthy") }
    ]);
    const { io, out } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "SessionStart"] },
      env: env({ NEURON_CODEX_PREWARM: "1" }),
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 0);
    assert.equal(out.join("\n").trim(), "");
    assert.equal(calls.createBodies.length, 0);
  });

  it("unexpected error → stderr + exit 1, EMPTY stdout (codex fails open)", async () => {
    installFetch([]);
    const { io, out, err } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "UserPromptSubmit"] },
      env: env({ NEURON_API_BASE_URL: "ftp://not-http" }), // loadConfig throws
      io,
      codexHome,
      stateDir,
      readStdin: stdin(payload(ROUTE))
    });
    assert.equal(code, 1);
    assert.equal(out.join("\n").trim(), "");
    assert.match(err.join("\n"), /hook UserPromptSubmit failed/);
  });

  it("rejects unknown hook events with usage, exit 1", async () => {
    const { io, err } = makeIo();
    const code = await cmdHook({
      args: { _: ["hook", "BogusEvent"] },
      env: env(),
      io,
      codexHome,
      stateDir,
      readStdin: async () => "{}"
    });
    assert.equal(code, 1);
    assert.match(err.join("\n"), /usage: neuron-codex hook/);
  });
});

// ── 0.151.0 trust-hash canonicalization ───────────────────

describe("neuron-codex hook trust hash (0.151.0 normalization)", () => {
  it("matches the golden vector for the installed UserPromptSubmit hook", () => {
    // The exact command sync installs on this machine, timeout 60 s:
    // canonical JSON = {"event_name":"user_prompt_submit","hooks":[{
    //   "async":false,"command":"node C:\\Users\\atran\\.codex\\neuron\\
    //   neuron-codex.js hook UserPromptSubmit","timeout":60,"type":"command"}]}
    // (sorted keys, compact; absent options omitted, never null)
    assert.equal(
      hookTrustHash({
        eventName: "user_prompt_submit",
        command: "node C:\\Users\\atran\\.codex\\neuron\\neuron-codex.js hook UserPromptSubmit",
        timeoutSec: 60
      }),
      "sha256:323ab45fdc891a5e1b206d9553455e0809415b0ae38be3e8f464bbb7d381a8fd"
    );
  });

  it("emits a different hash when any normalized field changes", () => {
    const base = {
      eventName: "post_tool_use",
      command: "node C:\\Users\\atran\\.codex\\neuron\\neuron-codex.js hook PostToolUse",
      timeoutSec: 10
    };
    assert.equal(
      hookTrustHash(base),
      "sha256:460d2591e3858a133e98d6b6e2ce1d316151a87d2ccfeae5e88b92d8d5c4ff1a"
    );
    assert.notEqual(hookTrustHash({ ...base, timeoutSec: 11 }), hookTrustHash(base));
    assert.notEqual(hookTrustHash({ ...base, command: base.command + " " }), hookTrustHash(base));
    assert.notEqual(hookTrustHash({ ...base, eventName: "pre_tool_use" }), hookTrustHash(base));
    assert.notEqual(hookTrustHash({ ...base, statusMessage: "working" }), hookTrustHash(base));
  });

  it("omits additionalContextLimit 2500 (the 0.151.0 default) from the identity", () => {
    const base = { eventName: "post_tool_use", command: "c", timeoutSec: 10 };
    assert.equal(
      hookTrustHash({ ...base, additionalContextLimit: 2500 }),
      hookTrustHash(base),
      "limit == DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT must be filtered out"
    );
    assert.notEqual(hookTrustHash({ ...base, additionalContextLimit: 5000 }), hookTrustHash(base));
  });

  it("canonicalJsonString sorts keys recursively (serde_json canonical_json parity)", () => {
    assert.equal(
      canonicalJsonString({ b: 1, a: { d: 1, c: [3, { z: 1, y: 2 }] } }),
      '{"a":{"c":[3,{"y":2,"z":1}],"d":1},"b":1}'
    );
    assert.equal(canonicalJsonString([2, 1]), "[2,1]", "array order is preserved");
  });

  it("caps the hook wait at min(env, 290) s with the 40 s core default (300 s hook timeout)", () => {
    assert.equal(HOOK_WAIT_CAP_S, 290);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "999" }), 290);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "600" }), 290);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "300" }), 290);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "3" }), 3);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "0.2" }), 0.2);
    assert.equal(hookWaitSeconds({}), 40);
    assert.equal(hookWaitSeconds({ NEURON_WAIT_TIMEOUT_SECONDS: "bad" }), 40);
  });
});

// ── toml-escape (TOML basic-string escaping for the config splice) ─────────

describe("neuron-codex toml-escape (TOML basic-string escaping)", () => {
  // Minimal TOML basic-string unescaper — exactly the inverse rules of
  // tomlEscape. If the escaped form ever contains a bare escape sequence
  // like `\n` that was not meant to be one, this throws or produces an LF.
  function tomlBasicUnescape(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== "\\") {
        out += s[i];
        continue;
      }
      const n = s[++i];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === '"') out += '"';
      else if (n === "\\") out += "\\";
      else throw new Error("unexpected escape sequence \\" + n);
    }
    return out;
  }

  it("doubles every backslash in the real Windows install path (full value, one pass)", () => {
    const p = ["C:", "Users", "atran", ".codex", "neuron", "neuron-codex.js"].join("\\");
    const e = tomlEscape(p);
    assert.equal(e, p.split("\\").join("\\\\"), "every separator is doubled");
    // the tail must be a DOUBLED separator + filename — never a bare `\n`
    // sequence that TOML would parse as a newline escape
    assert.ok(e.endsWith("\\\\neuron-codex.js"), `tail was: ${e.slice(-30)}`);
    assert.equal(tomlBasicUnescape(e), p, "round-trips with no embedded newline");
  });

  it("regression: dir-then-append mangles the path; one-pass escape of the full path does not", () => {
    const dir = ["C:", "Users", "atran", ".codex", "neuron"].join("\\");
    const p = dir + "\\neuron-codex.js";
    // the historical bug: escape only the directory, append the raw filename —
    // the lone backslash before `n` becomes a TOML newline escape
    const buggyParsed = tomlBasicUnescape(tomlEscape(dir) + "\\neuron-codex.js");
    assert.ok(buggyParsed.includes("\n"), "buggy form parses with an embedded LF");
    assert.ok(buggyParsed.endsWith("euron-codex.js"), "the filename loses its leading n");
    assert.notEqual(buggyParsed, p);
    // the fix: escape the FULL path in one pass
    const fixed = tomlEscape(p);
    assert.equal(tomlBasicUnescape(fixed), p, "no embedded newline, exact round-trip");
  });

  it("handles quotes, tabs, newlines, and control characters (full basic-string coverage)", () => {
    assert.equal(tomlEscape('C:\\a"b\\c'), 'C:\\\\a\\"b\\\\c');
    assert.equal(tomlEscape("tab\there"), "tab\\there");
    assert.equal(tomlEscape("lf\nline"), "lf\\nline");
    assert.equal(tomlEscape("ctl\x01"), "ctl\\u0001");
    assert.equal(tomlBasicUnescape(tomlEscape('weird "na\\me"\t')), 'weird "na\\me"\t');
    assert.equal(tomlEscape("plain/path"), "plain/path", "POSIX paths pass through untouched");
  });
});

// ── MCP stdio server (neuron_extend) ──────────────────────

describe("neuron-codex mcp subcommand (JSON-RPC over stdio)", () => {
  it("answers initialize / tools/list, ignores notifications, and rejects unknown methods", () => {
    const ctx = { setup: async () => { throw new Error("setup must not run for these"); } };

    const init = handleMcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex", version: "0.151.0" } }
      }),
      ctx
    );
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2025-06-18", "echo the client's protocol version");
    assert.deepEqual(init.result.capabilities, { tools: {} });

    const list = handleMcpMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', ctx);
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, "neuron_extend");
    assert.deepEqual(list.result.tools[0].inputSchema.required, ["minutes"]);

    assert.equal(handleMcpMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}', ctx), null);
    assert.equal(handleMcpMessage("not json at all", ctx), null);

    const bogus = handleMcpMessage('{"jsonrpc":"2.0","id":3,"method":"bogus/method"}', ctx);
    assert.equal(bogus.error.code, -32601);
  });

  it("neuron_extend: extends the latest active lease, validates minutes, and reports errors as tool results", async () => {
    const nowMs = Date.now();
    await writeLeaseAtomic(stateDir, {
      reservationId: "r1",
      targetId: TARGET,
      model: ROUTE,
      expiresAt: new Date(nowMs + 120000).toISOString(),
      lifetimeMs: 120000,
      pid: null,
      createdAt: new Date(nowMs).toISOString(),
      lastExtendAt: new Date(nowMs).toISOString()
    });
    const extendsCalls = [];
    const ctx = {
      setup: async () => ({
        client: {
          extendReservation: async (id, minutes, opts) => {
            extendsCalls.push({ id, minutes, opts });
            return { reservationId: id, expiresAt: new Date(nowMs + 420000).toISOString() };
          }
        },
        dir: stateDir
      })
    };
    const call = async (id, params) =>
      handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }), ctx);

    const ok = await call(10, { name: "neuron_extend", arguments: { minutes: 5 } });
    assert.equal(ok.result.isError, false);
    assert.match(ok.result.content[0].text, /^NeurOn: reservation r1 extended to \d{1,2}:\d{2}:\d{2} (AM|PM) \(\+5 min\)$/);
    assert.deepEqual(extendsCalls, [{ id: "r1", minutes: 5, opts: { fromNow: false } }]);

    const tooBig = await call(11, { name: "neuron_extend", arguments: { minutes: 721 } });
    assert.equal(tooBig.result.isError, true);
    assert.match(tooBig.result.content[0].text, /minutes must be an integer 1-720 \(got 721\)/);

    const fractional = await call(12, { name: "neuron_extend", arguments: { minutes: 2.5 } });
    assert.equal(fractional.result.isError, true);
    assert.match(fractional.result.content[0].text, /minutes must be an integer 1-720/);

    const unknownTool = await call(13, { name: "nope", arguments: {} });
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /unknown tool "nope"/);

    assert.deepEqual(extendsCalls, [{ id: "r1", minutes: 5, opts: { fromNow: false } }], "rejected calls never touch the API");

    const emptyDir = await mkdtemp(join(tmpdir(), "neuron-codex-empty-"));
    const emptyCtx = { setup: async () => ({ client: {}, dir: emptyDir }) };
    const none = await handleMcpMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "neuron_extend", arguments: { minutes: 5 } } }),
      emptyCtx
    );
    assert.equal(none.result.isError, true);
    assert.match(none.result.content[0].text, /no active lease found/);
    await rm(emptyDir, { recursive: true, force: true });
  });
});

// ── pure resolution helpers ───────────────────────────────

describe("neuron-codex pure resolution helpers", () => {
  const config = loadCodexConfig(makeEnv());
  const status = makeStatus();

  it("resolveModelStatus keeps the dedicated-target preference of the route prefix", () => {
    const r = resolveModelStatus(status, ROUTE, config, "litellm");
    assert.deepEqual({ managed: r.managed, targetId: r.targetId }, { managed: true, targetId: TARGET });
    assert.deepEqual(r.match.targetIds, [TARGET]);
  });

  it("findActiveReservationForTarget ignores other targets and inactive reservations", () => {
    const withRes = makeStatus({
      activeReservation: { ...makeReservation("r1"), status: "active", targets: [{ id: TARGET, observed: "healthy" }] }
    });
    assert.equal(findActiveReservationForTarget(withRes, TARGET).reservationId, "r1");
    assert.equal(findActiveReservationForTarget(withRes, "other"), null);
    const inactive = makeStatus({
      activeReservation: { ...makeReservation("r1"), status: "ended", targets: [{ id: TARGET, observed: "healthy" }] }
    });
    assert.equal(findActiveReservationForTarget(inactive, TARGET), null);
  });
});
