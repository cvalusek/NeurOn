import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { candidateModelIds, ensureReservation, isCompletionEvent, matchLiteLlmModel, refreshExistingReservation, resetNeurOnPluginState } from "../plugins/neuron.js";

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
});
