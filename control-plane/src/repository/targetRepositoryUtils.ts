import type { CapacityTarget } from "../domain/types.js";

export function cloneTarget(target: CapacityTarget): CapacityTarget {
  return JSON.parse(JSON.stringify(target)) as CapacityTarget;
}
