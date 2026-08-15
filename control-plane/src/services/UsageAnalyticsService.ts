import type { ReservationProfileRepository, ReservationRepository, TargetActivationRepository } from "../domain/interfaces.js";
import type { Reservation } from "../domain/types.js";
import type { ModelCatalog } from "./ModelCatalog.js";

export interface DeploymentUsage {
  targetId: string;
  modelId: string;
  profileCount: number;
  reservationCount: number;
  distinctUserCount: number;
  lastUsedAt?: string;
  popularityScore: number;
}

interface UsageBucket {
  key: string;
  label: string;
  reservationIds: Set<string>;
  activatedMinutes: number;
  estimatedCostUsd: number;
}

export class UsageAnalyticsService {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly profiles: ReservationProfileRepository,
    private readonly activations: TargetActivationRepository,
    private readonly catalog: ModelCatalog
  ) {}

  async deploymentUsage(windowDays = 30, now = new Date()): Promise<DeploymentUsage[]> {
    const cutoff = now.getTime() - windowDays * 86_400_000;
    const [reservations, profiles] = await Promise.all([this.reservations.list(), this.profiles.list()]);
    return this.catalog.listTargets().flatMap((target) => this.catalog.listModelsForTarget(target.id).map((model) => {
      const matchingProfiles = profiles.filter((profile) => profile.selections.some((selection) => selection.targetId === target.id && selection.modelIds.includes(model.id)));
      const matchingReservations = reservations.filter((reservation) => !reservation.synthetic && reservation.createdAt.getTime() >= cutoff && modelsForTarget(reservation, target.id).includes(model.id));
      const lastUsed = Math.max(...matchingReservations.map((reservation) => (reservation.endedAt ?? reservation.createdAt).getTime()));
      const distinctUserCount = new Set(matchingReservations.map((reservation) => reservation.username)).size;
      return {
        targetId: target.id,
        modelId: model.id,
        profileCount: matchingProfiles.length,
        reservationCount: matchingReservations.length,
        distinctUserCount,
        lastUsedAt: Number.isFinite(lastUsed) ? new Date(lastUsed).toISOString() : undefined,
        popularityScore: distinctUserCount * 1000 + matchingReservations.length
      };
    }));
  }

  async report(windowDays = 30, now = new Date()) {
    const cutoff = new Date(now.getTime() - windowDays * 86_400_000);
    const reservations = await this.reservations.list();
    const byReservation = new Map(reservations.map((reservation) => [reservation.id, reservation]));
    const daily = new Map<string, UsageBucket>();
    const users = new Map<string, UsageBucket>();
    const providers = new Map<string, UsageBucket>();
    const targets = new Map<string, UsageBucket>();
    const models = new Map<string, UsageBucket>();
    for (const target of this.catalog.listTargets()) {
      for (const activation of await this.activations.listActivationsForTarget(target.id)) {
        const allocations = await this.activations.listActivationReservations(activation.id);
        for (const allocation of allocations) {
          const reservation = byReservation.get(allocation.reservationId);
          if (!reservation || reservation.synthetic) continue;
          const fullEnd = new Date(Math.min((allocation.endedAt ?? now).getTime(), now.getTime()));
          const startedAt = new Date(Math.max(allocation.startedAt.getTime(), cutoff.getTime()));
          if (fullEnd <= startedAt) continue;
          const fullDurationMs = Math.max(1, fullEnd.getTime() - allocation.startedAt.getTime());
          const overlapMs = fullEnd.getTime() - startedAt.getTime();
          const minutes = overlapMs / 60_000;
          const allocatedCost = allocation.estimatedCostUsd * overlapMs / fullDurationMs;
          const modelIds = modelsForTarget(reservation, target.id);
          const costShare = allocatedCost / Math.max(1, modelIds.length);
          for (const segment of utcDaySegments(startedAt, fullEnd)) {
            add(daily, segment.day, segment.day, reservation.id, segment.milliseconds / 60_000, allocatedCost * segment.milliseconds / overlapMs);
          }
          add(users, reservation.username, reservation.username, reservation.id, minutes, allocatedCost);
          add(providers, target.providerId ?? target.provider, target.providerId ?? target.provider, reservation.id, minutes, allocatedCost);
          add(targets, target.id, target.displayName, reservation.id, minutes, allocatedCost);
          for (const modelId of modelIds.length ? modelIds : ["(all models)"]) add(models, modelId, this.catalog.getModel(modelId)?.displayName ?? modelId, reservation.id, minutes / Math.max(1, modelIds.length), costShare);
        }
      }
    }
    return { windowDays, generatedAt: now.toISOString(), timezone: "UTC", daily: values(daily).sort((a, b) => b.label.localeCompare(a.label)), users: values(users), providers: values(providers), targets: values(targets), models: values(models) };
  }
}

function modelsForTarget(reservation: Reservation, targetId: string): string[] {
  return reservation.targetSelections?.find((selection) => selection.targetId === targetId)?.modelIds ?? (reservation.targetIds.includes(targetId) ? reservation.modelIds : []);
}
function utcDate(value: Date): string { return value.toISOString().slice(0, 10); }
function utcDaySegments(start: Date, end: Date): Array<{ day: string; milliseconds: number }> {
  const segments: Array<{ day: string; milliseconds: number }> = [];
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const at = new Date(cursor);
    const nextDay = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
    const segmentEnd = Math.min(end.getTime(), nextDay);
    segments.push({ day: utcDate(at), milliseconds: segmentEnd - cursor });
    cursor = segmentEnd;
  }
  return segments;
}
function add(map: Map<string, UsageBucket>, key: string, label: string, reservationId: string, minutes: number, cost: number): void {
  const bucket = map.get(key) ?? { key, label, reservationIds: new Set<string>(), activatedMinutes: 0, estimatedCostUsd: 0 };
  bucket.reservationIds.add(reservationId); bucket.activatedMinutes += minutes; bucket.estimatedCostUsd += cost; map.set(key, bucket);
}
function values(map: Map<string, UsageBucket>) {
  return Array.from(map.values()).map((bucket) => ({ key: bucket.key, label: bucket.label, reservationCount: bucket.reservationIds.size, activatedMinutes: Math.round(bucket.activatedMinutes * 10) / 10, estimatedCostUsd: Math.round(bucket.estimatedCostUsd * 1_000_000) / 1_000_000 })).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.reservationCount - a.reservationCount || a.label.localeCompare(b.label));
}
