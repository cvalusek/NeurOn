import type { ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, CapacityTarget, Reservation } from "../domain/types.js";

const DEFAULT_TRAFFIC_KEEPALIVE_MINUTES = 2;

export class TrafficKeepaliveService {
  constructor(
    private readonly repository: ReservationRepository,
    private readonly statuses: TargetStatusRepository
  ) {}

  async recordTraffic(target: CapacityTarget, modelIds: string[], seenAt = new Date(), checkedAt = new Date(), user?: AuthenticatedUser): Promise<boolean> {
    const status = this.statuses.get(target.id);
    if (status?.observed === "failed") return false;

    const active = await this.repository.listActive(checkedAt);
    const realReservations = active.filter((reservation) => !reservation.synthetic && reservation.targetIds.includes(target.id));
    const userReservation = user ? latestMatchingReservation(realReservations, user.id, modelIds) : undefined;
    const existing = active.find((reservation) => reservation.synthetic && reservation.username === "traffic" && reservation.targetIds.includes(target.id));
    const keepaliveMinutes = keepaliveMinutesFor(userReservation ? [userReservation] : realReservations, existing?.keepaliveMinutes);
    const expiresAt = new Date(seenAt.getTime() + keepaliveMinutes * 60_000);
    if (expiresAt <= checkedAt) return false;

    const hasRealReservation = realReservations.length > 0;
    const alreadyHealthy = status?.observed === "healthy";
    if (!hasRealReservation && !alreadyHealthy) return false;

    if (user) {
      if (userReservation) {
        await this.repository.update(userReservation.id, {
          expiresAt: new Date(Math.max(userReservation.expiresAt.getTime(), expiresAt.getTime())),
          keepaliveMinutes,
          modelIds: Array.from(new Set([...userReservation.modelIds, ...modelIds]))
        });
      } else {
        await this.repository.create({
          userId: user.id,
          username: user.username,
          modelIds,
          targetIds: [target.id],
          targetSelections: [{ targetId: target.id, modelIds }],
          createdAt: seenAt,
          expiresAt,
          keepaliveMinutes,
          status: "active",
          synthetic: false
        });
      }
      return true;
    }

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

function latestMatchingReservation(reservations: Reservation[], userId: string, modelIds: string[]): Reservation | undefined {
  const modelSet = new Set(modelIds);
  const owned = reservations
    .filter((reservation) => reservation.userId === userId)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return owned.find((reservation) => modelSet.size === 0 || reservation.modelIds.length === 0 || reservation.modelIds.some((modelId) => modelSet.has(modelId))) ?? owned[0];
}

function keepaliveMinutesFor(realReservations: Array<{ keepaliveMinutes?: number }>, existingSyntheticKeepaliveMinutes: number | undefined): number {
  const configured = realReservations.map((reservation) => reservation.keepaliveMinutes).filter((value): value is number => Number.isFinite(value));
  if (configured.length > 0) return Math.max(...configured);
  return existingSyntheticKeepaliveMinutes ?? DEFAULT_TRAFFIC_KEEPALIVE_MINUTES;
}
