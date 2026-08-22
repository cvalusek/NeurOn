import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCapacityProvider } from "../capacity/FakeCapacityProvider.js";
import type { AuthenticatedUser, CapacityTarget } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { ShutdownCoordinator } from "../services/ShutdownCoordinator.js";
import { TargetOperationCoordinator } from "../services/TargetOperationCoordinator.js";
import { testUser } from "./testUsers.js";

const target: CapacityTarget = { id: "gpu", displayName: "GPU", provider: "fake", modelIds: ["m1"] };
const admin: AuthenticatedUser = testUser("admin", true);

afterEach(() => {
  vi.useRealTimers();
});

describe("shutdown coordinator", () => {
  it("rejects cancellation when no restart is scheduled", () => {
    const harness = createHarness();
    expect(() => harness.coordinator.cancel()).toThrow("No restart is scheduled");
  });

  it("drains active reservations and shuts down only after every target reports stopped", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const reservation = await harness.reservationService.createForUser(admin, { modelIds: ["m1"], durationMinutes: 30 });
    await harness.reconciler.reconcile();
    expect(harness.provider.desired.get(target.id)).toBe("on");

    harness.coordinator.scheduleWhenSafe(admin.username);
    await vi.advanceTimersByTimeAsync(20);
    expect((await harness.coordinator.status()).activeReservationCount).toBe(1);
    expect(harness.requestShutdown).not.toHaveBeenCalled();

    await harness.reservations.update(reservation.id, { status: "done", endedAt: new Date() });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.provider.desired.get(target.id)).toBe("off");
    expect(harness.requestShutdown).toHaveBeenCalledWith("safe-update-restart");
    expect((await harness.coordinator.status()).allTargetsStopped).toBe(true);
  });

  it("force-stops targets and fails active reservations before requesting shutdown", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const reservation = await harness.reservationService.createForUser(admin, { modelIds: ["m1"], durationMinutes: 30 });
    await harness.reconciler.reconcile();

    harness.coordinator.force(admin.username, true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await harness.reservations.get(reservation.id))?.status).toBe("failed");
    expect(harness.provider.desired.get(target.id)).toBe("off");
    expect(harness.requestShutdown).toHaveBeenCalledWith("admin-forced-restart-after-target-stop");
  });

  it("requires no target mutation when the admin accepts immediate-restart risk", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.reservationService.createForUser(admin, { modelIds: ["m1"], durationMinutes: 30 });
    await harness.reconciler.reconcile();

    harness.coordinator.force(admin.username, false);
    await vi.advanceTimersByTimeAsync(600);

    expect(harness.provider.desired.get(target.id)).toBe("on");
    expect(harness.requestShutdown).toHaveBeenCalledWith("admin-forced-restart-without-target-stop");
    expect((await harness.coordinator.status()).unmanagedCapacityRiskAccepted).toBe(true);
  });

  it("blocks new reservations and extensions while draining", async () => {
    const harness = createHarness();
    const reservation = await harness.reservationService.createForUser(admin, { modelIds: ["m1"], durationMinutes: 30 });
    harness.coordinator.scheduleWhenSafe(admin.username);

    await expect(harness.reservationService.createForUser(admin, { modelIds: ["m1"], durationMinutes: 30 })).rejects.toThrow("draining for restart");
    await expect(harness.reservationService.extend(reservation.id, admin, 5)).rejects.toThrow("draining for restart");
    harness.coordinator.stop();
  });
});

function createHarness() {
  const reservations = new InMemoryReservationRepository();
  const statuses = new InMemoryTargetStatusRepository();
  const provider = new FakeCapacityProvider();
  const targetOperations = new TargetOperationCoordinator();
  const reconciler = new Reconciler([target], reservations, statuses, provider, new NoopBackendConfigSync(), undefined, undefined, undefined, undefined, undefined, targetOperations);
  targetOperations.setDemandController({ hasDemand: (targetId) => reconciler.hasDemand(targetId), reconcileTarget: (targetId) => reconciler.reconcileTarget(targetId) });
  const shutdownControl: { current?: ShutdownCoordinator } = {};
  const reservationService = new ReservationService(
    reservations,
    new ModelCatalog([{ id: "m1", displayName: "M1", aliases: ["m1"], targetIds: [target.id] }], [target]),
    undefined,
    undefined,
    () => shutdownControl.current?.acceptingReservations() ?? true
  );
  const requestShutdown = vi.fn();
  const coordinator = new ShutdownCoordinator({
    reservations,
    targets: () => [target],
    statuses,
    capacityProvider: provider,
    reconciler,
    targetOperations,
    activeDemandMutations: () => reservationService.activeDemandMutationCount(),
    stopTrafficPolling: vi.fn(),
    resumeLifecycle: vi.fn(),
    requestShutdown,
    pollIntervalMs: 100
  });
  shutdownControl.current = coordinator;
  return { reservations, statuses, provider, targetOperations, reconciler, reservationService, coordinator, requestShutdown };
}
