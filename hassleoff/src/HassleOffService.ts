import { randomUUID } from "node:crypto";
import type {
  ControllerLeaseInput,
  DestructiveActionTrigger,
  HassleOffConfig,
  RegisteredTarget,
  StopActionExecutor
} from "./types.js";
import { HASSLEOFF_PROTOCOL_VERSION } from "./types.js";
import { HassleOffStore } from "./store.js";

export class HassleOffRequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "HassleOffRequestError";
  }
}

export class HassleOffService {
  private readonly targets: Map<string, RegisteredTarget>;
  private readonly registrationIssues: string[];
  private readonly inFlightTargets = new Set<string>();
  private ticking = false;

  constructor(
    private readonly config: HassleOffConfig,
    readonly store: HassleOffStore,
    private readonly actionExecutor: StopActionExecutor,
    private readonly clock: () => Date = () => new Date()
  ) {
    const registrations = store.syncRegistrations(config.targets, this.clock());
    this.targets = new Map(registrations.targets.map((target) => [target.targetId, target]));
    this.registrationIssues = registrations.issues;
  }

  get armed(): boolean {
    return this.registrationIssues.length === 0 && this.targets.size > 0;
  }

  get ready(): boolean {
    return this.armed;
  }

  acceptLease(targetId: string, input: ControllerLeaseInput, now = this.clock()): {
    protocolVersion: typeof HASSLEOFF_PROTOCOL_VERSION;
    accepted: true;
    armed: true;
    targetArmed: true;
    targetId: string;
    leaseId: string;
    sequence: number;
    serverTime: string;
    acceptedUntil: string;
  } {
    const target = this.requireTarget(targetId);
    if (!this.armed) this.rejectLease(targetId, "HassleOff is not armed; resolve registration readiness issues", now, 503);
    if (input.protocolVersion !== HASSLEOFF_PROTOCOL_VERSION) this.rejectLease(targetId, "Unsupported protocolVersion", now);
    if (input.targetId !== targetId) this.rejectLease(targetId, "Path targetId and lease targetId must match exactly", now);
    if (!input.controllerId.trim() || !input.leaseId.trim()) this.rejectLease(targetId, "controllerId and leaseId are required", now);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) this.rejectLease(targetId, "sequence must be a positive safe integer", now);

    const issuedAt = parseDate(input.issuedAt, "issuedAt");
    const expiresAt = parseDate(input.expiresAt, "expiresAt");
    const skewMs = Math.abs(now.getTime() - issuedAt.getTime());
    if (skewMs > this.config.maxClockSkewMs) {
      this.rejectLease(targetId, `Controller clock differs from HassleOff by more than ${this.config.maxClockSkewMs}ms`, now);
    }
    const requestedDurationMs = expiresAt.getTime() - issuedAt.getTime();
    if (requestedDurationMs < this.config.minLeaseMs || requestedDurationMs > this.config.maxLeaseMs) {
      this.rejectLease(targetId, `Lease duration must be between ${this.config.minLeaseMs}ms and ${this.config.maxLeaseMs}ms`, now);
    }
    const acceptedUntil = new Date(Math.min(expiresAt.getTime(), now.getTime() + requestedDurationMs));
    if (acceptedUntil.getTime() <= now.getTime()) this.rejectLease(targetId, "Lease is already expired on the HassleOff clock", now);

    const state = this.store.getState(targetId);
    if (state.acceptedUntil && state.acceptedUntil.getTime() > now.getTime() && state.controllerId !== input.controllerId) {
      this.rejectLease(targetId, `Target already has an unexpired lease from controller ${state.controllerId}`, now, 409);
    }
    if (state.leaseId && state.leaseId !== input.leaseId && state.controllerId === input.controllerId && (state.sequence ?? 0) >= input.sequence) {
      this.rejectLease(targetId, "Replacement lease sequence is stale", now, 409);
    }
    if (state.leaseId === input.leaseId && state.controllerId === input.controllerId) {
      if ((state.sequence ?? 0) > input.sequence) this.rejectLease(targetId, "Lease sequence is stale", now, 409);
      if ((state.sequence ?? 0) === input.sequence) {
        if (state.issuedAt?.getTime() === issuedAt.getTime() && state.acceptedUntil?.getTime() === acceptedUntil.getTime()) {
          return leaseResponse(targetId, input.leaseId, input.sequence, now, acceptedUntil);
        }
        this.rejectLease(targetId, "Lease sequence was reused with different timestamps", now, 409);
      }
    }

    const armedAt = state.armedAt ?? now;
    const replacedLease = Boolean(state.leaseId && state.leaseId !== input.leaseId);
    this.store.saveLease({
      targetId,
      controllerId: input.controllerId,
      leaseId: input.leaseId,
      sequence: input.sequence,
      issuedAt,
      acceptedUntil,
      armedAt
    });
    this.store.appendAudit(target.targetId, replacedLease ? "lease_replaced" : "lease_accepted", "accepted", now, input.leaseId, {
      controllerId: input.controllerId,
      sequence: input.sequence,
      acceptedUntil: acceptedUntil.toISOString()
    });
    return leaseResponse(targetId, input.leaseId, input.sequence, now, acceptedUntil);
  }

  setMaintenanceHold(targetId: string, input: { targetId: string; until: string; reason: string }, now = this.clock()): {
    targetId: string;
    maintenanceHoldUntil: string;
  } {
    this.requireExactTarget(targetId, input.targetId);
    const until = parseDate(input.until, "until");
    if (!input.reason.trim()) throw new HassleOffRequestError("Maintenance hold reason is required");
    if (input.reason.length > 200) throw new HassleOffRequestError("Maintenance hold reason must be 200 characters or fewer");
    const durationMs = until.getTime() - now.getTime();
    if (durationMs <= 0 || durationMs > this.config.maxMaintenanceHoldMs) {
      throw new HassleOffRequestError(`Maintenance hold must end within ${this.config.maxMaintenanceHoldMs}ms`);
    }
    this.store.setMaintenanceHold(targetId, until, input.reason.trim());
    this.store.appendAudit(targetId, "maintenance_hold_set", "accepted", now, undefined, {
      until: until.toISOString(),
      reason: input.reason.trim()
    });
    return { targetId, maintenanceHoldUntil: until.toISOString() };
  }

  async requestIntentionalShutdown(targetId: string, input: {
    protocolVersion: string;
    targetId: string;
    controllerId: string;
    requestId: string;
    reason: string;
  }, now = this.clock()): Promise<{ targetId: string; requestId: string; stopped: true; replayed: boolean; message: string }> {
    this.requireExactTarget(targetId, input.targetId);
    if (input.protocolVersion !== HASSLEOFF_PROTOCOL_VERSION) throw new HassleOffRequestError("Unsupported protocolVersion");
    if (!input.controllerId.trim() || !input.requestId.trim() || !input.reason.trim()) {
      throw new HassleOffRequestError("controllerId, requestId, and reason are required");
    }
    const result = await this.executeAction(targetId, input.requestId, "intentional-shutdown", now, {
      controllerId: input.controllerId,
      reason: input.reason.slice(0, 200)
    });
    return { targetId, requestId: input.requestId, stopped: true, replayed: result.replayed, message: result.message };
  }

  async runSyntheticTripTest(targetId: string, input: { protocolVersion: string; targetId: string }, now = this.clock()): Promise<{
    targetId: string;
    succeeded: true;
    lastFullTripTestSucceededAt: string;
    auditEventId: number;
  }> {
    const target = this.requireExactTarget(targetId, input.targetId);
    if (input.protocolVersion !== HASSLEOFF_PROTOCOL_VERSION) throw new HassleOffRequestError("Unsupported protocolVersion");
    if (!target.testOnly || target.action.type !== "fake") {
      throw new HassleOffRequestError("Trip tests are restricted to registered testOnly fake targets", 403);
    }
    const state = this.store.getState(targetId);
    if (state.maintenanceHoldUntil && state.maintenanceHoldUntil.getTime() > now.getTime()) {
      throw new HassleOffRequestError("Trip test target has an active maintenance hold", 409);
    }
    const issuedAt = new Date(now.getTime() - this.config.minLeaseMs);
    const leaseId = `failsafe-test-${randomUUID()}`;
    this.acceptLease(targetId, {
      protocolVersion: HASSLEOFF_PROTOCOL_VERSION,
      targetId,
      controllerId: "hassleoff-synthetic-test",
      leaseId,
      sequence: (state.sequence ?? 0) + 1,
      issuedAt: issuedAt.toISOString(),
      expiresAt: now.toISOString()
    }, issuedAt);
    await this.tick(now);
    const request = this.store.getActionRequest(targetId, `lease-expired:${leaseId}`);
    if (request?.status !== "succeeded") {
      throw new HassleOffRequestError(`Synthetic trip path failed: ${request?.message ?? "no completed action"}`, 500);
    }
    const auditEventId = this.store.appendAudit(targetId, "trip_test_succeeded", "succeeded", now, leaseId, {
      leaseId,
      actionType: target.action.type
    });
    this.store.recordTripTest({ targetId, lastSucceededAt: now, auditEventId });
    return { targetId, succeeded: true, lastFullTripTestSucceededAt: now.toISOString(), auditEventId };
  }

  async tick(now = this.clock()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const target of this.targets.values()) {
        const state = this.store.getState(target.targetId);
        if (!state.armedAt || !state.leaseId || !state.acceptedUntil) continue;
        if (state.maintenanceHoldUntil) {
          if (state.maintenanceHoldUntil.getTime() > now.getTime()) continue;
          this.store.clearMaintenanceHold(target.targetId);
          this.store.appendAudit(target.targetId, "maintenance_hold_expired", "decision", now, undefined, {
            expiredAt: state.maintenanceHoldUntil.toISOString()
          });
        }
        if (state.acceptedUntil.getTime() > now.getTime()) continue;
        if (state.lastCompletedLeaseId === state.leaseId) continue;
        if (state.lastActionOutcome === "failed" && state.lastActionAttemptAt &&
          now.getTime() - state.lastActionAttemptAt.getTime() < this.config.failedActionRetryMs) continue;
        const requestId = `lease-expired:${state.leaseId}`;
        this.store.appendAudit(target.targetId, "lease_expiry_trip_decided", "decision", now, requestId, {
          leaseId: state.leaseId,
          acceptedUntil: state.acceptedUntil.toISOString()
        });
        try {
          await this.executeAction(target.targetId, requestId, target.testOnly ? "synthetic-trip-test" : "lease-expired", now, {
            leaseId: state.leaseId,
            acceptedUntil: state.acceptedUntil.toISOString()
          }, state.leaseId);
        } catch {
          // The durable failure and retry timestamp are recorded by executeAction.
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  status(now = this.clock()) {
    const tripTests = this.store.listTripTests();
    const lastFullTripTestSucceededAt = tripTests
      .map((result) => result.lastSucceededAt)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    return {
      protocolVersion: HASSLEOFF_PROTOCOL_VERSION,
      service: {
        healthy: true,
        ready: this.ready,
        armed: this.armed,
        registrationIssues: [...this.registrationIssues]
      },
      lastFullTripTestSucceededAt: lastFullTripTestSucceededAt?.toISOString(),
      tripTests: tripTests.map((result) => ({
        targetId: result.targetId,
        lastSucceededAt: result.lastSucceededAt.toISOString(),
        auditEventId: result.auditEventId
      })),
      targets: Array.from(this.targets.values()).map((target) => {
        const state = this.store.getState(target.targetId);
        return {
          targetId: target.targetId,
          registrationId: target.registrationId,
          displayName: target.displayName,
          actionType: target.action.type,
          testOnly: target.testOnly ?? false,
          armed: Boolean(state.armedAt),
          lease: state.leaseId ? {
            controllerId: state.controllerId,
            leaseId: state.leaseId,
            sequence: state.sequence,
            issuedAt: state.issuedAt?.toISOString(),
            acceptedUntil: state.acceptedUntil?.toISOString(),
            expired: Boolean(state.acceptedUntil && state.acceptedUntil.getTime() <= now.getTime())
          } : undefined,
          maintenanceHold: state.maintenanceHoldUntil ? {
            until: state.maintenanceHoldUntil.toISOString(),
            reason: state.maintenanceReason,
            active: state.maintenanceHoldUntil.getTime() > now.getTime()
          } : undefined,
          lastTripResult: state.lastActionAt ? {
            at: state.lastActionAt.toISOString(),
            trigger: state.lastActionTrigger,
            outcome: state.lastActionOutcome,
            message: state.lastActionMessage
          } : undefined,
          recentDestructiveAudit: this.store.listAudit({ targetId: target.targetId, limit: 10 }).map(auditJson)
        };
      })
    };
  }

  audit(targetId?: string, limit?: number) {
    if (targetId) this.requireTarget(targetId);
    return this.store.listAudit({ targetId, limit }).map(auditJson);
  }

  private async executeAction(
    targetId: string,
    requestId: string,
    trigger: DestructiveActionTrigger,
    now: Date,
    details: Record<string, unknown>,
    completedLeaseId?: string
  ): Promise<{ message: string; replayed: boolean; auditEventId: number }> {
    const existing = this.store.getActionRequest(targetId, requestId);
    if (existing?.status === "succeeded") {
      return { message: existing.message ?? "Stop already completed", replayed: true, auditEventId: 0 };
    }
    if (this.inFlightTargets.has(targetId)) throw new HassleOffRequestError(`A destructive action is already running for ${targetId}`, 409);
    const target = this.requireTarget(targetId);
    this.inFlightTargets.add(targetId);
    this.store.recordActionAttempt(targetId, now);
    this.store.saveActionRequest({ targetId, requestId, trigger, status: "running", updatedAt: now });
    this.store.appendAudit(targetId, "provider_stop_started", "decision", now, requestId, { trigger, ...details });
    try {
      const result = await this.actionExecutor.stop(target, { targetId, requestId, trigger });
      const completedAt = this.clock();
      this.store.saveActionRequest({ targetId, requestId, trigger, status: "succeeded", message: result.message, updatedAt: completedAt });
      this.store.recordAction({ targetId, at: completedAt, trigger, outcome: "succeeded", message: result.message, completedLeaseId });
      const auditEventId = this.store.appendAudit(targetId, "provider_stop_succeeded", "succeeded", completedAt, requestId, {
        trigger,
        message: result.message
      });
      return { message: result.message, replayed: false, auditEventId };
    } catch (error) {
      const failedAt = this.clock();
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveActionRequest({ targetId, requestId, trigger, status: "failed", message, updatedAt: failedAt });
      this.store.recordAction({ targetId, at: failedAt, trigger, outcome: "failed", message });
      this.store.appendAudit(targetId, "provider_stop_failed", "failed", failedAt, requestId, { trigger, message });
      throw new HassleOffRequestError(`Provider stop failed for ${targetId}: ${message}`, 502);
    } finally {
      this.inFlightTargets.delete(targetId);
    }
  }

  private requireExactTarget(pathTargetId: string, bodyTargetId: string): RegisteredTarget {
    if (pathTargetId !== bodyTargetId) throw new HassleOffRequestError("Path targetId and body targetId must match exactly");
    return this.requireTarget(pathTargetId);
  }

  private requireTarget(targetId: string): RegisteredTarget {
    const target = this.targets.get(targetId);
    if (!target) throw new HassleOffRequestError(`Target is not registered with HassleOff: ${targetId}`, 404);
    return target;
  }

  private rejectLease(targetId: string, message: string, now: Date, statusCode = 400): never {
    this.store.appendAudit(targetId, "lease_rejected", "rejected", now, undefined, { reason: message });
    throw new HassleOffRequestError(message, statusCode);
  }
}

function leaseResponse(targetId: string, leaseId: string, sequence: number, now: Date, acceptedUntil: Date) {
  return {
    protocolVersion: HASSLEOFF_PROTOCOL_VERSION,
    accepted: true as const,
    armed: true as const,
    targetArmed: true as const,
    targetId,
    leaseId,
    sequence,
    serverTime: now.toISOString(),
    acceptedUntil: acceptedUntil.toISOString()
  };
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new HassleOffRequestError(`${field} must be an ISO-8601 timestamp`);
  return parsed;
}

function auditJson(event: ReturnType<HassleOffStore["listAudit"]>[number]) {
  return {
    id: event.id,
    targetId: event.targetId,
    eventType: event.eventType,
    outcome: event.outcome,
    createdAt: event.createdAt.toISOString(),
    requestId: event.requestId,
    details: event.details
  };
}
