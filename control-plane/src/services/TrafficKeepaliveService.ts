import type { ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";

const TRAFFIC_KEEPALIVE_MINUTES = 5;

export class TrafficKeepaliveService {
  constructor(
    private readonly repository: ReservationRepository,
    private readonly statuses: TargetStatusRepository
  ) {}

  async recordTraffic(target: CapacityTarget, modelIds: string[], seenAt = new Date(), checkedAt = new Date()): Promise<boolean> {
    const status = this.statuses.get(target.id);
    if (status?.observed === "failed") return false;

    const expiresAt = new Date(seenAt.getTime() + TRAFFIC_KEEPALIVE_MINUTES * 60_000);
    if (expiresAt <= checkedAt) return false;

    const active = await this.repository.listActive(checkedAt);
    const hasRealReservation = active.some((reservation) => !reservation.synthetic && reservation.targetIds.includes(target.id));
    const alreadyHealthy = status?.observed === "healthy";
    if (!hasRealReservation && !alreadyHealthy) return false;

    const existing = active.find((reservation) => reservation.synthetic && reservation.username === "traffic" && reservation.targetIds.includes(target.id));
    if (existing) {
      await this.repository.update(existing.id, { expiresAt, modelIds: Array.from(new Set([...existing.modelIds, ...modelIds])) });
    } else {
      await this.repository.create({
        username: "traffic",
        modelIds,
        targetIds: [target.id],
        createdAt: seenAt,
        expiresAt,
        status: "active",
        synthetic: true
      });
    }
    return true;
  }
}
