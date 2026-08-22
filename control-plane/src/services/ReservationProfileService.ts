import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ReservationProfile, ReservationProfileSelection, Team } from "../domain/types.js";
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
    await this.requireDestinationManagement(user, input.teamId);
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections, input.teamId);
    validateDefaults(input);
    return this.repository.create({
      userId: user.id,
      username: user.username,
      teamId: input.teamId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      selections,
      defaultDurationMinutes: input.defaultDurationMinutes,
      defaultKeepaliveMinutes: input.defaultKeepaliveMinutes
    });
  }

  async listForUser(user: AuthenticatedUser): Promise<ReservationProfile[]> {
    if (!this.identities) return this.repository.listForUser(user.id);
    const teamIds = new Set((await this.identities.listProfileTeams(user, "use")).map((team) => team.id));
    return (await this.repository.list())
      .filter((profile) => profile.userId === user.id || Boolean(profile.teamId && teamIds.has(profile.teamId)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async getManageable(id: string, user: AuthenticatedUser): Promise<ReservationProfile> {
    const profile = await this.repository.get(id);
    if (!profile || !await this.canManage(user, profile)) throw new Error("Reservation profile not found");
    return profile;
  }

  async canManage(user: AuthenticatedUser, profile: ReservationProfile): Promise<boolean> {
    if (profile.teamId) return this.identities ? this.identities.canManageTeamProfile(user, profile.teamId) : false;
    return profile.userId === user.id && (!this.identities || this.identities.hasPermission(user, "profiles.manage_own"));
  }

  async listAssignableTeams(user: AuthenticatedUser): Promise<Team[]> {
    return this.identities ? this.identities.listProfileTeams(user, "manage") : [];
  }

  async updateForUser(id: string, user: AuthenticatedUser, input: ReservationProfileInput): Promise<ReservationProfile> {
    const existing = await this.getManageable(id, user);
    await this.requireDestinationManagement(user, input.teamId, existing);
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections, input.teamId);
    validateDefaults(input);
    return this.repository.update(id, {
      ...existing,
      teamId: input.teamId,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      selections,
      defaultDurationMinutes: input.defaultDurationMinutes,
      defaultKeepaliveMinutes: input.defaultKeepaliveMinutes,
      updatedAt: new Date()
    });
  }

  async deleteForUser(id: string, user: AuthenticatedUser): Promise<boolean> {
    await this.getManageable(id, user);
    return this.repository.delete(id);
  }

  private async requireDestinationManagement(user: AuthenticatedUser, teamId?: string, existing?: ReservationProfile): Promise<void> {
    if (!this.identities) {
      if (teamId) throw new Error("Team profiles require identity management");
      return;
    }
    if (!teamId) {
      if (existing?.teamId && existing.userId !== user.id) throw new Error("Only the profile creator can make a team profile personal");
      if (!this.identities.hasPermission(user, "profiles.manage_own")) throw new Error("Profile management permission is required");
      return;
    }
    if (!await this.identities.canManageTeamProfile(user, teamId)) throw new Error("Team profile management permission is required");
  }

  private async requireTargetAccess(user: AuthenticatedUser, selections: ReservationProfileSelection[], teamId?: string): Promise<void> {
    if (!this.identities) return;
    for (const selection of selections) {
      const target = this.catalog.getTarget(selection.targetId);
      const available = target && (teamId ? await this.identities.canTeamAccessTarget(teamId, target) : await this.identities.canAccessTarget(user, target, "use"));
      if (!available) throw new Error(teamId ? `Target is not available to the whole team: ${selection.targetId}` : `Target is not available: ${selection.targetId}`);
    }
  }

}

export interface ReservationProfileInput {
  name: string;
  description?: string;
  teamId?: string;
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
