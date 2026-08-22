import { nanoid } from "nanoid";
import pg from "pg";
import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { ReservationProfile, ReservationProfileSelection } from "../domain/types.js";

interface ReservationProfileRow {
  id: string;
  user_id: string;
  username: string;
  team_id: string | null;
  name: string;
  description: string | null;
  selections: ReservationProfileSelection[] | string;
  default_duration_minutes: number | null;
  default_keepalive_minutes: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresReservationProfileRepository implements ReservationProfileRepository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async create(input: Omit<ReservationProfile, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<ReservationProfile> {
    const now = new Date();
    const profile = { ...input, id: input.id ?? nanoid(12), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    await this.pool.query(
      `insert into reservation_profiles (
        id, user_id, username, team_id, name, description, selections, default_duration_minutes,
        default_keepalive_minutes, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      toSqlValues(profile)
    );
    return cloneProfile(profile);
  }

  async get(id: string): Promise<ReservationProfile | undefined> {
    const result = await this.pool.query<ReservationProfileRow>("select * from reservation_profiles where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listForUser(userId: string): Promise<ReservationProfile[]> {
    const result = await this.pool.query<ReservationProfileRow>("select * from reservation_profiles where user_id = $1 order by name asc, id asc", [userId]);
    return result.rows.map(fromRow);
  }

  async list(): Promise<ReservationProfile[]> {
    const result = await this.pool.query<ReservationProfileRow>("select * from reservation_profiles order by username asc, name asc, id asc");
    return result.rows.map(fromRow);
  }

  async update(id: string, input: ReservationProfile): Promise<ReservationProfile> {
    await this.pool.query(
      `update reservation_profiles set
        user_id = $2,
        username = $3,
        team_id = $4,
        name = $5,
        description = $6,
        selections = $7::jsonb,
        default_duration_minutes = $8,
        default_keepalive_minutes = $9,
        created_at = $10,
        updated_at = $11
      where id = $1`,
      toSqlValues({ ...input, id })
    );
    return cloneProfile({ ...input, id });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from reservation_profiles where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query("delete from reservation_profiles where id = $1 and user_id = $2", [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }

}

function toSqlValues(profile: ReservationProfile): unknown[] {
  return [
    profile.id,
    profile.userId,
    profile.username,
    profile.teamId ?? null,
    profile.name,
    profile.description ?? null,
    JSON.stringify(profile.selections),
    profile.defaultDurationMinutes ?? null,
    profile.defaultKeepaliveMinutes ?? null,
    profile.createdAt,
    profile.updatedAt
  ];
}

function fromRow(row: ReservationProfileRow): ReservationProfile {
  const selections = typeof row.selections === "string" ? JSON.parse(row.selections) as ReservationProfileSelection[] : row.selections;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    teamId: row.team_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    selections,
    defaultDurationMinutes: row.default_duration_minutes ?? undefined,
    defaultKeepaliveMinutes: row.default_keepalive_minutes ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function cloneProfile(profile: ReservationProfile): ReservationProfile {
  return {
    ...profile,
    selections: profile.selections.map((selection) => ({ ...selection, modelIds: [...selection.modelIds] })),
    createdAt: new Date(profile.createdAt),
    updatedAt: new Date(profile.updatedAt)
  };
}
