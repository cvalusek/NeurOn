import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ActionRequestRecord, AuditEvent, DestructiveActionTrigger, LeaseState, RegisteredTarget, TripTestResult } from "./types.js";

interface RegistrationRow {
  target_id: string;
  registration_id: string;
  registration_json: string;
}

interface StateRow {
  target_id: string;
  controller_id?: string;
  lease_id?: string;
  sequence?: number;
  issued_at?: string;
  accepted_until?: string;
  armed_at?: string;
  maintenance_hold_until?: string;
  maintenance_reason?: string;
  last_action_at?: string;
  last_action_trigger?: DestructiveActionTrigger;
  last_action_outcome?: "succeeded" | "failed";
  last_action_message?: string;
  last_completed_lease_id?: string;
  last_action_attempt_at?: string;
}

interface AuditRow {
  id: number;
  target_id: string;
  event_type: string;
  outcome: AuditEvent["outcome"];
  created_at: string;
  request_id?: string;
  details_json?: string;
}

interface ActionRequestRow {
  target_id: string;
  request_id: string;
  trigger: DestructiveActionTrigger;
  status: ActionRequestRecord["status"];
  message?: string;
  updated_at: string;
}

interface TripTestRow {
  target_id: string;
  last_succeeded_at: string;
  audit_event_id: number;
}

export class HassleOffStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  syncRegistrations(configuredTargets: RegisteredTarget[], now: Date): { targets: RegisteredTarget[]; issues: string[] } {
    const configuredById = new Map(configuredTargets.map((target) => [target.targetId, normalizeRegistration(target)]));
    const persistedById = new Map(this.listRegistrations().map((target) => [target.targetId, target]));
    const issues: string[] = [];
    const insert = this.db.prepare(
      "insert into hassleoff_registrations (target_id, registration_id, registration_json, registered_at) values (?, ?, ?, ?)"
    );
    const transaction = this.db.transaction(() => {
      for (const target of configuredById.values()) {
        const persisted = persistedById.get(target.targetId);
        if (!persisted) {
          insert.run(target.targetId, target.registrationId, JSON.stringify(target), now.toISOString());
          this.ensureState(target.targetId);
          this.appendAudit(target.targetId, "registration_added", "accepted", now, undefined, {
            registrationId: target.registrationId,
            actionType: target.action.type,
            testOnly: target.testOnly ?? false
          });
          persistedById.set(target.targetId, target);
          continue;
        }
        if (JSON.stringify(normalizeRegistration(persisted)) !== JSON.stringify(target)) {
          issues.push(`Registration mismatch for ${target.targetId}; the durable registration remains authoritative`);
        }
      }
      for (const target of persistedById.values()) {
        if (!configuredById.has(target.targetId)) {
          issues.push(`Durable registration ${target.targetId} is missing from the configured target registrations`);
        }
      }
    });
    transaction();
    return { targets: Array.from(persistedById.values()).sort((left, right) => left.targetId.localeCompare(right.targetId)), issues };
  }

  listRegistrations(): RegisteredTarget[] {
    const rows = this.db.prepare("select * from hassleoff_registrations order by target_id asc").all() as RegistrationRow[];
    return rows.map((row) => JSON.parse(row.registration_json) as RegisteredTarget);
  }

  getRegistration(targetId: string): RegisteredTarget | undefined {
    const row = this.db.prepare("select * from hassleoff_registrations where target_id = ?").get(targetId) as RegistrationRow | undefined;
    return row ? JSON.parse(row.registration_json) as RegisteredTarget : undefined;
  }

  getState(targetId: string): LeaseState {
    this.ensureState(targetId);
    const row = this.db.prepare("select * from hassleoff_target_state where target_id = ?").get(targetId) as StateRow;
    return stateFromRow(row);
  }

  saveLease(input: {
    targetId: string;
    controllerId: string;
    leaseId: string;
    sequence: number;
    issuedAt: Date;
    acceptedUntil: Date;
    armedAt: Date;
  }): void {
    this.ensureState(input.targetId);
    this.db.prepare(`
      update hassleoff_target_state
      set controller_id = ?, lease_id = ?, sequence = ?, issued_at = ?, accepted_until = ?, armed_at = ?
      where target_id = ?
    `).run(
      input.controllerId,
      input.leaseId,
      input.sequence,
      input.issuedAt.toISOString(),
      input.acceptedUntil.toISOString(),
      input.armedAt.toISOString(),
      input.targetId
    );
  }

  setMaintenanceHold(targetId: string, until: Date, reason: string): void {
    this.ensureState(targetId);
    this.db.prepare("update hassleoff_target_state set maintenance_hold_until = ?, maintenance_reason = ? where target_id = ?")
      .run(until.toISOString(), reason, targetId);
  }

  clearMaintenanceHold(targetId: string): void {
    this.ensureState(targetId);
    this.db.prepare("update hassleoff_target_state set maintenance_hold_until = null, maintenance_reason = null where target_id = ?").run(targetId);
  }

  recordAction(input: {
    targetId: string;
    at: Date;
    trigger: DestructiveActionTrigger;
    outcome: "succeeded" | "failed";
    message: string;
    completedLeaseId?: string;
  }): void {
    this.ensureState(input.targetId);
    this.db.prepare(`
      update hassleoff_target_state
      set last_action_at = ?, last_action_trigger = ?, last_action_outcome = ?, last_action_message = ?,
          last_completed_lease_id = coalesce(?, last_completed_lease_id), last_action_attempt_at = ?
      where target_id = ?
    `).run(
      input.at.toISOString(),
      input.trigger,
      input.outcome,
      input.message,
      input.completedLeaseId,
      input.at.toISOString(),
      input.targetId
    );
  }

  recordActionAttempt(targetId: string, at: Date): void {
    this.ensureState(targetId);
    this.db.prepare("update hassleoff_target_state set last_action_attempt_at = ? where target_id = ?").run(at.toISOString(), targetId);
  }

  getActionRequest(targetId: string, requestId: string): ActionRequestRecord | undefined {
    const row = this.db.prepare("select * from hassleoff_action_requests where target_id = ? and request_id = ?")
      .get(targetId, requestId) as ActionRequestRow | undefined;
    return row ? actionRequestFromRow(row) : undefined;
  }

  saveActionRequest(record: ActionRequestRecord): void {
    this.db.prepare(`
      insert into hassleoff_action_requests (target_id, request_id, trigger, status, message, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(target_id, request_id) do update set
        trigger = excluded.trigger, status = excluded.status, message = excluded.message, updated_at = excluded.updated_at
    `).run(record.targetId, record.requestId, record.trigger, record.status, record.message, record.updatedAt.toISOString());
  }

  appendAudit(
    targetId: string,
    eventType: string,
    outcome: AuditEvent["outcome"],
    createdAt: Date,
    requestId?: string,
    details?: Record<string, unknown>
  ): number {
    const result = this.db.prepare(`
      insert into hassleoff_audit (target_id, event_type, outcome, created_at, request_id, details_json)
      values (?, ?, ?, ?, ?, ?)
    `).run(targetId, eventType, outcome, createdAt.toISOString(), requestId, details ? JSON.stringify(details) : undefined);
    return Number(result.lastInsertRowid);
  }

  listAudit(options: { targetId?: string; limit?: number } = {}): AuditEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = options.targetId
      ? this.db.prepare("select * from hassleoff_audit where target_id = ? order by id desc limit ?").all(options.targetId, limit) as AuditRow[]
      : this.db.prepare("select * from hassleoff_audit order by id desc limit ?").all(limit) as AuditRow[];
    return rows.map(auditFromRow);
  }

  recordTripTest(result: TripTestResult): void {
    this.db.prepare(`
      insert into hassleoff_trip_tests (target_id, last_succeeded_at, audit_event_id)
      values (?, ?, ?)
      on conflict(target_id) do update set
        last_succeeded_at = excluded.last_succeeded_at, audit_event_id = excluded.audit_event_id
    `).run(result.targetId, result.lastSucceededAt.toISOString(), result.auditEventId);
  }

  listTripTests(): TripTestResult[] {
    const rows = this.db.prepare("select * from hassleoff_trip_tests order by target_id asc").all() as TripTestRow[];
    return rows.map((row) => ({
      targetId: row.target_id,
      lastSucceededAt: new Date(row.last_succeeded_at),
      auditEventId: row.audit_event_id
    }));
  }

  close(): void {
    this.db.close();
  }

  private ensureState(targetId: string): void {
    this.db.prepare("insert or ignore into hassleoff_target_state (target_id) values (?)").run(targetId);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists hassleoff_registrations (
        target_id text primary key,
        registration_id text not null,
        registration_json text not null,
        registered_at text not null
      );

      create table if not exists hassleoff_target_state (
        target_id text primary key references hassleoff_registrations(target_id),
        controller_id text,
        lease_id text,
        sequence integer,
        issued_at text,
        accepted_until text,
        armed_at text,
        maintenance_hold_until text,
        maintenance_reason text,
        last_action_at text,
        last_action_trigger text,
        last_action_outcome text,
        last_action_message text,
        last_completed_lease_id text,
        last_action_attempt_at text
      );

      create table if not exists hassleoff_audit (
        id integer primary key autoincrement,
        target_id text not null,
        event_type text not null,
        outcome text not null,
        created_at text not null,
        request_id text,
        details_json text
      );
      create index if not exists idx_hassleoff_audit_target on hassleoff_audit(target_id, id desc);

      create table if not exists hassleoff_action_requests (
        target_id text not null,
        request_id text not null,
        trigger text not null,
        status text not null,
        message text,
        updated_at text not null,
        primary key (target_id, request_id)
      );

      create table if not exists hassleoff_trip_tests (
        target_id text primary key,
        last_succeeded_at text not null,
        audit_event_id integer not null
      );
    `);
  }
}

function normalizeRegistration(target: RegisteredTarget): RegisteredTarget {
  const action = target.action.type === "fake"
    ? { type: "fake" as const }
    : {
        type: "runpod-stop" as const,
        podId: target.action.podId,
        apiBaseUrl: target.action.apiBaseUrl,
        apiKeyEnv: target.action.apiKeyEnv
      };
  return {
    targetId: target.targetId,
    registrationId: target.registrationId,
    displayName: target.displayName,
    testOnly: target.testOnly ?? false,
    action
  };
}

function stateFromRow(row: StateRow): LeaseState {
  return {
    targetId: row.target_id,
    controllerId: row.controller_id,
    leaseId: row.lease_id,
    sequence: row.sequence,
    issuedAt: dateOrUndefined(row.issued_at),
    acceptedUntil: dateOrUndefined(row.accepted_until),
    armedAt: dateOrUndefined(row.armed_at),
    maintenanceHoldUntil: dateOrUndefined(row.maintenance_hold_until),
    maintenanceReason: row.maintenance_reason,
    lastActionAt: dateOrUndefined(row.last_action_at),
    lastActionTrigger: row.last_action_trigger,
    lastActionOutcome: row.last_action_outcome,
    lastActionMessage: row.last_action_message,
    lastCompletedLeaseId: row.last_completed_lease_id,
    lastActionAttemptAt: dateOrUndefined(row.last_action_attempt_at)
  };
}

function auditFromRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    targetId: row.target_id,
    eventType: row.event_type,
    outcome: row.outcome,
    createdAt: new Date(row.created_at),
    requestId: row.request_id,
    details: row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : undefined
  };
}

function actionRequestFromRow(row: ActionRequestRow): ActionRequestRecord {
  return {
    targetId: row.target_id,
    requestId: row.request_id,
    trigger: row.trigger,
    status: row.status,
    message: row.message,
    updatedAt: new Date(row.updated_at)
  };
}

function dateOrUndefined(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}
