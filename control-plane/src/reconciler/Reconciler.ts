import type { BackendConfigSync, CapacityProvider, ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget, DesiredState, RuntimeState, TargetStatus } from "../domain/types.js";
import type { HealthChecker } from "./HealthChecker.js";
import type { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import type { ModelWarmupService } from "../services/ModelWarmupService.js";
import type { TrafficPoller } from "../services/TrafficPoller.js";

export class Reconciler {
  private running = false;

  constructor(
    private readonly targets: CapacityTarget[],
    private readonly reservations: ReservationRepository,
    private readonly statuses: TargetStatusRepository,
    private readonly capacityProvider: CapacityProvider,
    private readonly backendConfigSync: BackendConfigSync,
    private readonly healthChecker?: HealthChecker,
    private readonly runtimeModelDiscovery?: RuntimeModelDiscovery,
    private readonly modelWarmup?: ModelWarmupService,
    private readonly trafficPoller?: TrafficPoller
  ) {}

  async reconcile(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reservations.expireReservations(now);
      let activeReservations = await this.reservations.listActive(now);
      const desiredOn = new Set(activeReservations.flatMap((reservation) => reservation.targetIds));

      for (const target of this.targets) {
        let desired: DesiredState = desiredOn.has(target.id) ? "on" : "off";
        const previous = this.statuses.get(target.id);
        try {
          if (desired === "off" && previous?.observed === "failed" && previous.message.startsWith("Runtime model discovery bootstrap failed")) {
            continue;
          }
          if (desired === "off" && previous?.desired === "on" && this.trafficPoller) {
            await this.trafficPoller.poll(now);
            const refreshedActive = await this.reservations.listActive(now);
            activeReservations = refreshedActive;
            if (refreshedActive.some((reservation) => reservation.targetIds.includes(target.id))) desired = "on";
          }
          if (desired === "on") {
            await this.capacityProvider.ensureTargetOn(target);
          } else {
            await this.capacityProvider.ensureTargetOff(target);
          }
          const providerStatus = await this.capacityProvider.getTargetStatus(target);
          let observed = desired === "off" && providerStatus.observed === "healthy" ? "stopping" : providerStatus.observed;
          let message = providerStatus.message;
          if (desired === "on" && providerStatus.observed === "healthy" && this.healthChecker && target.healthCheckUrl) {
            const health = await this.healthChecker.check(target);
            observed = health.ok ? "healthy" : "provisioning";
            message = health.message;
          }
          if (desired === "on" && observed === "healthy" && this.modelWarmup) {
            const modelIds = activeReservations
              .filter((reservation) => reservation.targetIds.includes(target.id))
              .flatMap((reservation) => reservation.modelIds);
            try {
              await this.modelWarmup.warmupTargetModels(target, modelIds);
            } catch (error) {
              observed = "provisioning";
              message = error instanceof Error ? error.message : String(error);
            }
          }
          const next = targetStatus(target.id, desired, observed, message, now, previous);
          this.statuses.set(next);
          if (previous?.observed !== "healthy" && next.observed === "healthy") {
            await this.backendConfigSync.syncTargetHealthy(target);
          }
          if (next.observed === "healthy") {
            await this.runtimeModelDiscovery?.refreshTarget(target).catch(() => undefined);
          }
          if (next.observed === "failed") {
            await this.failActiveReservationsForTarget(target.id, next.message);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.statuses.set(targetStatus(target.id, desired, "failed", message, now, previous));
          await this.failActiveReservationsForTarget(target.id, message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(intervalSeconds: number): NodeJS.Timeout {
    void this.reconcile();
    return setInterval(() => void this.reconcile(), intervalSeconds * 1000);
  }

  async reconcileTarget(targetId: string): Promise<void> {
    await this.reconcile();
    if (!this.targets.some((target) => target.id === targetId)) throw new Error("Target not found");
  }

  private async failActiveReservationsForTarget(targetId: string, message: string): Promise<void> {
    const active = await this.reservations.listActive(new Date());
    await Promise.all(
      active
        .filter((reservation) => reservation.targetIds.includes(targetId))
        .map((reservation) =>
          this.reservations.update(reservation.id, {
            status: "failed",
            endedAt: new Date(),
            failureMessage: message
          })
        )
    );
  }
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
  let provisioningStartedAt = previous?.provisioningStartedAt;
  if (desired === "on" && observed === "provisioning" && !provisioningStartedAt) {
    provisioningStartedAt = now;
  }
  if (observed === "healthy" && previous?.observed !== "healthy" && provisioningStartedAt) {
    startupDurationsSeconds.push(Math.max(1, Math.round((now.getTime() - provisioningStartedAt.getTime()) / 1000)));
    provisioningStartedAt = undefined;
  }
  if (desired === "off" || observed === "stopped" || observed === "failed") {
    provisioningStartedAt = undefined;
  }
  return {
    targetId,
    desired,
    observed,
    message,
    lastCheckedAt: now,
    lastHealthyAt: observed === "healthy" ? now : previous?.lastHealthyAt,
    provisioningStartedAt,
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
