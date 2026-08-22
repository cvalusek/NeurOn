import type { ReservationProfileRepository, ReservationRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, Reservation, ReservationProfile, ReservationProfileSelection } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";
import { normalizeReservationProfileSelections } from "./reservationProfileSelections.js";
import type { IdentityService } from "./IdentityService.js";

const MAX_DURATION_MINUTES = 12 * 60;
const DEFAULT_KEEPALIVE_MINUTES = 2;
const MAX_KEEPALIVE_MINUTES = 60;

export class ReservationService {
  private activeDemandMutations = 0;

  constructor(
    private readonly repository: ReservationRepository,
    private readonly catalog: ModelCatalog,
    private readonly profiles?: ReservationProfileRepository,
    private readonly onReservationChanged?: () => void,
    private readonly acceptingReservations: () => boolean = () => true,
    private readonly identities?: IdentityService
  ) {}

  async createForUser(user: AuthenticatedUser, input: { modelIds?: string[]; targetIds?: string[]; profileId?: string; durationMinutes?: number; keepaliveMinutes?: number; synthetic?: boolean }): Promise<Reservation> {
    if (this.identities && !this.identities.hasPermission(user, "reservations.create")) throw new Error("Reservation permission is required");
    const finishMutation = this.beginDemandMutation();
    try {
      const storedProfile = input.profileId ? await this.getAccessibleProfile(input.profileId, user) : undefined;
      const profile = storedProfile ? {
        ...storedProfile,
        selections: normalizeReservationProfileSelections(this.catalog, storedProfile.selections)
      } : undefined;
      const expandedInput = inputWithResolvedDefaults(profile, input);
      this.validateInput(expandedInput);
      const requestedModelIds = unique(expandedInput.modelIds ?? []);
      const modelIds = requestedModelIds.length > 0 ? this.catalog.canonicalModelIds(requestedModelIds) : [];
      const requestedTargetIds = unique(expandedInput.targetIds ?? []);
      const now = new Date();
      const targetIds = this.targetIdsForRequest(modelIds, requestedTargetIds);
      await this.requireTargetAccess(user, targetIds);
      const targetSelections = this.targetSelectionsForRequest(profile, modelIds, targetIds);
      const reservation = await this.repository.create({
        userId: input.synthetic ? undefined : user.id,
        username: user.username,
        apiKeyName: user.apiKeyName,
        profileId: profile?.id,
        profileName: profile?.name,
        modelIds,
        targetIds,
        targetSelections,
        createdAt: now,
        expiresAt: new Date(now.getTime() + expandedInput.durationMinutes * 60_000),
        keepaliveMinutes: expandedInput.keepaliveMinutes ?? DEFAULT_KEEPALIVE_MINUTES,
        status: "active",
        synthetic: input.synthetic
      });
      this.notifyReservationChanged();
      return reservation;
    } finally {
      finishMutation();
    }
  }

  async getOwned(id: string, user: AuthenticatedUser): Promise<Reservation> {
    const reservation = await this.repository.get(id);
    if (!reservation) throw new Error("Reservation not found");
    if (reservation.userId !== user.id && !(this.identities ? this.identities.hasPermission(user, "reservations.manage_any") : user.isAdmin)) throw new Error("Reservation not found");
    return reservation;
  }

  async listActiveOwned(user: AuthenticatedUser, now = new Date()): Promise<Reservation[]> {
    return (await this.repository.listActive(now)).filter((reservation) => reservation.userId === user.id);
  }

  async markDone(id: string, user: AuthenticatedUser): Promise<Reservation> {
    if (this.identities && !this.identities.hasPermission(user, "reservations.manage_own") && !this.identities.hasPermission(user, "reservations.manage_any")) throw new Error("Reservation management permission is required");
    await this.getOwned(id, user);
    const reservation = await this.repository.update(id, { status: "done", endedAt: new Date() });
    this.notifyReservationChanged();
    return reservation;
  }

  async extend(id: string, user: AuthenticatedUser, durationMinutes: number, options: { fromNow?: boolean } = {}): Promise<Reservation> {
    if (this.identities && !this.identities.hasPermission(user, "reservations.manage_own") && !this.identities.hasPermission(user, "reservations.manage_any")) throw new Error("Reservation management permission is required");
    const finishMutation = this.beginDemandMutation();
    try {
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
        throw new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`);
      }
      const reservation = await this.getOwned(id, user);
      if (reservation.status !== "active") throw new Error("Only active reservations can be extended");
      const baseTime = options.fromNow ? Date.now() : Math.max(Date.now(), reservation.expiresAt.getTime());
      const updated = await this.repository.update(id, {
        expiresAt: new Date(baseTime + durationMinutes * 60_000)
      });
      this.notifyReservationChanged();
      return updated;
    } finally {
      finishMutation();
    }
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

  private targetSelectionsForRequest(profile: ReservationProfile | undefined, modelIds: string[], targetIds: string[]): ReservationProfileSelection[] {
    if (profile) {
      return profile.selections.map((selection) => ({
        targetId: selection.targetId,
        modelIds: [...selection.modelIds]
      }));
    }
    return targetIds.map((targetId) => ({
      targetId,
      modelIds: modelIds.filter((modelId) => this.catalog.getModel(modelId)?.targetIds.includes(targetId))
    }));
  }

  private async getAccessibleProfile(profileId: string, user: AuthenticatedUser): Promise<ReservationProfile> {
    if (!this.profiles) throw new Error("Reservation profiles are not configured");
    const profile = await this.profiles.get(profileId);
    const accessible = profile && (profile.sharingScope === "everyone"
      || (profile.sharingScope === "team" && profile.teamId
        ? Boolean(this.identities && await this.identities.canUseTeamProfile(user, profile.teamId))
        : profile.userId === user.id));
    if (!profile || !accessible) throw new Error("Reservation profile not found");
    return profile;
  }

  private async requireTargetAccess(user: AuthenticatedUser, targetIds: string[]): Promise<void> {
    if (!this.identities) return;
    for (const targetId of targetIds) {
      const target = this.catalog.getTarget(targetId);
      if (!target || !await this.identities.canAccessTarget(user, target, "use")) throw new Error(`Target is not available: ${targetId}`);
    }
  }

  private notifyReservationChanged(): void {
    try {
      this.onReservationChanged?.();
    } catch {
      // The periodic reconciler remains the recovery path if a wake cannot be scheduled.
    }
  }

  activeDemandMutationCount(): number {
    return this.activeDemandMutations;
  }

  private beginDemandMutation(): () => void {
    if (!this.acceptingReservations()) throw new Error("NeurOn is draining for restart; new reservations and extensions are temporarily disabled");
    this.activeDemandMutations += 1;
    return () => {
      this.activeDemandMutations -= 1;
    };
  }
}

function inputWithResolvedDefaults(profile: ReservationProfile | undefined, input: { modelIds?: string[]; targetIds?: string[]; durationMinutes?: number; keepaliveMinutes?: number; synthetic?: boolean }) {
  const expanded = profile
    ? {
        modelIds: unique(profile.selections.flatMap((selection) => selection.modelIds)),
        targetIds: unique(profile.selections.map((selection) => selection.targetId)),
        durationMinutes: input.durationMinutes ?? profile.defaultDurationMinutes,
        keepaliveMinutes: input.keepaliveMinutes ?? profile.defaultKeepaliveMinutes
      }
    : input;
  if (expanded.durationMinutes === undefined) throw new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`);
  return { ...expanded, durationMinutes: expanded.durationMinutes };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
