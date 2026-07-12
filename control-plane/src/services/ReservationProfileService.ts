import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ReservationProfile, ReservationProfileSelection } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";

const MAX_DURATION_MINUTES = 12 * 60;
const MAX_KEEPALIVE_MINUTES = 60;

export class ReservationProfileService {
  constructor(
    private readonly repository: ReservationProfileRepository,
    private readonly catalog: ModelCatalog
  ) {}

  async createForUser(user: AuthenticatedUser, input: ReservationProfileInput): Promise<ReservationProfile> {
    const selections = this.validateSelections(input.selections);
    validateDefaults(input);
    return this.repository.create({
      username: user.username,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      selections,
      defaultDurationMinutes: input.defaultDurationMinutes,
      defaultKeepaliveMinutes: input.defaultKeepaliveMinutes
    });
  }

  async listForUser(user: AuthenticatedUser): Promise<ReservationProfile[]> {
    return this.repository.listForUser(user.username);
  }

  async getOwned(id: string, user: AuthenticatedUser): Promise<ReservationProfile> {
    const profile = await this.repository.get(id);
    if (!profile || profile.username !== user.username) throw new Error("Reservation profile not found");
    return profile;
  }

  async deleteForUser(id: string, user: AuthenticatedUser): Promise<boolean> {
    return this.repository.deleteForUser(id, user.username);
  }

  private validateSelections(selections: ReservationProfileSelection[]): ReservationProfileSelection[] {
    if (selections.length === 0) throw new Error("Add at least one target to the reservation profile");
    return selections.map((selection) => {
      const targetIds = this.catalog.validateTargetIds([selection.targetId]);
      const modelIds = this.catalog.canonicalModelIds(unique(selection.modelIds));
      for (const modelId of modelIds) {
        const model = this.catalog.getModel(modelId);
        if (!model?.targetIds.includes(selection.targetId)) {
          throw new Error(`Model ${modelId} is not available on target: ${selection.targetId}`);
        }
      }
      return { targetId: targetIds[0], modelIds };
    });
  }
}

export interface ReservationProfileInput {
  name: string;
  description?: string;
  selections: ReservationProfileSelection[];
  defaultDurationMinutes?: number;
  defaultKeepaliveMinutes?: number;
}

function validateDefaults(input: ReservationProfileInput): void {
  if (!input.name.trim()) throw new Error("Reservation profile name is required");
  if (input.defaultDurationMinutes !== undefined && (!Number.isFinite(input.defaultDurationMinutes) || input.defaultDurationMinutes <= 0 || input.defaultDurationMinutes > MAX_DURATION_MINUTES)) {
    throw new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`);
  }
  if (input.defaultKeepaliveMinutes !== undefined && (!Number.isFinite(input.defaultKeepaliveMinutes) || input.defaultKeepaliveMinutes <= 0 || input.defaultKeepaliveMinutes > MAX_KEEPALIVE_MINUTES)) {
    throw new Error(`Keepalive must be between 1 and ${MAX_KEEPALIVE_MINUTES} minutes`);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
