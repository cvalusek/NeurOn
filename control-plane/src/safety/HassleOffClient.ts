import { randomUUID } from "node:crypto";
import type { CapacityTarget, HassleOffClientConfig } from "../domain/types.js";

const protocolVersion = "1";

interface LeaseClientState {
  leaseId: string;
  sequence: number;
}

export interface HassleOffTargetStatus {
  targetId: string;
  registrationId: string;
  displayName?: string;
  actionType: "fake" | "runpod-stop" | string;
  testOnly: boolean;
  armed: boolean;
  lease?: {
    acceptedUntil?: string;
    expired?: boolean;
  };
  lastTripResult?: {
    at: string;
    trigger: string;
    outcome: string;
    message?: string;
  };
}

export interface HassleOffStatus {
  protocolVersion: string;
  service: {
    healthy: boolean;
    armed: boolean;
    ready: boolean;
    registrationIssues?: string[];
  };
  lastFullTripTestSucceededAt?: string;
  tripTests?: Array<{ targetId: string; lastSucceededAt: string; auditEventId: number }>;
  targets: HassleOffTargetStatus[];
}

export interface HassleOffFailSafeTestResult {
  targetId: string;
  succeeded: true;
  lastFullTripTestSucceededAt: string;
  auditEventId: number;
}

export class HassleOffClient {
  private readonly leases = new Map<string, LeaseClientState>();
  private readonly shutdownRequestIds = new Map<string, string>();

  constructor(
    private readonly config: HassleOffClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()
  ) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get failSafeTestTargetId(): string {
    return this.config.failSafeTestTargetId;
  }

  async getStatus(): Promise<HassleOffStatus> {
    return this.readStatus("Could not read HassleOff safety status");
  }

  async runFailSafeTest(): Promise<HassleOffFailSafeTestResult> {
    const status = await this.readStatus("Could not verify the HassleOff fail-safe test target");
    if (!status.service.ready || !status.service.armed) {
      throw new Error("HassleOff must be ready and armed before running the fail-safe test");
    }
    const targetId = this.config.failSafeTestTargetId;
    const target = status.targets.find((candidate) => candidate.targetId === targetId);
    if (!target) throw new Error(`HassleOff fail-safe test target is not registered: ${targetId}`);
    if (!target.testOnly || target.actionType !== "fake") {
      throw new Error(`HassleOff fail-safe test target ${targetId} must be registered as testOnly with a fake action`);
    }
    const result = await this.request<{
      protocolVersion: string;
      targetId: string;
      succeeded: boolean;
      lastFullTripTestSucceededAt: string;
      auditEventId: number;
    }>(`/v1/targets/${encodeURIComponent(targetId)}/trip-test`, {
      method: "POST",
      body: JSON.stringify({ protocolVersion, targetId })
    }, `HassleOff fail-safe test failed for ${targetId}`);
    const succeededAt = new Date(result.lastFullTripTestSucceededAt);
    if (
      result.protocolVersion !== protocolVersion ||
      result.targetId !== targetId ||
      result.succeeded !== true ||
      !Number.isFinite(succeededAt.getTime()) ||
      !Number.isSafeInteger(result.auditEventId)
    ) {
      throw new Error(`HassleOff fail-safe test returned a mismatched result for ${targetId}`);
    }
    return {
      targetId,
      succeeded: true,
      lastFullTripTestSucceededAt: succeededAt.toISOString(),
      auditEventId: result.auditEventId
    };
  }

  async acceptExactTargetLease(target: CapacityTarget): Promise<void> {
    if (!target.hassleOff?.protected) return;
    const state = this.leases.get(target.id) ?? { leaseId: randomUUID(), sequence: 0 };
    const issuedAt = this.clock();
    state.sequence = Math.max(state.sequence + 1, issuedAt.getTime());
    this.leases.set(target.id, state);
    const durationSeconds = target.hassleOff.leaseDurationSeconds ?? 120;
    const expiresAt = new Date(issuedAt.getTime() + durationSeconds * 1000);
    const response = await this.request<{
      protocolVersion: string;
      accepted: boolean;
      armed: boolean;
      targetArmed: boolean;
      targetId: string;
      leaseId: string;
      sequence: number;
      acceptedUntil: string;
    }>(`/v1/targets/${encodeURIComponent(target.id)}/lease`, {
      method: "PUT",
      body: JSON.stringify({
        protocolVersion,
        targetId: target.id,
        controllerId: this.config.controllerId,
        leaseId: state.leaseId,
        sequence: state.sequence,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      })
    }, `HassleOff interlock blocked target ${target.id}`);
    const acceptedUntil = new Date(response.acceptedUntil);
    if (
      response.protocolVersion !== protocolVersion ||
      !response.accepted ||
      !response.armed ||
      !response.targetArmed ||
      response.targetId !== target.id ||
      response.leaseId !== state.leaseId ||
      response.sequence !== state.sequence ||
      !Number.isFinite(acceptedUntil.getTime()) ||
      acceptedUntil.getTime() <= this.clock().getTime()
    ) {
      throw new Error(`HassleOff interlock blocked target ${target.id}: watchdog did not confirm the exact armed lease`);
    }
    this.shutdownRequestIds.delete(target.id);
  }

  async shutdownThroughHassleOffIfTripTestStale(target: CapacityTarget, now = this.clock()): Promise<boolean> {
    const policy = target.hassleOff?.staleTripTestShutdown;
    if (!target.hassleOff?.protected || !policy?.enabled) return false;
    const status = await this.readStatus(`Could not read HassleOff trip-test status for ${target.id}`);
    if (status.protocolVersion !== protocolVersion || !status.service.armed || !status.service.ready) {
      throw new Error(`HassleOff is not armed and ready for intentional shutdown of ${target.id}`);
    }
    const succeededAt = status.lastFullTripTestSucceededAt ? new Date(status.lastFullTripTestSucceededAt) : undefined;
    const maxAgeMs = (policy.maxAgeSeconds ?? 86_400) * 1000;
    const stale = !succeededAt || !Number.isFinite(succeededAt.getTime()) || now.getTime() - succeededAt.getTime() > maxAgeMs;
    if (!stale) return false;
    const requestId = this.shutdownRequestIds.get(target.id) ?? randomUUID();
    this.shutdownRequestIds.set(target.id, requestId);
    const response = await this.request<{
      protocolVersion: string;
      targetId: string;
      requestId: string;
      stopped: boolean;
    }>(`/v1/targets/${encodeURIComponent(target.id)}/shutdown`, {
      method: "POST",
      body: JSON.stringify({
        protocolVersion,
        targetId: target.id,
        controllerId: this.config.controllerId,
        requestId,
        reason: "neuron-intentional-shutdown-stale-trip-test"
      })
    }, `HassleOff intentional shutdown failed for ${target.id}`);
    if (response.protocolVersion !== protocolVersion || response.targetId !== target.id || response.requestId !== requestId || !response.stopped) {
      throw new Error(`HassleOff intentional shutdown returned a mismatched result for ${target.id}`);
    }
    return true;
  }

  private async readStatus(context: string): Promise<HassleOffStatus> {
    const status = await this.request<HassleOffStatus>("/v1/status", { method: "GET" }, context);
    if (status.protocolVersion !== protocolVersion || !status.service || !Array.isArray(status.targets)) {
      throw new Error(`${context}: watchdog returned an unsupported status response`);
    }
    return status;
  }

  private async request<T>(path: string, init: RequestInit, context: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000);
    try {
      const response = await this.fetchImplementation(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.controllerToken}`,
          ...(init.headers ?? {})
        }
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) as { error?: string } & T : undefined;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      if (!body) throw new Error("empty response");
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${context}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
