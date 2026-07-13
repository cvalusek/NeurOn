export const HASSLEOFF_PROTOCOL_VERSION = "1" as const;

export type TargetActionConfig =
  | { type: "fake" }
  | { type: "runpod-stop"; podId: string; apiBaseUrl?: string; apiKeyEnv?: string };

export interface RegisteredTarget {
  targetId: string;
  registrationId: string;
  displayName?: string;
  testOnly?: boolean;
  action: TargetActionConfig;
}

export interface HassleOffConfig {
  port: number;
  controllerToken: string;
  databasePath: string;
  targets: RegisteredTarget[];
  checkIntervalMs: number;
  maxClockSkewMs: number;
  minLeaseMs: number;
  maxLeaseMs: number;
  maxMaintenanceHoldMs: number;
  failedActionRetryMs: number;
}

export interface ControllerLeaseInput {
  protocolVersion: typeof HASSLEOFF_PROTOCOL_VERSION;
  targetId: string;
  controllerId: string;
  leaseId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
}

export interface LeaseState {
  targetId: string;
  controllerId?: string;
  leaseId?: string;
  sequence?: number;
  issuedAt?: Date;
  acceptedUntil?: Date;
  armedAt?: Date;
  maintenanceHoldUntil?: Date;
  maintenanceReason?: string;
  lastActionAt?: Date;
  lastActionTrigger?: DestructiveActionTrigger;
  lastActionOutcome?: "succeeded" | "failed";
  lastActionMessage?: string;
  lastCompletedLeaseId?: string;
  lastActionAttemptAt?: Date;
}

export type DestructiveActionTrigger = "lease-expired" | "intentional-shutdown" | "synthetic-trip-test";

export interface AuditEvent {
  id: number;
  targetId: string;
  eventType: string;
  outcome: "decision" | "succeeded" | "failed" | "accepted" | "rejected";
  createdAt: Date;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface ActionRequestRecord {
  targetId: string;
  requestId: string;
  trigger: DestructiveActionTrigger;
  status: "running" | "succeeded" | "failed";
  message?: string;
  updatedAt: Date;
}

export interface TripTestResult {
  targetId: string;
  lastSucceededAt: Date;
  auditEventId: number;
}

export interface StopActionContext {
  targetId: string;
  requestId: string;
  trigger: DestructiveActionTrigger;
}

export interface StopActionResult {
  message: string;
}

export interface StopActionExecutor {
  stop(target: RegisteredTarget, context: StopActionContext): Promise<StopActionResult>;
}
