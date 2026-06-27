import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ReservationRepository } from "../domain/interfaces.js";
import type { Reservation, ReservationStatus } from "../domain/types.js";

interface ReservationRow {
  id: string;
  username: string;
  model_ids: string;
  target_ids: string;
  created_at: string;
  expires_at: string;
  keepalive_minutes: number | null;
  ended_at: string | null;
  status: ReservationStatus;
  failure_message: string | null;
  synthetic: number;
}

export class SqliteReservationRepository implements ReservationRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  async create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation> {
    const reservation = { ...input, id: input.id ?? nanoid(12) };
    this.db
      .prepare(
        `insert into reservations (
          id, username, model_ids, target_ids, created_at, expires_at,
          keepalive_minutes, ended_at, status, failure_message, synthetic
        ) values (
          @id, @username, @modelIds, @targetIds, @createdAt, @expiresAt,
          @keepaliveMinutes, @endedAt, @status, @failureMessage, @synthetic
        )`
      )
      .run(toSqlParams(reservation));
    return cloneReservation(reservation);
  }

  async get(id: string): Promise<Reservation | undefined> {
    const row = this.db.prepare("select * from reservations where id = ?").get(id) as ReservationRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(): Promise<Reservation[]> {
    const rows = this.db.prepare("select * from reservations order by created_at asc, id asc").all() as ReservationRow[];
    return rows.map(fromRow);
  }

  async update(id: string, patch: Partial<Reservation>): Promise<Reservation> {
    const current = await this.get(id);
    if (!current) throw new Error(`Reservation not found: ${id}`);
    const updated = { ...current, ...patch, id };
    this.db
      .prepare(
        `update reservations set
          username = @username,
          model_ids = @modelIds,
          target_ids = @targetIds,
          created_at = @createdAt,
          expires_at = @expiresAt,
          keepalive_minutes = @keepaliveMinutes,
          ended_at = @endedAt,
          status = @status,
          failure_message = @failureMessage,
          synthetic = @synthetic
        where id = @id`
      )
      .run(toSqlParams(updated));
    return cloneReservation(updated);
  }

  async expireReservations(now: Date): Promise<Reservation[]> {
    const rows = this.db
      .prepare("select * from reservations where status = 'active' and expires_at <= ? order by created_at asc, id asc")
      .all(now.toISOString()) as ReservationRow[];
    const expired = rows.map((row) => ({ ...fromRow(row), status: "expired" as const, endedAt: now }));
    const update = this.db.prepare("update reservations set status = 'expired', ended_at = ? where id = ?");
    const transaction = this.db.transaction((reservations: Reservation[]) => {
      for (const reservation of reservations) update.run(now.toISOString(), reservation.id);
    });
    transaction(expired);
    return expired.map(cloneReservation);
  }

  async listActive(now: Date): Promise<Reservation[]> {
    const rows = this.db
      .prepare("select * from reservations where status = 'active' and expires_at > ? order by created_at asc, id asc")
      .all(now.toISOString()) as ReservationRow[];
    return rows.map(fromRow);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists reservations (
        id text primary key,
        username text not null,
        model_ids text not null,
        target_ids text not null,
        created_at text not null,
        expires_at text not null,
        keepalive_minutes integer,
        ended_at text,
        status text not null check (status in ('active', 'done', 'expired', 'failed')),
        failure_message text,
        synthetic integer not null default 0
      );

      create index if not exists idx_reservations_status_expires_at
        on reservations(status, expires_at);
    `);
  }
}

function toSqlParams(reservation: Reservation) {
  return {
    id: reservation.id,
    username: reservation.username,
    modelIds: JSON.stringify(reservation.modelIds),
    targetIds: JSON.stringify(reservation.targetIds),
    createdAt: reservation.createdAt.toISOString(),
    expiresAt: reservation.expiresAt.toISOString(),
    keepaliveMinutes: reservation.keepaliveMinutes ?? null,
    endedAt: reservation.endedAt?.toISOString() ?? null,
    status: reservation.status,
    failureMessage: reservation.failureMessage ?? null,
    synthetic: reservation.synthetic ? 1 : 0
  };
}

function fromRow(row: ReservationRow): Reservation {
  return {
    id: row.id,
    username: row.username,
    modelIds: JSON.parse(row.model_ids) as string[],
    targetIds: JSON.parse(row.target_ids) as string[],
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    keepaliveMinutes: row.keepalive_minutes ?? undefined,
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    status: row.status,
    failureMessage: row.failure_message ?? undefined,
    synthetic: row.synthetic === 1 ? true : undefined
  };
}

function cloneReservation(reservation: Reservation): Reservation {
  return {
    ...reservation,
    modelIds: [...reservation.modelIds],
    targetIds: [...reservation.targetIds],
    createdAt: new Date(reservation.createdAt),
    expiresAt: new Date(reservation.expiresAt),
    endedAt: reservation.endedAt ? new Date(reservation.endedAt) : undefined
  };
}
