import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ReservationProfileRepository } from "../domain/interfaces.js";
import type { ReservationProfile, ReservationProfileSelection } from "../domain/types.js";

interface ReservationProfileRow {
  id: string;
  username: string;
  name: string;
  description: string | null;
  selections: string;
  default_duration_minutes: number | null;
  default_keepalive_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export class SqliteReservationProfileRepository implements ReservationProfileRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  async create(input: Omit<ReservationProfile, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<ReservationProfile> {
    const now = new Date();
    const profile = { ...input, id: input.id ?? nanoid(12), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.db.prepare(
      `insert into reservation_profiles (
        id, username, name, description, selections, default_duration_minutes,
        default_keepalive_minutes, created_at, updated_at
      ) values (
        @id, @username, @name, @description, @selections, @defaultDurationMinutes,
        @defaultKeepaliveMinutes, @createdAt, @updatedAt
      )`
    ).run(toSqlParams(profile));
    return cloneProfile(profile);
  }

  async get(id: string): Promise<ReservationProfile | undefined> {
    const row = this.db.prepare("select * from reservation_profiles where id = ?").get(id) as ReservationProfileRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async listForUser(username: string): Promise<ReservationProfile[]> {
    const rows = this.db.prepare("select * from reservation_profiles where username = ? order by name asc, id asc").all(username) as ReservationProfileRow[];
    return rows.map(fromRow);
  }

  async update(id: string, input: ReservationProfile): Promise<ReservationProfile> {
    this.db.prepare(
      `update reservation_profiles set
        username = @username,
        name = @name,
        description = @description,
        selections = @selections,
        default_duration_minutes = @defaultDurationMinutes,
        default_keepalive_minutes = @defaultKeepaliveMinutes,
        created_at = @createdAt,
        updated_at = @updatedAt
      where id = @id`
    ).run(toSqlParams({ ...input, id }));
    return cloneProfile({ ...input, id });
  }

  async deleteForUser(id: string, username: string): Promise<boolean> {
    const result = this.db.prepare("delete from reservation_profiles where id = ? and username = ?").run(id, username);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists reservation_profiles (
        id text primary key,
        username text not null,
        name text not null,
        description text,
        selections text not null,
        default_duration_minutes integer,
        default_keepalive_minutes integer,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_reservation_profiles_username_name
        on reservation_profiles(username, name);
    `);
  }
}

function toSqlParams(profile: ReservationProfile) {
  return {
    id: profile.id,
    username: profile.username,
    name: profile.name,
    description: profile.description ?? null,
    selections: JSON.stringify(profile.selections),
    defaultDurationMinutes: profile.defaultDurationMinutes ?? null,
    defaultKeepaliveMinutes: profile.defaultKeepaliveMinutes ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString()
  };
}

function fromRow(row: ReservationProfileRow): ReservationProfile {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    description: row.description ?? undefined,
    selections: JSON.parse(row.selections) as ReservationProfileSelection[],
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
