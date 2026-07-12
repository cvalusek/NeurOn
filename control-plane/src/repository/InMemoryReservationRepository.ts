import { nanoid } from "nanoid";
import type { ReservationRepository } from "../domain/interfaces.js";
import type { Reservation } from "../domain/types.js";

export class InMemoryReservationRepository implements ReservationRepository {
  private readonly reservations = new Map<string, Reservation>();

  async create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation> {
    const reservation = { ...input, id: input.id ?? nanoid(12) };
    this.reservations.set(reservation.id, cloneReservation(reservation));
    return cloneReservation(reservation);
  }

  async get(id: string): Promise<Reservation | undefined> {
    const reservation = this.reservations.get(id);
    return reservation ? cloneReservation(reservation) : undefined;
  }

  async list(): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).map(cloneReservation);
  }

  async update(id: string, patch: Partial<Reservation>): Promise<Reservation> {
    const current = this.reservations.get(id);
    if (!current) throw new Error(`Reservation not found: ${id}`);
    const updated = { ...current, ...patch };
    this.reservations.set(id, cloneReservation(updated));
    return cloneReservation(updated);
  }

  async expireReservations(now: Date): Promise<Reservation[]> {
    const expired: Reservation[] = [];
    for (const reservation of this.reservations.values()) {
      if (reservation.status === "active" && reservation.expiresAt <= now) {
        reservation.status = "expired";
        reservation.endedAt = now;
        expired.push(cloneReservation(reservation));
      }
    }
    return expired;
  }

  async listActive(now: Date): Promise<Reservation[]> {
    return Array.from(this.reservations.values())
      .filter((reservation) => reservation.status === "active" && reservation.expiresAt > now)
      .map(cloneReservation);
  }
}

function cloneReservation(reservation: Reservation): Reservation {
  return {
    ...reservation,
    profileId: reservation.profileId,
    profileName: reservation.profileName,
    modelIds: [...reservation.modelIds],
    targetIds: [...reservation.targetIds],
    createdAt: new Date(reservation.createdAt),
    expiresAt: new Date(reservation.expiresAt),
    endedAt: reservation.endedAt ? new Date(reservation.endedAt) : undefined
  };
}
