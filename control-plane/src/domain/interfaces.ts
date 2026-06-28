import type { ApiKey, AuthenticatedUser, CapacityProviderStatus, CapacityTarget, Reservation, TargetStatus } from "./types.js";

export interface CapacityProvider {
  installTarget(target: CapacityTarget): Promise<void>;
  ensureTargetOn(target: CapacityTarget): Promise<void>;
  ensureTargetOff(target: CapacityTarget): Promise<void>;
  getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus>;
  forceStopTarget(target: CapacityTarget): Promise<void>;
}

export interface BackendConfigSync {
  syncTargetHealthy(target: CapacityTarget): Promise<void>;
  markTargetUnavailable?(target: CapacityTarget): Promise<void>;
}

export interface ReservationRepository {
  create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation>;
  get(id: string): Promise<Reservation | undefined>;
  list(): Promise<Reservation[]>;
  update(id: string, patch: Partial<Reservation>): Promise<Reservation>;
  expireReservations(now: Date): Promise<Reservation[]>;
  listActive(now: Date): Promise<Reservation[]>;
}

export interface ApiKeyRepository {
  create(input: Omit<ApiKey, "id"> & { id?: string }): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | undefined>;
  listForUser(username: string): Promise<ApiKey[]>;
  deleteForUser(id: string, username: string): Promise<boolean>;
  touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void>;
}

export interface AuthProvider {
  authenticate(request: { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> }): Promise<AuthenticatedUser | undefined>;
}

export interface TrafficSource {
  pollRecentTraffic(now?: Date): Promise<Array<{ modelId: string; seenAt: Date }>>;
}

export interface TargetStatusRepository {
  get(targetId: string): TargetStatus | undefined;
  set(status: TargetStatus): void;
  list(): TargetStatus[];
}
