import type { ReservationRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, Reservation } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";

const MAX_DURATION_MINUTES = 12 * 60;
const DEFAULT_KEEPALIVE_MINUTES = 2;
const MAX_KEEPALIVE_MINUTES = 60;

export class ReservationService {
  constructor(
    private readonly repository: ReservationRepository,
    private readonly catalog: ModelCatalog
  ) {}

  async createForUser(user: AuthenticatedUser, input: { modelIds?: string[]; targetIds?: string[]; durationMinutes: number; keepaliveMinutes?: number }): Promise<Reservation> {
    this.validateInput(input);
    const requestedModelIds = unique(input.modelIds ?? []);
    const modelIds = requestedModelIds.length > 0 ? this.catalog.canonicalModelIds(requestedModelIds) : [];
    const requestedTargetIds = unique(input.targetIds ?? []);
    const now = new Date();
    const targetIds = this.targetIdsForRequest(modelIds, requestedTargetIds);
    return this.repository.create({
      username: user.username,
      apiKeyName: user.apiKeyName,
      modelIds,
      targetIds,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
      keepaliveMinutes: input.keepaliveMinutes ?? DEFAULT_KEEPALIVE_MINUTES,
      status: "active"
    });
  }

  async getOwned(id: string, user: AuthenticatedUser): Promise<Reservation> {
    const reservation = await this.repository.get(id);
    if (!reservation) throw new Error("Reservation not found");
    if (!user.isAdmin && reservation.username !== user.username) throw new Error("Reservation not found");
    return reservation;
  }

  async markDone(id: string, user: AuthenticatedUser): Promise<Reservation> {
    await this.getOwned(id, user);
    return this.repository.update(id, { status: "done", endedAt: new Date() });
  }

  async extend(id: string, user: AuthenticatedUser, durationMinutes: number, options: { fromNow?: boolean } = {}): Promise<Reservation> {
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
      throw new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`);
    }
    const reservation = await this.getOwned(id, user);
    if (reservation.status !== "active") throw new Error("Only active reservations can be extended");
    const baseTime = options.fromNow ? Date.now() : Math.max(Date.now(), reservation.expiresAt.getTime());
    return this.repository.update(id, {
      expiresAt: new Date(baseTime + durationMinutes * 60_000)
    });
  }

  private validateInput(input: { modelIds?: string[]; targetIds?: string[]; durationMinutes: number; keepaliveMinutes?: number }): void {
    const modelIds = unique(input.modelIds ?? []);
    if (modelIds.length > 0) {
      this.catalog.validateModelIds(modelIds);
    } else {
      this.catalog.validateTargetIds(unique(input.targetIds ?? []));
    }
    if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes > MAX_DURATION_MINUTES) {
      throw new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`);
    }
    if (input.keepaliveMinutes !== undefined && (!Number.isFinite(input.keepaliveMinutes) || input.keepaliveMinutes <= 0 || input.keepaliveMinutes > MAX_KEEPALIVE_MINUTES)) {
      throw new Error(`Keepalive must be between 1 and ${MAX_KEEPALIVE_MINUTES} minutes`);
    }
  }

  private targetIdsForRequest(modelIds: string[], requestedTargetIds: string[]): string[] {
    if (modelIds.length === 0) return this.catalog.validateTargetIds(requestedTargetIds);
    if (requestedTargetIds.length === 0) return this.catalog.targetsForModels(modelIds).map((target) => target.id);

    const targetIds = this.catalog.validateTargetIds(requestedTargetIds);
    for (const modelId of modelIds) {
      const model = this.catalog.getModel(modelId);
      if (!model) throw new Error(`Unknown model ID: ${modelId}`);
      if (!model.targetIds.some((targetId) => targetIds.includes(targetId))) {
        throw new Error(`Model ${modelId} is not available on target(s): ${targetIds.join(", ")}`);
      }
    }
    return targetIds;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
