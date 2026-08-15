import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  candidateModelIds,
  createNeurOnHooks,
  ensureReservation,
  isCompletionEvent,
  matchLiteLlmModel,
  matchesAllowedProvider,
  mergeClientModels,
  refreshExistingReservation,
  resetNeurOnPluginState
} from "../plugins/neuron.js";

const targets = [
  {
    id: "t1",
    modelIds: ["gemma-4-26b-a4b"],
    trafficModelPrefixes: ["prefer/"],
    litellmDisplayPrefix: "prefer/"
  }
];

const models = [
  {
    id: "gemma-4-26b-a4b",
    aliases: ["gemma-4"],
    backendModelIds: ["gemma-4-26b-a4b"],
    targetIds: ["t1"]
  }
];

describe("NeurOn OpenCode plugin", () => {
  it("maps a shared alias to the highest-priority target", () => {
    const match = matchLiteLlmModel(
      [
        { id: "fallback", modelIds: ["model-b"], aliasPriority: 20 },
        { id: "primary", modelIds: ["model-a"], aliasPriority: 10 }
      ],
      [
        { id: "model-a", aliases: ["coding"], targetIds: ["primary"] },
        { id: "model-b", aliases: ["coding"], targetIds: ["fallback"] }
      ],
      "coding"
    );
    assert.deepEqual(match, { modelIds: ["model-a"], targetIds: ["primary"] });
  });

  it("maps the default target-scoped alias without extra prefix configuration", () => {
    assert.deepEqual(
      matchLiteLlmModel(
        [{ id: "primary", modelIds: ["model-a"] }],
        [{ id: "model-a", aliases: ["coding"], targetIds: ["primary"] }],
        "primary/coding"
      ),
      { modelIds: ["model-a"], targetIds: ["primary"] }
    );
  });

  it("maps persisted per-target aliases from the NeurOn client catalog", () => {
    const merged = mergeClientModels(models, [{
      targetId: "t1",
      modelId: "gemma-4-26b-a4b",
      aliases: { global: ["coding"], scoped: ["t1/coding"] }
    }]);
    assert.deepEqual(matchLiteLlmModel(targets, merged, "coding"), {
      modelIds: ["gemma-4-26b-a4b"],
      targetIds: ["t1"]
    });
    assert.deepEqual(matchLiteLlmModel(targets, merged, "t1/coding"), {
      modelIds: ["gemma-4-26b-a4b"],
      targetIds: ["t1"]
    });
  });
  beforeEach(() => resetNeurOnPluginState());

  it("maps LiteLLM display-prefixed model names to NeurOn model reservations", () => {
    assert.deepEqual(matchLiteLlmModel(targets, models, "prefer/gemma-4"), {
      modelIds: ["gemma-4-26b-a4b"],
      targetIds: ["t1"]
    });
  });

  it("allows an intentionally empty display prefix when LiteLLM aliases names", () => {
    assert.deepEqual(candidateModelIds({ trafficModelPrefixes: ["prefer/"], litellmDisplayPrefix: "" }, "gemma-4"), ["gemma-4", "prefer/gemma-4"]);
    assert.deepEqual(matchLiteLlmModel([{ ...targets[0], litellmDisplayPrefix: "" }], models, "gemma-4"), {
      modelIds: ["gemma-4-26b-a4b"],
      targetIds: ["t1"]
    });
  });

  it("refreshes the same reservation from now on later chat messages", async () => {
    const creates = [];
    const refreshes = [];
    const client = {
      config: { durationMinutes: 2, keepaliveMinutes: 2, waitForHealthy: false },
      async getStatus() {
        return { capacityTargets: targets, models };
      },
      async createReservation(match) {
        creates.push(match);
        return { reservationId: "r1", expiresAt: new Date(Date.now() + 120000).toISOString(), targets: [] };
      },
      async refreshReservation(reservationId) {
        refreshes.push(reservationId);
        return { reservationId, expiresAt: new Date(Date.now() + 120000).toISOString(), targets: [] };
      },
      async warmupModel() {
        return undefined;
      }
    };

    const first = await ensureReservation(client, "prefer/gemma-4", 1000);
    const second = await ensureReservation(client, "prefer/gemma-4", 2000);

    assert.equal(first.reservationId, "r1");
    assert.equal(second.reservationId, "r1");
    assert.equal(creates.length, 1);
    assert.deepEqual(refreshes, ["r1"]);
  });

  it("uses the awaited chat.message hook to reserve and wait before returning", async () => {
    const calls = [];
    const client = {
      config: {
        durationMinutes: 2,
        keepaliveMinutes: 2,
        waitForHealthy: true,
        allowedProviders: ["litellm"]
      },
      async getStatus() {
        calls.push("status");
        return { capacityTargets: targets, models };
      },
      async createReservation() {
        calls.push("create");
        return { reservationId: "r1", targets: [{ id: "t1", observed: "provisioning" }] };
      },
      async waitForHealthy(reservationId) {
        calls.push(`wait:${reservationId}`);
        return { reservationId, targets: [{ id: "t1", observed: "healthy" }] };
      }
    };

    const hooks = createNeurOnHooks(client);
    await hooks["chat.message"]({
      sessionID: "s1",
      model: { providerID: "litellm", modelID: "prefer/gemma-4" }
    });

    assert.deepEqual(calls, ["status", "create", "wait:r1"]);
  });

  it("filters providers before making any NeurOn request", async () => {
    let statusCalls = 0;
    const hooks = createNeurOnHooks({
      config: { allowedProviders: ["litellm"] },
      async getStatus() {
        statusCalls += 1;
        return { capacityTargets: targets, models };
      }
    });

    await hooks["chat.message"]({
      sessionID: "s1",
      model: { providerID: "openai", modelID: "prefer/gemma-4" }
    });

    assert.equal(statusCalls, 0);
    assert.equal(matchesAllowedProvider("LiteLLM", "gemma-4", ["litellm"]), true);
    assert.equal(matchesAllowedProvider("openai", "gemma-4", ["litellm"]), false);
  });

  it("shares aliases for one model without treating another model on the target as ready", async () => {
    const targetWithTwoModels = [{
      ...targets[0],
      modelIds: ["gemma-4-26b-a4b", "qwen-3.6-27b"]
    }];
    const modelsWithTwoModels = [
      ...models,
      {
        id: "qwen-3.6-27b",
        aliases: ["qwen-3.6"],
        backendModelIds: [],
        targetIds: ["t1"]
      }
    ];
    const creates = [];
    const refreshes = [];
    const client = {
      config: { waitForHealthy: false },
      async getStatus() {
        return { capacityTargets: targetWithTwoModels, models: modelsWithTwoModels };
      },
      async createReservation(match) {
        creates.push(match.modelIds[0]);
        return { reservationId: `r${creates.length}`, targets: [] };
      },
      async refreshReservation(reservationId) {
        refreshes.push(reservationId);
        return { reservationId, targets: [] };
      }
    };

    await ensureReservation(client, "prefer/gemma-4");
    await ensureReservation(client, "gemma-4-26b-a4b");
    await ensureReservation(client, "prefer/qwen-3.6");

    assert.deepEqual(creates, ["gemma-4-26b-a4b", "qwen-3.6-27b"]);
    assert.deepEqual(refreshes, ["r1"]);
  });

  it("waits for health from the chat hook path", async () => {
    const waits = [];
    const client = {
      config: { durationMinutes: 2, keepaliveMinutes: 2, waitForHealthy: true },
      async getStatus() {
        return { capacityTargets: targets, models };
      },
      async createReservation() {
        return { reservationId: "r1", targets: [{ id: "t1", observed: "provisioning" }] };
      },
      async refreshReservation(reservationId) {
        return { reservationId, targets: [{ id: "t1", observed: "provisioning" }] };
      },
      async waitForHealthy(reservationId) {
        waits.push(reservationId);
        return { reservationId, targets: [{ id: "t1", observed: "healthy" }] };
      }
    };

    await ensureReservation(client, "prefer/gemma-4", 1000);
    await ensureReservation(client, "prefer/gemma-4", 2000);

    assert.deepEqual(waits, ["r1", "r1"]);
  });

  it("refreshes on completion without waiting for health", async () => {
    const waits = [];
    const refreshes = [];
    const client = {
      config: { durationMinutes: 2, keepaliveMinutes: 2, waitForHealthy: true },
      async getStatus() {
        return { capacityTargets: targets, models };
      },
      async createReservation() {
        return { reservationId: "r1", targets: [{ id: "t1", observed: "healthy" }] };
      },
      async refreshReservation(reservationId) {
        refreshes.push(reservationId);
        return { reservationId, targets: [{ id: "t1", observed: "provisioning" }] };
      },
      async waitForHealthy(reservationId) {
        waits.push(reservationId);
        return { reservationId, targets: [{ id: "t1", observed: "healthy" }] };
      }
    };

    await ensureReservation(client, "prefer/gemma-4", 1000);
    await refreshExistingReservation(client, "prefer/gemma-4");

    assert.deepEqual(refreshes, ["r1"]);
    assert.deepEqual(waits, ["r1"]);
  });

  it("recognizes completed OpenCode event shapes", () => {
    assert.equal(isCompletionEvent({ type: "message.completed" }), true);
    assert.equal(isCompletionEvent({ event: { type: "message.updated", properties: { status: "completed" } } }), true);
    assert.equal(isCompletionEvent({ event: { type: "message.updated", properties: { info: { time: { completed: 123 } } } } }), true);
    assert.equal(isCompletionEvent({ event: { type: "message.updated", properties: { status: "streaming" } } }), false);
  });

  it("refreshes once for OpenCode's completed-message and idle event pair", async () => {
    const refreshes = [];
    const client = {
      config: { waitForHealthy: false, allowedProviders: ["litellm"] },
      async getStatus() {
        return { capacityTargets: targets, models };
      },
      async createReservation() {
        return { reservationId: "r1", targets: [] };
      },
      async refreshReservation(reservationId) {
        refreshes.push(reservationId);
        return { reservationId, targets: [] };
      }
    };
    const hooks = createNeurOnHooks(client);
    await hooks["chat.message"]({
      sessionID: "s1",
      model: { providerID: "litellm", modelID: "prefer/gemma-4" }
    });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID: "s1",
            modelID: "prefer/gemma-4",
            providerID: "litellm",
            time: { completed: 123 }
          }
        }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } }
    });

    assert.deepEqual(refreshes, ["r1"]);
  });
});
