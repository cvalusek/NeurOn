import { nanoid } from "nanoid";
import pg from "pg";
import type { ReservationRepository } from "../domain/interfaces.js";
import type { Reservation, ReservationStatus } from "../domain/types.js";
import { parseReservationTargetSelections } from "../domain/reservationSelections.js";

interface ReservationRow {
  id: string;
  user_id: string | null;
  username: string;
  api_key_name: string | null;
  profile_id: string | null;
  profile_name: string | null;
  model_ids: string[] | string;
  target_ids: string[] | string;
  target_selections: Array<{ targetId: string; modelIds: string[] }> | string | null;
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

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async create(input: Omit<Reservation, "id"> & { id?: string }): Promise<Reservation> {
    const reservation = { ...input, id: input.id ?? nanoid(12) };
    const values = toSqlValues(reservation);
    await this.pool.query(
      `insert into reservations (
        id, user_id, username, api_key_name, profile_id, profile_name, model_ids, target_ids, target_selections, created_at, expires_at,
        keepalive_minutes, ended_at, status, failure_message, synthetic
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)`,
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
        user_id = $2,
        username = $3,
        api_key_name = $4,
        profile_id = $5,
        profile_name = $6,
        model_ids = $7::jsonb,
        target_ids = $8::jsonb,
        target_selections = $9::jsonb,
        created_at = $10,
        expires_at = $11,
        keepalive_minutes = $12,
        ended_at = $13,
        status = $14,
        failure_message = $15,
        synthetic = $16
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

}

function toSqlValues(reservation: Reservation): unknown[] {
  return [
    reservation.id,
    reservation.userId ?? null,
    reservation.username,
    reservation.apiKeyName ?? null,
    reservation.profileId ?? null,
    reservation.profileName ?? null,
    JSON.stringify(reservation.modelIds),
    JSON.stringify(reservation.targetIds),
    reservation.targetSelections ? JSON.stringify(reservation.targetSelections) : null,
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
  const targetSelections = parseReservationTargetSelections(
    typeof row.target_selections === "string" ? JSON.parse(row.target_selections) : row.target_selections,
    "PostgreSQL reservation target_selections"
  );
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    username: row.username,
    apiKeyName: row.api_key_name ?? undefined,
    profileId: row.profile_id ?? undefined,
    profileName: row.profile_name ?? undefined,
    modelIds,
    targetIds,
    targetSelections,
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
    profileId: reservation.profileId,
    profileName: reservation.profileName,
    modelIds: [...reservation.modelIds],
    targetIds: [...reservation.targetIds],
    targetSelections: reservation.targetSelections?.map((selection) => ({ ...selection, modelIds: [...selection.modelIds] })),
    createdAt: new Date(reservation.createdAt),
    expiresAt: new Date(reservation.expiresAt),
    endedAt: reservation.endedAt ? new Date(reservation.endedAt) : undefined
  };
}
