import { nanoid } from "nanoid";
import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { ReservationProfile } from "../domain/types.js";

export class InMemoryReservationProfileRepository implements ReservationProfileRepository {
  private readonly profiles = new Map<string, ReservationProfile>();

  async create(input: Omit<ReservationProfile, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<ReservationProfile> {
    const now = new Date();
    const profile = { ...input, id: input.id ?? nanoid(12), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.profiles.set(profile.id, cloneProfile(profile));
    return cloneProfile(profile);
  }

  async get(id: string): Promise<ReservationProfile | undefined> {
    const profile = this.profiles.get(id);
    return profile ? cloneProfile(profile) : undefined;
  }

  async listForUser(username: string): Promise<ReservationProfile[]> {
    return Array.from(this.profiles.values())
      .filter((profile) => profile.username === username)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(cloneProfile);
  }

  async update(id: string, input: ReservationProfile): Promise<ReservationProfile> {
    if (!this.profiles.has(id)) throw new Error(`Reservation profile not found: ${id}`);
    this.profiles.set(id, cloneProfile(input));
    return cloneProfile(input);
  }

  async deleteForUser(id: string, username: string): Promise<boolean> {
    const profile = this.profiles.get(id);
    if (!profile || profile.username !== username) return false;
    return this.profiles.delete(id);
  }
}

function cloneProfile(profile: ReservationProfile): ReservationProfile {
  return {
    ...profile,
    selections: profile.selections.map((selection) => ({ ...selection, modelIds: [...selection.modelIds] })),
    createdAt: new Date(profile.createdAt),
    updatedAt: new Date(profile.updatedAt)
  };
}
