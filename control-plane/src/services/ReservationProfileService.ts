import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ReservationProfile, ReservationProfileSelection, ReservationProfileSharing, Team } from "../domain/types.js";
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
    const sharing = normalizeSharing(input);
    await this.requireDestinationManagement(user, sharing.sharingScope, sharing.teamId);
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections, sharing.sharingScope, sharing.teamId);
    validateDefaults(input);
    return this.repository.create({
      userId: user.id,
      username: user.username,
      ...sharing,
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
      .filter((profile) => profile.userId === user.id || profile.sharingScope === "everyone" || Boolean(profile.sharingScope === "team" && profile.teamId && teamIds.has(profile.teamId)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async getManageable(id: string, user: AuthenticatedUser): Promise<ReservationProfile> {
    const profile = await this.repository.get(id);
    if (!profile || !await this.canManage(user, profile)) throw new Error("Reservation profile not found");
    return profile;
  }

  async canManage(user: AuthenticatedUser, profile: ReservationProfile): Promise<boolean> {
    if (profile.userId === user.id) return !this.identities || this.identities.hasPermission(user, "profiles.manage_own");
    if (profile.sharingScope === "team" && profile.teamId) return this.identities ? this.identities.canManageTeamProfile(user, profile.teamId) : false;
    return false;
  }

  async listAssignableTeams(user: AuthenticatedUser): Promise<Team[]> {
    return this.identities ? this.identities.listProfileTeams(user, "use") : [];
  }

  async updateForUser(id: string, user: AuthenticatedUser, input: ReservationProfileInput): Promise<ReservationProfile> {
    const existing = await this.getManageable(id, user);
    const sharing = normalizeSharing(input, existing);
    await this.requireDestinationManagement(user, sharing.sharingScope, sharing.teamId, existing);
    const selections = normalizeReservationProfileSelections(this.catalog, input.selections);
    await this.requireTargetAccess(user, selections, sharing.sharingScope, sharing.teamId);
    validateDefaults(input);
    return this.repository.update(id, {
      ...existing,
      ...sharing,
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

  private async requireDestinationManagement(user: AuthenticatedUser, sharingScope: ReservationProfileSharing, teamId?: string, existing?: ReservationProfile): Promise<void> {
    if (!this.identities) {
      if (sharingScope === "team") throw new Error("Team profiles require identity management");
      return;
    }
    if (!this.identities.hasPermission(user, "profiles.manage_own") && existing?.userId === user.id) throw new Error("Profile management permission is required");
    if (existing && existing.userId !== user.id && (existing.sharingScope !== "team" || sharingScope !== "team" || teamId !== existing.teamId)) {
      throw new Error("Only the profile creator can change who can use a shared profile");
    }
    if (sharingScope === "team" && teamId && !await this.identities.canUseTeamProfile(user, teamId)) throw new Error("Team membership is required to share a profile with that team");
  }

  private async requireTargetAccess(user: AuthenticatedUser, selections: ReservationProfileSelection[], sharingScope: ReservationProfileSharing, teamId?: string): Promise<void> {
    if (!this.identities) return;
    for (const selection of selections) {
      const target = this.catalog.getTarget(selection.targetId);
      const available = target && (sharingScope === "everyone"
        ? !target.audience || target.audience.scope === "global"
        : sharingScope === "team" && teamId
          ? await this.identities.canTeamAccessTarget(teamId, target)
          : await this.identities.canAccessTarget(user, target, "use"));
      if (!available) throw new Error(sharingScope === "everyone"
        ? `Target is not available to everyone: ${selection.targetId}`
        : sharingScope === "team" ? `Target is not available to the whole team: ${selection.targetId}` : `Target is not available: ${selection.targetId}`);
    }
  }

}

export interface ReservationProfileInput {
  name: string;
  description?: string;
  sharingScope?: ReservationProfileSharing;
  teamId?: string;
  selections: ReservationProfileSelection[];
  defaultDurationMinutes?: number;
  defaultKeepaliveMinutes?: number;
}

function normalizeSharing(input: Pick<ReservationProfileInput, "sharingScope" | "teamId">, existing?: Pick<ReservationProfile, "sharingScope" | "teamId">): { sharingScope: ReservationProfileSharing; teamId?: string } {
  if (input.sharingScope === undefined && input.teamId === undefined && existing) return {
    sharingScope: existing.sharingScope ?? (existing.teamId ? "team" : "personal"),
    ...(existing.teamId ? { teamId: existing.teamId } : {})
  };
  const sharingScope = input.sharingScope ?? (input.teamId ? "team" : "personal");
  if (sharingScope === "team" && !input.teamId) throw new Error("Choose a team for a team profile");
  if (sharingScope !== "team" && input.teamId) throw new Error("Only team profiles can include a team");
  return { sharingScope, ...(sharingScope === "team" ? { teamId: input.teamId } : {}) };
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
