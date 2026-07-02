import type { CapacityProvider, TargetActivationRepository } from "../domain/interfaces.js";
import type { CapacityTarget, Reservation, TargetActivation, TargetCostEstimateConfig } from "../domain/types.js";

export interface ReservationCostEstimate {
  estimatedCostUsd: number;
  projectedRemainingCostUsd?: number;
  projectedTotalCostUsd?: number;
  estimatedHourlyCostUsd?: number;
  currency: "USD";
}

export interface StartReservationCostEstimate extends ReservationCostEstimate {
  hourlyUsd: number;
  estimatedMinutes: number;
}

export interface TargetCostEstimateProvider {
  getTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined>;
}

export class CostEstimationService {
  constructor(
    private readonly targetActivations: TargetActivationRepository,
    private readonly costProvider?: CapacityProvider | TargetCostEstimateProvider
  ) {}

  async reconcileTargetActivation(target: CapacityTarget, activeReservations: Reservation[], desired: "on" | "off", now: Date): Promise<void> {
    const openActivation = await this.targetActivations.getOpenActivationForTarget(target.id);
    if (desired === "off") {
      if (openActivation) {
        await this.targetActivations.closeReservationsForActivation(openActivation.id, now);
        await this.targetActivations.updateActivation(openActivation.id, {
          status: "closed",
          endedAt: now,
          lastCostedAt: now
        });
      }
      return;
    }

    const activation = openActivation ?? await this.createActivation(target, now);
    const reservationIds = activeReservations.map((reservation) => reservation.id);
    await this.allocateElapsedCost(activation, reservationIds, now);
    await this.targetActivations.closeInactiveReservations(activation.id, reservationIds, now);
  }

  async estimateForReservation(reservation: Reservation | string, targets: CapacityTarget[] = [], now = new Date()): Promise<ReservationCostEstimate | undefined> {
    const reservationId = typeof reservation === "string" ? reservation : reservation.id;
    const links = await this.targetActivations.listReservationAllocations(reservationId);
    const estimatedCostUsd = roundUsd(links.reduce((sum, link) => sum + link.estimatedCostUsd, 0));
    const projection = typeof reservation === "string" ? undefined : await this.projectReservationCost(reservation, targets, now);
    if (estimatedCostUsd <= 0 && !projection) return undefined;
    return {
      estimatedCostUsd,
      ...projection,
      currency: "USD"
    };
  }

  async estimateForTargetWindow(target: CapacityTarget, durationMinutes: number, keepaliveMinutes: number): Promise<StartReservationCostEstimate | undefined> {
    const costEstimate = await this.resolveTargetCostEstimate(target);
    if (costEstimate?.hourlyUsd === undefined) return undefined;
    const estimatedMinutes = Math.max(0, durationMinutes) + Math.max(0, keepaliveMinutes);
    return {
      estimatedCostUsd: roundUsd(costEstimate.hourlyUsd * estimatedMinutes / 60),
      hourlyUsd: costEstimate.hourlyUsd,
      estimatedMinutes,
      currency: "USD"
    };
  }

  private async createActivation(target: CapacityTarget, now: Date): Promise<TargetActivation> {
    const costEstimate = await this.resolveTargetCostEstimate(target);
    return this.targetActivations.createActivation({
      targetId: target.id,
      startedAt: now,
      status: "open",
      estimatedHourlyCostUsd: costEstimate?.hourlyUsd,
      estimatedCostUsd: 0,
      lastCostedAt: now
    });
  }

  async resolveTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined> {
    if (target.costEstimate?.hourlyUsd !== undefined) return target.costEstimate;
    try {
      return await this.costProvider?.getTargetCostEstimate?.(target);
    } catch {
      return undefined;
    }
  }

  private async allocateElapsedCost(activation: TargetActivation, reservationIds: string[], now: Date): Promise<void> {
    const elapsedMs = Math.max(0, now.getTime() - activation.lastCostedAt.getTime());
    if (elapsedMs === 0) return;

    const hourlyUsd = activation.estimatedHourlyCostUsd ?? 0;
    const deltaCost = hourlyUsd * elapsedMs / 3_600_000;
    if (reservationIds.length > 0 && deltaCost > 0) {
      const perReservation = deltaCost / reservationIds.length;
      await Promise.all(
        reservationIds.map((reservationId) =>
          this.targetActivations.addReservationCost({
            targetActivationId: activation.id,
            reservationId,
            at: activation.lastCostedAt,
            estimatedCostUsd: perReservation
          })
        )
      );
    }

    await this.targetActivations.updateActivation(activation.id, {
      estimatedCostUsd: roundUsd(activation.estimatedCostUsd + deltaCost),
      lastCostedAt: now
    });
  }

  private async projectReservationCost(reservation: Reservation, targets: CapacityTarget[], now: Date): Promise<Omit<ReservationCostEstimate, "estimatedCostUsd" | "currency"> | undefined> {
    if (reservation.status !== "active") return undefined;
    const hourlyCosts = await Promise.all(
      targets.map(async (target) => (await this.resolveTargetCostEstimate(target))?.hourlyUsd ?? 0)
    );
    const estimatedHourlyCostUsd = roundUsd(hourlyCosts.reduce((sum, hourlyCost) => sum + hourlyCost, 0));
    if (estimatedHourlyCostUsd <= 0) return undefined;

    const keepaliveMs = (reservation.keepaliveMinutes ?? 0) * 60_000;
    const projectedEndMs = reservation.expiresAt.getTime() + keepaliveMs;
    const remainingMs = Math.max(0, projectedEndMs - now.getTime());
    const projectedRemainingCostUsd = roundUsd(estimatedHourlyCostUsd * remainingMs / 3_600_000);
    const allocated = roundUsd((await this.targetActivations.listReservationAllocations(reservation.id)).reduce((sum, link) => sum + link.estimatedCostUsd, 0));
    return {
      estimatedHourlyCostUsd,
      projectedRemainingCostUsd,
      projectedTotalCostUsd: roundUsd(allocated + projectedRemainingCostUsd)
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100_0000) / 100_0000;
}
