import type { ApiKey, AssistantConfig, AuthenticatedUser, AuthMethod, CapacityProviderDefinition, CapacityProviderResource, CapacityProviderStatus, CapacityTarget, ExternalUserLink, ModelCapabilityMetadata, ModelDeploymentMetadata, ModelFavorite, RegistrationInvitation, Reservation, ReservationProfile, Role, RuntimeDiscoveredModel, StoredModelCapabilityMetadata, StoredModelDeploymentMetadata, TargetCostEstimateConfig, TargetModelDiscoveryRecord, TargetProvisioningJob, TargetActivation, TargetActivationReservation, TargetStatus, Team, TeamMembership, UserAccount, UserIdentity, UserMergePreview } from "./types.js";

export interface CapacityProvider {
  provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void>;
  reprovisionTarget?(target: CapacityTarget): Promise<Partial<CapacityTarget>>;
  ensureTargetOn(target: CapacityTarget): Promise<void>;
  ensureTargetOff(target: CapacityTarget): Promise<void>;
  getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus>;
  getTargetCostEstimate?(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined>;
  discoverResources?(provider: CapacityProviderDefinition): Promise<CapacityProviderResource[]>;
  forceStopTarget(target: CapacityTarget): Promise<void>;
}

export interface BackendConfigSync {
  syncTargetHealthy(target: CapacityTarget, discoveredModels: RuntimeDiscoveredModel[]): Promise<void>;
}

export interface ReservationRepository {
  create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation>;
  get(id: string): Promise<Reservation | undefined>;
  list(): Promise<Reservation[]>;
  update(id: string, patch: Partial<Reservation>): Promise<Reservation>;
  expireReservations(now: Date): Promise<Reservation[]>;
  listActive(now: Date): Promise<Reservation[]>;
}

export interface ReservationProfileRepository {
  create(input: Omit<ReservationProfile, "id" | "createdAt" | "updatedAt" | "sharingScope"> & { sharingScope?: ReservationProfile["sharingScope"]; id?: string; createdAt?: Date; updatedAt?: Date }): Promise<ReservationProfile>;
  get(id: string): Promise<ReservationProfile | undefined>;
  listForUser(userId: string): Promise<ReservationProfile[]>;
  list(): Promise<ReservationProfile[]>;
  update(id: string, input: ReservationProfile): Promise<ReservationProfile>;
  delete(id: string): Promise<boolean>;
  deleteForUser(id: string, userId: string): Promise<boolean>;
}

export interface ApiKeyRepository {
  create(input: Omit<ApiKey, "id"> & { id?: string }): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | undefined>;
  listForUser(userId: string): Promise<ApiKey[]>;
  deleteForUser(id: string, userId: string): Promise<boolean>;
  touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void>;
}

export interface AuthMethodRepository {
  create(input: AuthMethod): Promise<AuthMethod>;
  get(id: string): Promise<AuthMethod | undefined>;
  list(): Promise<AuthMethod[]>;
  update(id: string, input: AuthMethod): Promise<AuthMethod>;
  delete(id: string): Promise<boolean>;
}

export interface CapacityProviderRepository {
  create(input: CapacityProviderDefinition): Promise<CapacityProviderDefinition>;
  get(id: string): Promise<CapacityProviderDefinition | undefined>;
  list(): Promise<CapacityProviderDefinition[]>;
  update(id: string, input: CapacityProviderDefinition): Promise<CapacityProviderDefinition>;
  delete(id: string): Promise<boolean>;
}

export interface CapacityTargetRepository {
  create(input: CapacityTarget): Promise<CapacityTarget>;
  get(id: string): Promise<CapacityTarget | undefined>;
  list(): Promise<CapacityTarget[]>;
  update(id: string, input: CapacityTarget): Promise<CapacityTarget>;
  delete(id: string): Promise<boolean>;
}

export interface TargetProvisioningJobRepository {
  create(input: TargetProvisioningJob): Promise<TargetProvisioningJob>;
  get(id: string): Promise<TargetProvisioningJob | undefined>;
  getForTarget(targetId: string): Promise<TargetProvisioningJob | undefined>;
  list(): Promise<TargetProvisioningJob[]>;
  update(id: string, patch: Partial<TargetProvisioningJob>): Promise<TargetProvisioningJob>;
}

export interface TargetModelDiscoveryRepository {
  record(input: TargetModelDiscoveryRecord): Promise<TargetModelDiscoveryRecord>;
  get(targetId: string): Promise<TargetModelDiscoveryRecord | undefined>;
  list(): Promise<TargetModelDiscoveryRecord[]>;
  delete(targetId: string): Promise<boolean>;
}

export interface TargetActivationRepository {
  createActivation(input: Omit<TargetActivation, "id"> & { id?: string }): Promise<TargetActivation>;
  getActivation(id: string): Promise<TargetActivation | undefined>;
  getOpenActivationForTarget(targetId: string): Promise<TargetActivation | undefined>;
  listActivationsForTarget(targetId: string): Promise<TargetActivation[]>;
  updateActivation(id: string, patch: Partial<TargetActivation>): Promise<TargetActivation>;
  addReservationCost(input: { targetActivationId: string; reservationId: string; at: Date; estimatedCostUsd: number }): Promise<TargetActivationReservation>;
  closeInactiveReservations(targetActivationId: string, activeReservationIds: string[], endedAt: Date): Promise<TargetActivationReservation[]>;
  closeReservationsForActivation(targetActivationId: string, endedAt: Date): Promise<TargetActivationReservation[]>;
  listActivationReservations(targetActivationId: string): Promise<TargetActivationReservation[]>;
  listReservationAllocations(reservationId: string): Promise<TargetActivationReservation[]>;
}

export interface AuthProvider {
  authenticate(request: { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> }): Promise<AuthenticatedUser | undefined>;
}

export interface IdentityRepository {
  initializeLegacyUsers(adminUsernames: string[]): Promise<void>;
  createUser(input: Omit<UserAccount, "id" | "normalizedUsername" | "sessionVersion" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<UserAccount>;
  getUser(id: string): Promise<UserAccount | undefined>;
  getUserByUsername(username: string): Promise<UserAccount | undefined>;
  listUsers(): Promise<UserAccount[]>;
  updateUser(id: string, patch: Partial<Pick<UserAccount, "displayName" | "status" | "lastLoginAt">>): Promise<UserAccount>;
  incrementSessionVersion(id: string): Promise<UserAccount>;
  getLocalPasswordHash(userId: string): Promise<string | undefined>;
  setLocalPasswordHash(userId: string, passwordHash: string): Promise<void>;
  findIdentity(providerType: UserIdentity["providerType"], providerId: string, subject: string): Promise<UserIdentity | undefined>;
  listIdentities(userId: string): Promise<UserIdentity[]>;
  findUsersByIdentityHint(value: string): Promise<UserAccount[]>;
  saveIdentity(input: Omit<UserIdentity, "id" | "createdAt" | "lastSeenAt"> & { id?: string; createdAt?: Date; lastSeenAt?: Date }): Promise<UserIdentity>;
  listRoles(scope?: Role["scope"]): Promise<Role[]>;
  getRole(id: string): Promise<Role | undefined>;
  createRole(input: Omit<Role, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Role>;
  updateRole(id: string, input: Pick<Role, "name" | "description" | "permissions">): Promise<Role>;
  deleteRole(id: string): Promise<boolean>;
  assignGlobalRole(userId: string, roleId: string): Promise<void>;
  revokeGlobalRole(userId: string, roleId: string): Promise<boolean>;
  listGlobalRolesForUser(userId: string): Promise<Role[]>;
  countEnabledUsersWithPermission(permission: string): Promise<number>;
  createTeam(input: Omit<Team, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Team>;
  getTeam(id: string): Promise<Team | undefined>;
  listTeams(): Promise<Team[]>;
  updateTeam(id: string, input: Pick<Team, "name" | "description" | "parentTeamId">): Promise<Team>;
  deleteTeam(id: string): Promise<boolean>;
  setTeamMembership(input: Omit<TeamMembership, "createdAt"> & { createdAt?: Date }): Promise<TeamMembership>;
  removeTeamMembership(teamId: string, userId: string, source?: TeamMembership["source"], sourceReference?: string): Promise<boolean>;
  reconcileOidcTeamMemberships(userId: string, providerId: string, memberships: Array<Pick<TeamMembership, "teamId" | "roleId" | "sourceReference">>): Promise<void>;
  listTeamMembershipsForUser(userId: string): Promise<TeamMembership[]>;
  listTeamMemberships(teamId: string): Promise<TeamMembership[]>;
  isUserInAnyTeam(userId: string, teamIds: string[]): Promise<boolean>;
  matchesUserAudience(userId: string, audienceUserIds: string[]): Promise<boolean>;
  createInvitation(input: Omit<RegistrationInvitation, "id" | "useCount" | "createdAt"> & { id?: string; useCount?: number; createdAt?: Date }): Promise<RegistrationInvitation>;
  getInvitationByTokenHash(tokenHash: string): Promise<RegistrationInvitation | undefined>;
  consumeInvitation(id: string, now: Date): Promise<RegistrationInvitation>;
  redeemInvitation(input: {
    tokenHash: string;
    username: string;
    displayName?: string;
    passwordHash: string;
    consumedAt: Date;
  }): Promise<UserAccount>;
  revokeInvitation(id: string, revokedAt: Date): Promise<boolean>;
  listInvitations(): Promise<RegistrationInvitation[]>;
  getExternalUserLink(integration: string, externalSubject: string): Promise<ExternalUserLink | undefined>;
  saveExternalUserLink(input: Omit<ExternalUserLink, "createdAt" | "lastSeenAt"> & { createdAt?: Date; lastSeenAt?: Date }): Promise<ExternalUserLink>;
  deleteExternalUserLink(integration: string, externalSubject: string): Promise<boolean>;
  listExternalUserLinks(integration?: string): Promise<ExternalUserLink[]>;
  previewUserMerge(sourceUserId: string, targetUserId: string): Promise<UserMergePreview>;
  mergeUsers(sourceUserId: string, targetUserId: string, mergedAt: Date, actorUserId?: string): Promise<void>;
}

export interface TrafficSource {
  pollRecentTraffic(now?: Date): Promise<Array<{
    modelId: string;
    seenAt: Date;
    requestId?: string;
    externalUserSubject?: string;
    performance?: {
      decodeTokensPerSecond?: number;
      prefillTokensPerSecond?: number;
      timeToFirstTokenSeconds?: number;
    };
  }>>;
}

export interface AssistantConfigRepository {
  get(): Promise<AssistantConfig | undefined>;
  save(input: Omit<AssistantConfig, "id" | "updatedAt"> & { updatedAt?: Date }): Promise<AssistantConfig>;
  clear(): Promise<boolean>;
}

export interface ModelMetadataRepository {
  listCapabilities(): Promise<StoredModelCapabilityMetadata[]>;
  listDeployments(): Promise<StoredModelDeploymentMetadata[]>;
  upsertCapability(input: ModelCapabilityMetadata, updatedAt?: Date): Promise<StoredModelCapabilityMetadata>;
  upsertDeployment(input: ModelDeploymentMetadata, updatedAt?: Date): Promise<StoredModelDeploymentMetadata>;
  deleteCapability(modelId: string): Promise<boolean>;
  deleteDeployment(targetId: string, modelId: string): Promise<boolean>;
}

export interface ModelFavoriteRepository {
  listForUser(userId: string): Promise<ModelFavorite[]>;
  add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite>;
  remove(userId: string, targetId: string, modelId: string): Promise<boolean>;
}

export interface TargetStatusRepository {
  get(targetId: string): TargetStatus | undefined;
  set(status: TargetStatus): void;
  list(): TargetStatus[];
}
