import { nanoid } from "nanoid";
import pg from "pg";
import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { ReservationProfile, ReservationProfileSelection } from "../domain/types.js";

const { Pool } = pg;

interface ReservationProfileRow {
  id: string;
  username: string;
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

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists reservation_profiles (
        id text primary key,
        username text not null,
        name text not null,
        description text,
        selections jsonb not null,
        default_duration_minutes integer,
        default_keepalive_minutes integer,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      create index if not exists idx_reservation_profiles_username_name
        on reservation_profiles(username, name);
    `);
  }

  async create(input: Omit<ReservationProfile, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<ReservationProfile> {
    const now = new Date();
    const profile = { ...input, id: input.id ?? nanoid(12), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    await this.pool.query(
      `insert into reservation_profiles (
        id, username, name, description, selections, default_duration_minutes,
        default_keepalive_minutes, created_at, updated_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      toSqlValues(profile)
    );
    return cloneProfile(profile);
  }

  async get(id: string): Promise<ReservationProfile | undefined> {
    const result = await this.pool.query<ReservationProfileRow>("select * from reservation_profiles where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listForUser(username: string): Promise<ReservationProfile[]> {
    const result = await this.pool.query<ReservationProfileRow>("select * from reservation_profiles where username = $1 order by name asc, id asc", [username]);
    return result.rows.map(fromRow);
  }

  async update(id: string, input: ReservationProfile): Promise<ReservationProfile> {
    await this.pool.query(
      `update reservation_profiles set
        username = $2,
        name = $3,
        description = $4,
        selections = $5::jsonb,
        default_duration_minutes = $6,
        default_keepalive_minutes = $7,
        created_at = $8,
        updated_at = $9
      where id = $1`,
      toSqlValues({ ...input, id })
    );
    return cloneProfile({ ...input, id });
  }

  async deleteForUser(id: string, username: string): Promise<boolean> {
    const result = await this.pool.query("delete from reservation_profiles where id = $1 and username = $2", [id, username]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSqlValues(profile: ReservationProfile): unknown[] {
  return [
    profile.id,
    profile.username,
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
    username: row.username,
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
