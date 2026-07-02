import { nanoid } from "nanoid";
import pg from "pg";
import type { TargetActivationRepository } from "../domain/interfaces.js";
import type { TargetActivation, TargetActivationReservation, TargetActivationStatus } from "../domain/types.js";
import { cloneTargetActivation, cloneTargetActivationReservation } from "./targetActivationUtils.js";

const { Pool } = pg;

interface TargetActivationRow {
  id: string;
  target_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  status: TargetActivationStatus;
  estimated_hourly_cost_usd: number | string | null;
  estimated_cost_usd: number | string;
  last_costed_at: Date | string;
}

interface TargetActivationReservationRow {
  id: string;
  target_activation_id: string;
  reservation_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  estimated_cost_usd: number | string;
}

export class PostgresTargetActivationRepository implements TargetActivationRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists target_activations (
        id text primary key,
        target_id text not null,
        started_at timestamptz not null,
        ended_at timestamptz,
        status text not null check (status in ('open', 'closed')),
        estimated_hourly_cost_usd numeric,
        estimated_cost_usd numeric not null default 0,
        last_costed_at timestamptz not null
      );
      create index if not exists idx_target_activations_target_status
        on target_activations(target_id, status, started_at);

      create table if not exists target_activation_reservations (
        id text primary key,
        target_activation_id text not null references target_activations(id) on delete cascade,
        reservation_id text not null references reservations(id) on delete cascade,
        started_at timestamptz not null,
        ended_at timestamptz,
        estimated_cost_usd numeric not null default 0,
        unique(target_activation_id, reservation_id)
      );
      create index if not exists idx_target_activation_reservations_reservation
        on target_activation_reservations(reservation_id);
      create index if not exists idx_target_activation_reservations_activation
        on target_activation_reservations(target_activation_id);
    `);
  }

  async createActivation(input: Omit<TargetActivation, "id"> & { id?: string }): Promise<TargetActivation> {
    const activation = { ...input, id: input.id ?? nanoid(12) };
    await this.pool.query(
      `insert into target_activations (
        id, target_id, started_at, ended_at, status, estimated_hourly_cost_usd, estimated_cost_usd, last_costed_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      toActivationSqlValues(activation)
    );
    return cloneTargetActivation(activation);
  }

  async getActivation(id: string): Promise<TargetActivation | undefined> {
    const result = await this.pool.query<TargetActivationRow>("select * from target_activations where id = $1", [id]);
    return result.rows[0] ? activationFromRow(result.rows[0]) : undefined;
  }

  async getOpenActivationForTarget(targetId: string): Promise<TargetActivation | undefined> {
    const result = await this.pool.query<TargetActivationRow>("select * from target_activations where target_id = $1 and status = 'open' order by started_at desc, id desc limit 1", [targetId]);
    return result.rows[0] ? activationFromRow(result.rows[0]) : undefined;
  }

  async listActivationsForTarget(targetId: string): Promise<TargetActivation[]> {
    const result = await this.pool.query<TargetActivationRow>("select * from target_activations where target_id = $1 order by started_at asc, id asc", [targetId]);
    return result.rows.map(activationFromRow);
  }

  async updateActivation(id: string, patch: Partial<TargetActivation>): Promise<TargetActivation> {
    const current = await this.getActivation(id);
    if (!current) throw new Error(`Target activation not found: ${id}`);
    const updated = { ...current, ...patch, id };
    await this.pool.query(
      `update target_activations set
        target_id = $2,
        started_at = $3,
        ended_at = $4,
        status = $5,
        estimated_hourly_cost_usd = $6,
        estimated_cost_usd = $7,
        last_costed_at = $8
      where id = $1`,
      toActivationSqlValues(updated)
    );
    return cloneTargetActivation(updated);
  }

  async addReservationCost(input: { targetActivationId: string; reservationId: string; at: Date; estimatedCostUsd: number }): Promise<TargetActivationReservation> {
    const id = nanoid(12);
    const result = await this.pool.query<TargetActivationReservationRow>(
      `insert into target_activation_reservations (
        id, target_activation_id, reservation_id, started_at, estimated_cost_usd
      ) values ($1, $2, $3, $4, $5)
      on conflict (target_activation_id, reservation_id)
      do update set
        ended_at = null,
        estimated_cost_usd = target_activation_reservations.estimated_cost_usd + excluded.estimated_cost_usd
      returning *`,
      [id, input.targetActivationId, input.reservationId, input.at, input.estimatedCostUsd]
    );
    return linkFromRow(result.rows[0]);
  }

  async closeInactiveReservations(targetActivationId: string, activeReservationIds: string[], endedAt: Date): Promise<TargetActivationReservation[]> {
    const result = await this.pool.query<TargetActivationReservationRow>(
      `update target_activation_reservations
       set ended_at = $3
       where target_activation_id = $1 and ended_at is null and not (reservation_id = any($2::text[]))
       returning *`,
      [targetActivationId, activeReservationIds, endedAt]
    );
    return result.rows.map(linkFromRow);
  }

  async closeReservationsForActivation(targetActivationId: string, endedAt: Date): Promise<TargetActivationReservation[]> {
    const result = await this.pool.query<TargetActivationReservationRow>(
      "update target_activation_reservations set ended_at = $2 where target_activation_id = $1 and ended_at is null returning *",
      [targetActivationId, endedAt]
    );
    return result.rows.map(linkFromRow);
  }

  async listActivationReservations(targetActivationId: string): Promise<TargetActivationReservation[]> {
    const result = await this.pool.query<TargetActivationReservationRow>("select * from target_activation_reservations where target_activation_id = $1 order by started_at asc, id asc", [targetActivationId]);
    return result.rows.map(linkFromRow);
  }

  async listReservationAllocations(reservationId: string): Promise<TargetActivationReservation[]> {
    const result = await this.pool.query<TargetActivationReservationRow>("select * from target_activation_reservations where reservation_id = $1 order by started_at asc, id asc", [reservationId]);
    return result.rows.map(linkFromRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toActivationSqlValues(activation: TargetActivation): unknown[] {
  return [
    activation.id,
    activation.targetId,
    activation.startedAt,
    activation.endedAt ?? null,
    activation.status,
    activation.estimatedHourlyCostUsd ?? null,
    activation.estimatedCostUsd,
    activation.lastCostedAt
  ];
}

function activationFromRow(row: TargetActivationRow): TargetActivation {
  return {
    id: row.id,
    targetId: row.target_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    status: row.status,
    estimatedHourlyCostUsd: row.estimated_hourly_cost_usd === null ? undefined : Number(row.estimated_hourly_cost_usd),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    lastCostedAt: new Date(row.last_costed_at)
  };
}

function linkFromRow(row: TargetActivationReservationRow): TargetActivationReservation {
  return cloneTargetActivationReservation({
    id: row.id,
    targetActivationId: row.target_activation_id,
    reservationId: row.reservation_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    estimatedCostUsd: Number(row.estimated_cost_usd)
  });
}
