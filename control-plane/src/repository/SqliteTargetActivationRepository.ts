import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { TargetActivationRepository } from "../domain/interfaces.js";
import type { TargetActivation, TargetActivationReservation, TargetActivationStatus } from "../domain/types.js";
import { cloneTargetActivation, cloneTargetActivationReservation } from "./targetActivationUtils.js";

interface TargetActivationRow {
  id: string;
  target_id: string;
  started_at: string;
  ended_at: string | null;
  status: TargetActivationStatus;
  estimated_hourly_cost_usd: number | null;
  estimated_cost_usd: number;
  last_costed_at: string;
}

interface TargetActivationReservationRow {
  id: string;
  target_activation_id: string;
  reservation_id: string;
  started_at: string;
  ended_at: string | null;
  estimated_cost_usd: number;
}

export class SqliteTargetActivationRepository implements TargetActivationRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async createActivation(input: Omit<TargetActivation, "id"> & { id?: string }): Promise<TargetActivation> {
    const activation = { ...input, id: input.id ?? nanoid(12) };
    this.db
      .prepare(
        `insert into target_activations (
          id, target_id, started_at, ended_at, status, estimated_hourly_cost_usd, estimated_cost_usd, last_costed_at
        ) values (
          @id, @targetId, @startedAt, @endedAt, @status, @estimatedHourlyCostUsd, @estimatedCostUsd, @lastCostedAt
        )`
      )
      .run(toActivationSqlParams(activation));
    return cloneTargetActivation(activation);
  }

  async getActivation(id: string): Promise<TargetActivation | undefined> {
    const row = this.db.prepare("select * from target_activations where id = ?").get(id) as TargetActivationRow | undefined;
    return row ? activationFromRow(row) : undefined;
  }

  async getOpenActivationForTarget(targetId: string): Promise<TargetActivation | undefined> {
    const row = this.db.prepare("select * from target_activations where target_id = ? and status = 'open' order by started_at desc, id desc limit 1").get(targetId) as TargetActivationRow | undefined;
    return row ? activationFromRow(row) : undefined;
  }

  async listActivationsForTarget(targetId: string): Promise<TargetActivation[]> {
    const rows = this.db.prepare("select * from target_activations where target_id = ? order by started_at asc, id asc").all(targetId) as TargetActivationRow[];
    return rows.map(activationFromRow);
  }

  async updateActivation(id: string, patch: Partial<TargetActivation>): Promise<TargetActivation> {
    const current = await this.getActivation(id);
    if (!current) throw new Error(`Target activation not found: ${id}`);
    const updated = { ...current, ...patch, id };
    this.db
      .prepare(
        `update target_activations set
          target_id = @targetId,
          started_at = @startedAt,
          ended_at = @endedAt,
          status = @status,
          estimated_hourly_cost_usd = @estimatedHourlyCostUsd,
          estimated_cost_usd = @estimatedCostUsd,
          last_costed_at = @lastCostedAt
        where id = @id`
      )
      .run(toActivationSqlParams(updated));
    return cloneTargetActivation(updated);
  }

  async addReservationCost(input: { targetActivationId: string; reservationId: string; at: Date; estimatedCostUsd: number }): Promise<TargetActivationReservation> {
    const existing = this.db
      .prepare("select * from target_activation_reservations where target_activation_id = ? and reservation_id = ?")
      .get(input.targetActivationId, input.reservationId) as TargetActivationReservationRow | undefined;
    if (existing) {
      this.db
        .prepare("update target_activation_reservations set ended_at = null, estimated_cost_usd = estimated_cost_usd + ? where id = ?")
        .run(input.estimatedCostUsd, existing.id);
      const updated = this.db.prepare("select * from target_activation_reservations where id = ?").get(existing.id) as TargetActivationReservationRow;
      return linkFromRow(updated);
    }
    const link: TargetActivationReservation = {
      id: nanoid(12),
      targetActivationId: input.targetActivationId,
      reservationId: input.reservationId,
      startedAt: input.at,
      estimatedCostUsd: input.estimatedCostUsd
    };
    this.db
      .prepare(
        `insert into target_activation_reservations (
          id, target_activation_id, reservation_id, started_at, ended_at, estimated_cost_usd
        ) values (
          @id, @targetActivationId, @reservationId, @startedAt, @endedAt, @estimatedCostUsd
        )`
      )
      .run(toLinkSqlParams(link));
    return cloneTargetActivationReservation(link);
  }

  async closeInactiveReservations(targetActivationId: string, activeReservationIds: string[], endedAt: Date): Promise<TargetActivationReservation[]> {
    const rows = this.db.prepare("select * from target_activation_reservations where target_activation_id = ? and ended_at is null").all(targetActivationId) as TargetActivationReservationRow[];
    const active = new Set(activeReservationIds);
    const close = this.db.prepare("update target_activation_reservations set ended_at = ? where id = ?");
    const closed = rows.filter((row) => !active.has(row.reservation_id));
    const transaction = this.db.transaction((links: TargetActivationReservationRow[]) => {
      for (const link of links) close.run(endedAt.toISOString(), link.id);
    });
    transaction(closed);
    return closed.map((row) => linkFromRow({ ...row, ended_at: endedAt.toISOString() }));
  }

  async closeReservationsForActivation(targetActivationId: string, endedAt: Date): Promise<TargetActivationReservation[]> {
    const rows = this.db.prepare("select * from target_activation_reservations where target_activation_id = ? and ended_at is null").all(targetActivationId) as TargetActivationReservationRow[];
    const update = this.db.prepare("update target_activation_reservations set ended_at = ? where id = ?");
    const transaction = this.db.transaction((links: TargetActivationReservationRow[]) => {
      for (const link of links) update.run(endedAt.toISOString(), link.id);
    });
    transaction(rows);
    return rows.map((row) => linkFromRow({ ...row, ended_at: endedAt.toISOString() }));
  }

  async listActivationReservations(targetActivationId: string): Promise<TargetActivationReservation[]> {
    const rows = this.db.prepare("select * from target_activation_reservations where target_activation_id = ? order by started_at asc, id asc").all(targetActivationId) as TargetActivationReservationRow[];
    return rows.map(linkFromRow);
  }

  async listReservationAllocations(reservationId: string): Promise<TargetActivationReservation[]> {
    const rows = this.db.prepare("select * from target_activation_reservations where reservation_id = ? order by started_at asc, id asc").all(reservationId) as TargetActivationReservationRow[];
    return rows.map(linkFromRow);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists target_activations (
        id text primary key,
        target_id text not null,
        started_at text not null,
        ended_at text,
        status text not null check (status in ('open', 'closed')),
        estimated_hourly_cost_usd real,
        estimated_cost_usd real not null default 0,
        last_costed_at text not null
      );
      create index if not exists idx_target_activations_target_status
        on target_activations(target_id, status, started_at);

      create table if not exists target_activation_reservations (
        id text primary key,
        target_activation_id text not null,
        reservation_id text not null,
        started_at text not null,
        ended_at text,
        estimated_cost_usd real not null default 0,
        unique(target_activation_id, reservation_id)
      );
      create index if not exists idx_target_activation_reservations_reservation
        on target_activation_reservations(reservation_id);
      create index if not exists idx_target_activation_reservations_activation
        on target_activation_reservations(target_activation_id);
    `);
  }
}

function toActivationSqlParams(activation: TargetActivation) {
  return {
    id: activation.id,
    targetId: activation.targetId,
    startedAt: activation.startedAt.toISOString(),
    endedAt: activation.endedAt?.toISOString() ?? null,
    status: activation.status,
    estimatedHourlyCostUsd: activation.estimatedHourlyCostUsd ?? null,
    estimatedCostUsd: activation.estimatedCostUsd,
    lastCostedAt: activation.lastCostedAt.toISOString()
  };
}

function toLinkSqlParams(link: TargetActivationReservation) {
  return {
    id: link.id,
    targetActivationId: link.targetActivationId,
    reservationId: link.reservationId,
    startedAt: link.startedAt.toISOString(),
    endedAt: link.endedAt?.toISOString() ?? null,
    estimatedCostUsd: link.estimatedCostUsd
  };
}

function activationFromRow(row: TargetActivationRow): TargetActivation {
  return {
    id: row.id,
    targetId: row.target_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    status: row.status,
    estimatedHourlyCostUsd: row.estimated_hourly_cost_usd ?? undefined,
    estimatedCostUsd: row.estimated_cost_usd,
    lastCostedAt: new Date(row.last_costed_at)
  };
}

function linkFromRow(row: TargetActivationReservationRow): TargetActivationReservation {
  return {
    id: row.id,
    targetActivationId: row.target_activation_id,
    reservationId: row.reservation_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    estimatedCostUsd: row.estimated_cost_usd
  };
}
