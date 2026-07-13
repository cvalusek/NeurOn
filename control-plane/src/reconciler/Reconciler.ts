import type { BackendConfigSync, CapacityProvider, ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget, DesiredState, RuntimeState, TargetStatus } from "../domain/types.js";
import type { HealthChecker } from "./HealthChecker.js";
import type { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import type { ModelWarmupService } from "../services/ModelWarmupService.js";
import type { TrafficPoller } from "../services/TrafficPoller.js";
import type { CostEstimationService } from "../services/CostEstimationService.js";
import type { TargetOperationCoordinator } from "../services/TargetOperationCoordinator.js";

export class Reconciler {
  private running?: Promise<void>;

  constructor(
    private readonly targets: CapacityTarget[],
    private readonly reservations: ReservationRepository,
    private readonly statuses: TargetStatusRepository,
    private readonly capacityProvider: CapacityProvider,
    private readonly backendConfigSync: BackendConfigSync,
    private readonly healthChecker?: HealthChecker,
    private readonly runtimeModelDiscovery?: RuntimeModelDiscovery,
    private readonly modelWarmup?: ModelWarmupService,
    private readonly trafficPoller?: TrafficPoller,
    private readonly costEstimation?: CostEstimationService,
    private readonly targetOperations?: TargetOperationCoordinator
  ) {}

  async reconcile(now = new Date()): Promise<void> {
    if (this.running) {
      await this.running;
      return;
    }
    const running = this.reconcilePass(now);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }

  private async reconcilePass(now: Date): Promise<void> {
    await this.reservations.expireReservations(now);
    let activeReservations = await this.reservations.listActive(now);

    for (const target of this.targets) {
      let desired: DesiredState = desiredStateFor(target.id, activeReservations, this.targetOperations);
      const previous = this.statuses.get(target.id);
      try {
        if (desired === "off" && previous?.desired === "on" && this.trafficPoller) {
          await this.trafficPoller.poll(now);
          activeReservations = await this.reservations.listActive(now);
          desired = desiredStateFor(target.id, activeReservations, this.targetOperations);
        }
        const transition = async () => {
          activeReservations = await this.reservations.listActive(now);
          desired = desiredStateFor(target.id, activeReservations, this.targetOperations);
          if (desired === "on") {
            await this.capacityProvider.ensureTargetOn(target);
          } else {
            await this.capacityProvider.ensureTargetOff(target);
          }
        };
        if (this.targetOperations) {
          await this.targetOperations.withLifecycleTransition(target.id, transition);
        } else {
          await transition();
        }

        const targetReservations = activeReservations.filter((reservation) => reservation.targetIds.includes(target.id));
        await this.costEstimation?.reconcileTargetActivation(
          target,
          targetReservations,
          targetReservations.length > 0 ? "on" : "off",
          now
        );
        const providerStatus = await this.capacityProvider.getTargetStatus(target);
        let observed = desired === "off" && providerStatus.observed === "healthy" ? "stopping" : providerStatus.observed;
        let message = providerStatus.message;
        if (desired === "on" && providerStatus.observed === "healthy" && this.healthChecker && target.healthUrl) {
          const health = await this.healthChecker.check(target);
          observed = health.ok ? "healthy" : "starting";
          message = health.message;
        }
        if (desired === "on" && observed === "healthy" && this.modelWarmup) {
          const modelIds = targetReservations.flatMap((reservation) => reservation.modelIds);
          try {
            await this.modelWarmup.warmupTargetModels(target, modelIds);
          } catch (error) {
            observed = "starting";
            message = error instanceof Error ? error.message : String(error);
          }
        }
        const next = targetStatus(target.id, desired, observed, message, now, previous);
        this.statuses.set(next);
        if (previous?.observed !== "healthy" && next.observed === "healthy") {
          await this.backendConfigSync.syncTargetHealthy(target);
        }
        if (next.observed === "healthy" && !this.targetOperations?.isDiscoveryActive(target.id)) {
          await this.runtimeModelDiscovery?.refreshTarget(target).catch(() => undefined);
        }
        if (next.observed === "failed") {
          await this.failActiveReservationsForTarget(target.id, next.message, now);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statuses.set(targetStatus(target.id, desired, "failed", message, now, previous));
        await this.failActiveReservationsForTarget(target.id, message, now);
      }
    }
  }

  start(intervalSeconds: number): NodeJS.Timeout {
    void this.reconcile();
    return setInterval(() => void this.reconcile(), intervalSeconds * 1000);
  }

  async reconcileTarget(targetId: string): Promise<void> {
    if (!this.targets.some((target) => target.id === targetId)) throw new Error("Target not found");
    const current = this.running;
    if (current) await current;
    await this.reconcile();
    const status = this.statuses.get(targetId);
    if (status?.observed === "failed") throw new Error(status.message);
  }

  async hasDemand(targetId: string, now = new Date()): Promise<boolean> {
    return (await this.reservations.listActive(now)).some((reservation) => reservation.targetIds.includes(targetId));
  }

  private async failActiveReservationsForTarget(targetId: string, message: string, now: Date): Promise<void> {
    const active = await this.reservations.listActive(now);
    await Promise.all(
      active
        .filter((reservation) => reservation.targetIds.includes(targetId))
        .map((reservation) =>
          this.reservations.update(reservation.id, {
            status: "failed",
            endedAt: now,
            failureMessage: message
          })
        )
    );
  }
}

function desiredStateFor(
  targetId: string,
  activeReservations: Awaited<ReturnType<ReservationRepository["listActive"]>>,
  targetOperations?: TargetOperationCoordinator
): DesiredState {
  if (targetOperations?.hasDesiredOnDemand(targetId)) return "on";
  return activeReservations.some((reservation) => reservation.targetIds.includes(targetId)) ? "on" : "off";
}

function targetStatus(
  targetId: string,
  desired: "on" | "off",
  observed: RuntimeState,
  message: string,
  now: Date,
  previous?: TargetStatus
): TargetStatus {
  const startupDurationsSeconds = [...(previous?.startupDurationsSeconds ?? [])];
  let startingStartedAt = previous?.startingStartedAt;
  if (desired === "on" && observed === "starting" && !startingStartedAt) {
    startingStartedAt = now;
  }
  if (observed === "healthy" && previous?.observed !== "healthy" && startingStartedAt) {
    startupDurationsSeconds.push(Math.max(1, Math.round((now.getTime() - startingStartedAt.getTime()) / 1000)));
    startingStartedAt = undefined;
  }
  if (desired === "off" || observed === "stopped" || observed === "failed") {
    startingStartedAt = undefined;
  }
  return {
    targetId,
    desired,
    observed,
    message,
    lastCheckedAt: now,
    lastHealthyAt: observed === "healthy" ? now : previous?.lastHealthyAt,
    startingStartedAt,
    startupDurationsSeconds: startupDurationsSeconds.slice(-20),
    startupEstimate: startupEstimate(startupDurationsSeconds)
  };
}

function startupEstimate(samples: number[]): TargetStatus["startupEstimate"] {
  if (samples.length === 0) return undefined;
  const minSeconds = Math.min(...samples);
  const maxSeconds = Math.max(...samples);
  const avgSeconds = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  return { minSeconds, maxSeconds, avgSeconds, sampleCount: samples.length };
}
