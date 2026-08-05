import type { CapacityTarget } from "../domain/types.js";

export function litellmRoutePrefixes(target: CapacityTarget): string[] {
  if (target.trafficModelPrefixes?.length) return target.trafficModelPrefixes;
  return [`${target.id}/`];
}

export function litellmDisplayPrefix(target: CapacityTarget): string {
  if (target.litellmDisplayPrefix !== undefined) return target.litellmDisplayPrefix;
  return litellmRoutePrefixes(target)[0];
}

export function litellmModelName(target: CapacityTarget, runtimeModelId: string): string {
  return `${litellmDisplayPrefix(target)}${runtimeModelId}`;
}
