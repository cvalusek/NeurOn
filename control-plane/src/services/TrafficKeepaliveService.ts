import type { ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";

const DEFAULT_TRAFFIC_KEEPALIVE_MINUTES = 2;

export class TrafficKeepaliveService {
  constructor(
    private readonly repository: ReservationRepository,
    private readonly statuses: TargetStatusRepository
  ) {}

  async recordTraffic(target: CapacityTarget, modelIds: string[], seenAt = new Date(), checkedAt = new Date()): Promise<boolean> {
    const status = this.statuses.get(target.id);
    if (status?.observed === "failed") return false;

    const active = await this.repository.listActive(checkedAt);
    const realReservations = active.filter((reservation) => !reservation.synthetic && reservation.targetIds.includes(target.id));
    const existing = active.find((reservation) => reservation.synthetic && reservation.username === "traffic" && reservation.targetIds.includes(target.id));
    const keepaliveMinutes = keepaliveMinutesFor(realReservations, existing?.keepaliveMinutes);
    const expiresAt = new Date(seenAt.getTime() + keepaliveMinutes * 60_000);
    if (expiresAt <= checkedAt) return false;

    const hasRealReservation = realReservations.length > 0;
    const alreadyHealthy = status?.observed === "healthy";
    if (!hasRealReservation && !alreadyHealthy) return false;

    if (existing) {
      await this.repository.update(existing.id, { expiresAt, keepaliveMinutes, modelIds: Array.from(new Set([...existing.modelIds, ...modelIds])) });
    } else {
      await this.repository.create({
        username: "traffic",
        modelIds,
        targetIds: [target.id],
        createdAt: seenAt,
        expiresAt,
        keepaliveMinutes,
        status: "active",
        synthetic: true
      });
    }
    return true;
  }
}

function keepaliveMinutesFor(realReservations: Array<{ keepaliveMinutes?: number }>, existingSyntheticKeepaliveMinutes: number | undefined): number {
  const configured = realReservations.map((reservation) => reservation.keepaliveMinutes).filter((value): value is number => Number.isFinite(value));
  if (configured.length > 0) return Math.max(...configured);
  return existingSyntheticKeepaliveMinutes ?? DEFAULT_TRAFFIC_KEEPALIVE_MINUTES;
}
