import { nanoid } from "nanoid";
import pg from "pg";
import type { ReservationRepository } from "../domain/interfaces.js";
import type { Reservation, ReservationStatus } from "../domain/types.js";

const { Pool } = pg;

interface ReservationRow {
  id: string;
  username: string;
  api_key_name: string | null;
  model_ids: string[] | string;
  target_ids: string[] | string;
  created_at: Date | string;
  expires_at: Date | string;
  keepalive_minutes: number | null;
  ended_at: Date | string | null;
  status: ReservationStatus;
  failure_message: string | null;
  synthetic: boolean;
}

export class PostgresReservationRepository implements ReservationRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists reservations (
        id text primary key,
        username text not null,
        api_key_name text,
        model_ids jsonb not null,
        target_ids jsonb not null,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        keepalive_minutes integer,
        ended_at timestamptz,
        status text not null check (status in ('active', 'done', 'expired', 'failed')),
        failure_message text,
        synthetic boolean not null default false
      );

      create index if not exists idx_reservations_status_expires_at
        on reservations(status, expires_at);
    `);
    await this.pool.query("alter table reservations add column if not exists api_key_name text");
  }

  async create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation> {
    const reservation = { ...input, id: input.id ?? nanoid(12) };
    const values = toSqlValues(reservation);
    await this.pool.query(
      `insert into reservations (
        id, username, api_key_name, model_ids, target_ids, created_at, expires_at,
        keepalive_minutes, ended_at, status, failure_message, synthetic
      ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      values
    );
    return cloneReservation(reservation);
  }

  async get(id: string): Promise<Reservation | undefined> {
    const result = await this.pool.query<ReservationRow>("select * from reservations where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<Reservation[]> {
    const result = await this.pool.query<ReservationRow>("select * from reservations order by created_at asc, id asc");
    return result.rows.map(fromRow);
  }

  async update(id: string, patch: Partial<Reservation>): Promise<Reservation> {
    const current = await this.get(id);
    if (!current) throw new Error(`Reservation not found: ${id}`);
    const updated = { ...current, ...patch, id };
    await this.pool.query(
      `update reservations set
        username = $2,
        api_key_name = $3,
        model_ids = $4::jsonb,
        target_ids = $5::jsonb,
        created_at = $6,
        expires_at = $7,
        keepalive_minutes = $8,
        ended_at = $9,
        status = $10,
        failure_message = $11,
        synthetic = $12
      where id = $1`,
      toSqlValues(updated)
    );
    return cloneReservation(updated);
  }

  async expireReservations(now: Date): Promise<Reservation[]> {
    const result = await this.pool.query<ReservationRow>(
      `update reservations
       set status = 'expired', ended_at = $1
       where status = 'active' and expires_at <= $1
       returning *`,
      [now]
    );
    return result.rows.map(fromRow);
  }

  async listActive(now: Date): Promise<Reservation[]> {
    const result = await this.pool.query<ReservationRow>(
      "select * from reservations where status = 'active' and expires_at > $1 order by created_at asc, id asc",
      [now]
    );
    return result.rows.map(fromRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSqlValues(reservation: Reservation): unknown[] {
  return [
    reservation.id,
    reservation.username,
    reservation.apiKeyName ?? null,
    JSON.stringify(reservation.modelIds),
    JSON.stringify(reservation.targetIds),
    reservation.createdAt,
    reservation.expiresAt,
    reservation.keepaliveMinutes ?? null,
    reservation.endedAt ?? null,
    reservation.status,
    reservation.failureMessage ?? null,
    reservation.synthetic ?? false
  ];
}

function fromRow(row: ReservationRow): Reservation {
  const modelIds = typeof row.model_ids === "string" ? (JSON.parse(row.model_ids) as string[]) : row.model_ids;
  const targetIds = typeof row.target_ids === "string" ? (JSON.parse(row.target_ids) as string[]) : row.target_ids;
  return {
    id: row.id,
    username: row.username,
    apiKeyName: row.api_key_name ?? undefined,
    modelIds,
    targetIds,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    keepaliveMinutes: row.keepalive_minutes ?? undefined,
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    status: row.status,
    failureMessage: row.failure_message ?? undefined,
    synthetic: row.synthetic ? true : undefined
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
