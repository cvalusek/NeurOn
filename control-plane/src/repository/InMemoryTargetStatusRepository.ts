import type { TargetStatusRepository } from "../domain/interfaces.js";
import type { TargetStatus } from "../domain/types.js";

export class InMemoryTargetStatusRepository implements TargetStatusRepository {
  private readonly statuses = new Map<string, TargetStatus>();

  get(targetId: string): TargetStatus | undefined {
    const status = this.statuses.get(targetId);
    return status ? cloneStatus(status) : undefined;
  }

  set(status: TargetStatus): void {
    this.statuses.set(status.targetId, cloneStatus(status));
  }

  list(): TargetStatus[] {
    return Array.from(this.statuses.values()).map(cloneStatus);
  }
}

function cloneStatus(status: TargetStatus): TargetStatus {
  return {
    ...status,
    lastCheckedAt: status.lastCheckedAt ? new Date(status.lastCheckedAt) : undefined,
    lastHealthyAt: status.lastHealthyAt ? new Date(status.lastHealthyAt) : undefined,
    startingStartedAt: status.startingStartedAt ? new Date(status.startingStartedAt) : undefined,
    startupDurationsSeconds: status.startupDurationsSeconds ? [...status.startupDurationsSeconds] : undefined,
    startupEstimate: status.startupEstimate ? { ...status.startupEstimate } : undefined
  };
}
