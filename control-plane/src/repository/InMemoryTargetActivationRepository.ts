import { nanoid } from "nanoid";
import type { TargetActivationRepository } from "../domain/interfaces.js";
import type { TargetActivation, TargetActivationReservation } from "../domain/types.js";
import { cloneTargetActivation, cloneTargetActivationReservation } from "./targetActivationUtils.js";

export class InMemoryTargetActivationRepository implements TargetActivationRepository {
  private readonly activations = new Map<string, TargetActivation>();
  private readonly links = new Map<string, TargetActivationReservation>();

  async createActivation(input: Omit<TargetActivation, "id"> & { id?: string }): Promise<TargetActivation> {
    const activation = { ...input, id: input.id ?? nanoid(12) };
    this.activations.set(activation.id, cloneTargetActivation(activation));
    return cloneTargetActivation(activation);
  }

  async getActivation(id: string): Promise<TargetActivation | undefined> {
    const activation = this.activations.get(id);
    return activation ? cloneTargetActivation(activation) : undefined;
  }

  async getOpenActivationForTarget(targetId: string): Promise<TargetActivation | undefined> {
    const activation = Array.from(this.activations.values()).find((candidate) => candidate.targetId === targetId && candidate.status === "open");
    return activation ? cloneTargetActivation(activation) : undefined;
  }

  async listActivationsForTarget(targetId: string): Promise<TargetActivation[]> {
    return Array.from(this.activations.values())
      .filter((activation) => activation.targetId === targetId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneTargetActivation);
  }

  async updateActivation(id: string, patch: Partial<TargetActivation>): Promise<TargetActivation> {
    const current = this.activations.get(id);
    if (!current) throw new Error(`Target activation not found: ${id}`);
    const updated = { ...current, ...patch, id };
    this.activations.set(id, cloneTargetActivation(updated));
    return cloneTargetActivation(updated);
  }

  async addReservationCost(input: { targetActivationId: string; reservationId: string; at: Date; estimatedCostUsd: number }): Promise<TargetActivationReservation> {
    const existing = Array.from(this.links.values()).find((link) => link.targetActivationId === input.targetActivationId && link.reservationId === input.reservationId);
    if (existing) {
      const updated = {
        ...existing,
        endedAt: undefined,
        estimatedCostUsd: existing.estimatedCostUsd + input.estimatedCostUsd
      };
      this.links.set(existing.id, cloneTargetActivationReservation(updated));
      return cloneTargetActivationReservation(updated);
    }
    const link: TargetActivationReservation = {
      id: nanoid(12),
      targetActivationId: input.targetActivationId,
      reservationId: input.reservationId,
      startedAt: input.at,
      estimatedCostUsd: input.estimatedCostUsd
    };
    this.links.set(link.id, cloneTargetActivationReservation(link));
    return cloneTargetActivationReservation(link);
  }

  async closeInactiveReservations(targetActivationId: string, activeReservationIds: string[], endedAt: Date): Promise<TargetActivationReservation[]> {
    const active = new Set(activeReservationIds);
    return this.closeLinks((link) => link.targetActivationId === targetActivationId && !active.has(link.reservationId) && !link.endedAt, endedAt);
  }

  async closeReservationsForActivation(targetActivationId: string, endedAt: Date): Promise<TargetActivationReservation[]> {
    return this.closeLinks((link) => link.targetActivationId === targetActivationId && !link.endedAt, endedAt);
  }

  async listActivationReservations(targetActivationId: string): Promise<TargetActivationReservation[]> {
    return Array.from(this.links.values())
      .filter((link) => link.targetActivationId === targetActivationId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneTargetActivationReservation);
  }

  async listReservationAllocations(reservationId: string): Promise<TargetActivationReservation[]> {
    return Array.from(this.links.values())
      .filter((link) => link.reservationId === reservationId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneTargetActivationReservation);
  }

  private closeLinks(predicate: (link: TargetActivationReservation) => boolean, endedAt: Date): TargetActivationReservation[] {
    const closed: TargetActivationReservation[] = [];
    for (const link of this.links.values()) {
      if (!predicate(link)) continue;
      const updated = { ...link, endedAt };
      this.links.set(link.id, cloneTargetActivationReservation(updated));
      closed.push(cloneTargetActivationReservation(updated));
    }
    return closed;
  }
}
