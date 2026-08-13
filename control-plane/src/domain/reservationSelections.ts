import type { ReservationProfileSelection } from "./types.js";

export function parseReservationTargetSelections(value: unknown, context = "reservation target selections"): ReservationProfileSelection[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const targetIds = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${context} contains an invalid selection`);
    const { targetId, modelIds } = entry as Record<string, unknown>;
    if (typeof targetId !== "string" || targetId.length === 0 || !Array.isArray(modelIds) || modelIds.some((modelId) => typeof modelId !== "string" || modelId.length === 0)) {
      throw new Error(`${context} contains an invalid target or model ID`);
    }
    if (targetIds.has(targetId)) throw new Error(`${context} contains a duplicate target ID`);
    if (new Set(modelIds).size !== modelIds.length) throw new Error(`${context} contains a duplicate model ID`);
    targetIds.add(targetId);
    return { targetId, modelIds: [...modelIds] as string[] };
  });
}
