import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ReservationProfile, ReservationProfileSelection } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";
import { normalizeReservationProfileSelections } from "./reservationProfileSelections.js";
import type { IdentityService } from "./IdentityService.js";

const MAX_DURATION_MINUTES = 12 * 60;
const MAX_KEEPALIVE_MINUTES = 60;

export class ReservationProfileService {
  constructor(
    private readonly repository: ReservationProfileRepository,
    private readonly catalog: ModelCatalog,
    private readonly identities?: IdentityService
  ) {}

  async createForUser(user: AuthenticatedUser, input: ReservationProfileInput): Promise<ReservationProfile> {
    if (this.identities && !this.identities.hasPermission(user, "profiles.manage_own")) throw new Error("Profile management permission is required");
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections);
    validateDefaults(input);
    return this.repository.create({
      userId: user.id,
      username: user.username,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      selections,
      defaultDurationMinutes: input.defaultDurationMinutes,
      defaultKeepaliveMinutes: input.defaultKeepaliveMinutes
    });
  }

  async listForUser(user: AuthenticatedUser): Promise<ReservationProfile[]> {
    return this.repository.listForUser(user.id);
  }

  async getOwned(id: string, user: AuthenticatedUser): Promise<ReservationProfile> {
    const profile = await this.repository.get(id);
    if (!profile || profile.userId !== user.id) throw new Error("Reservation profile not found");
    return profile;
  }

  async updateForUser(id: string, user: AuthenticatedUser, input: ReservationProfileInput): Promise<ReservationProfile> {
    if (this.identities && !this.identities.hasPermission(user, "profiles.manage_own")) throw new Error("Profile management permission is required");
    const existing = await this.getOwned(id, user);
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections);
    validateDefaults(input);
    return this.repository.update(id, {
      ...existing,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      selections,
      defaultDurationMinutes: input.defaultDurationMinutes,
      defaultKeepaliveMinutes: input.defaultKeepaliveMinutes,
      updatedAt: new Date()
    });
  }

  async deleteForUser(id: string, user: AuthenticatedUser): Promise<boolean> {
    if (this.identities && !this.identities.hasPermission(user, "profiles.manage_own")) throw new Error("Profile management permission is required");
    return this.repository.deleteForUser(id, user.id);
  }

  private async requireTargetAccess(user: AuthenticatedUser, selections: ReservationProfileSelection[]): Promise<void> {
    if (!this.identities) return;
    for (const selection of selections) {
      const target = this.catalog.getTarget(selection.targetId);
      if (!target || !await this.identities.canAccessTarget(user, target, "use")) throw new Error(`Target is not available: ${selection.targetId}`);
    }
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
