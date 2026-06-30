import type { TargetModelDiscoveryRepository } from "../domain/interfaces.js";
import type { TargetModelDiscoveryRecord } from "../domain/types.js";
import { cloneTargetModelDiscoveryRecord } from "./targetModelDiscoveryUtils.js";

export class InMemoryTargetModelDiscoveryRepository implements TargetModelDiscoveryRepository {
  private readonly records = new Map<string, TargetModelDiscoveryRecord>();

  async record(input: TargetModelDiscoveryRecord): Promise<TargetModelDiscoveryRecord> {
    this.records.set(input.targetId, cloneTargetModelDiscoveryRecord(input));
    return cloneTargetModelDiscoveryRecord(input);
  }

  async get(targetId: string): Promise<TargetModelDiscoveryRecord | undefined> {
    const record = this.records.get(targetId);
    return record ? cloneTargetModelDiscoveryRecord(record) : undefined;
  }

  async list(): Promise<TargetModelDiscoveryRecord[]> {
    return Array.from(this.records.values())
      .sort((left, right) => left.targetId.localeCompare(right.targetId))
      .map(cloneTargetModelDiscoveryRecord);
  }

  async delete(targetId: string): Promise<boolean> {
    return this.records.delete(targetId);
  }
}
