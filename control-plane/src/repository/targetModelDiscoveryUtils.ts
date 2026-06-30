import type { TargetModelDiscoveryRecord } from "../domain/types.js";

export function cloneTargetModelDiscoveryRecord(record: TargetModelDiscoveryRecord): TargetModelDiscoveryRecord {
  return targetModelDiscoveryRecordFromJson(JSON.stringify(record));
}

export function targetModelDiscoveryRecordFromJson(value: string | TargetModelDiscoveryRecord): TargetModelDiscoveryRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) as TargetModelDiscoveryRecord : value;
  return {
    ...parsed,
    discoveredAt: new Date(parsed.discoveredAt)
  };
}
