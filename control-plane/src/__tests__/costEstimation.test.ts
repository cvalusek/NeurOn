import { describe, expect, it } from "vitest";
import type { CapacityTarget, Reservation } from "../domain/types.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetActivationRepository } from "../repository/InMemoryTargetActivationRepository.js";
import { CostEstimationService } from "../services/CostEstimationService.js";

const target: CapacityTarget = {
  id: "target-1",
  displayName: "Target 1",
  provider: "docker",
  modelIds: ["model-1"],
  costEstimate: { hourlyUsd: 6 }
};

describe("traffic-tail cost attribution", () => {
  it("allocates overlapping demand only to real reservations", async () => {
    const harness = await createHarness();
    const first = await harness.createReservation("first");
    const second = await harness.createReservation("second");
    const traffic = await harness.createReservation("traffic", true);

    await harness.costs.reconcileTargetActivation(target, [first, second, traffic], "on", at(0));
    await harness.costs.reconcileTargetActivation(target, [first, second, traffic], "on", at(30));

    expect(await harness.costs.estimateForReservation(first.id)).toEqual({ estimatedCostUsd: 1.5, currency: "USD" });
    expect(await harness.costs.estimateForReservation(second.id)).toEqual({ estimatedCostUsd: 1.5, currency: "USD" });
    expect(await harness.costs.estimateForReservation(traffic.id)).toBeUndefined();
  });

  it("continues a traffic-only tail against the last real participants across a restart", async () => {
    const harness = await createHarness();
    const reservation = await harness.createReservation("first");
    const traffic = await harness.createReservation("traffic", true);

    await harness.costs.reconcileTargetActivation(target, [reservation], "on", at(0));
    await harness.costs.reconcileTargetActivation(target, [reservation], "on", at(30));
    const restartedCosts = new CostEstimationService(harness.activations, undefined, harness.reservations);
    await restartedCosts.reconcileTargetActivation(target, [traffic], "on", at(60));

    expect(await restartedCosts.estimateForReservation(reservation.id)).toEqual({ estimatedCostUsd: 6, currency: "USD" });
    expect(await restartedCosts.estimateForReservation(traffic.id)).toBeUndefined();
    expect((await harness.activations.listReservationAllocations(reservation.id))[0].endedAt).toBeUndefined();
  });

  it("moves attribution to new real demand and uses it for the following traffic tail", async () => {
    const harness = await createHarness();
    const first = await harness.createReservation("first");
    const second = await harness.createReservation("second");
    const traffic = await harness.createReservation("traffic", true);

    await harness.costs.reconcileTargetActivation(target, [first], "on", at(0));
    await harness.costs.reconcileTargetActivation(target, [first], "on", at(30));
    await harness.costs.reconcileTargetActivation(target, [traffic], "on", at(60));
    await harness.costs.reconcileTargetActivation(target, [second, traffic], "on", at(90));
    await harness.costs.reconcileTargetActivation(target, [traffic], "on", at(120));

    expect(await harness.costs.estimateForReservation(first.id)).toEqual({ estimatedCostUsd: 6, currency: "USD" });
    expect(await harness.costs.estimateForReservation(second.id)).toEqual({ estimatedCostUsd: 6, currency: "USD" });
    const firstLink = (await harness.activations.listReservationAllocations(first.id))[0];
    expect(firstLink.endedAt).toEqual(at(90));
    expect((await harness.activations.listReservationAllocations(second.id))[0].endedAt).toBeUndefined();
    expect(await harness.costs.estimateForReservation(traffic.id)).toBeUndefined();
  });

  it("leaves a synthetic-only activation cost unattributed", async () => {
    const harness = await createHarness();
    const traffic = await harness.createReservation("traffic", true);

    await harness.costs.reconcileTargetActivation(target, [traffic], "on", at(0));
    await harness.costs.reconcileTargetActivation(target, [traffic], "on", at(30));

    expect(await harness.costs.estimateForReservation(traffic.id)).toBeUndefined();
    expect(await harness.activations.listActivationReservations((await harness.activations.listActivationsForTarget(target.id))[0].id)).toEqual([]);
    expect(await harness.activations.listActivationsForTarget(target.id)).toMatchObject([{ estimatedCostUsd: 3 }]);
  });
});

async function createHarness() {
  const reservations = new InMemoryReservationRepository();
  const activations = new InMemoryTargetActivationRepository();
  return {
    reservations,
    activations,
    costs: new CostEstimationService(activations, undefined, reservations),
    createReservation: (username: string, synthetic = false): Promise<Reservation> => reservations.create({
      username,
      modelIds: ["model-1"],
      targetIds: [target.id],
      createdAt: at(0),
      expiresAt: at(180),
      status: "active",
      synthetic: synthetic || undefined
    })
  };
}

function at(minutes: number): Date {
  return new Date(Date.parse("2026-08-13T10:00:00.000Z") + minutes * 60_000);
}
