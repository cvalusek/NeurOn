import type { AssistantConfig } from "../domain/types.js";

export function cloneAssistantConfig(config: AssistantConfig): AssistantConfig {
  return {
    ...config,
    ...(config.audio ? { audio: structuredClone(config.audio) } : {}),
    updatedAt: new Date(config.updatedAt)
  };
}

export function assistantConfigFromLegacyTarget(value: unknown, targetId: string, updatedAt = new Date()): AssistantConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const legacy = (value as Record<string, unknown>).profileAdvisor;
  if (legacy === undefined) return undefined;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error(`Target ${targetId} has invalid legacy assistant configuration`);
  const record = legacy as Record<string, unknown>;
  const modelId = requiredString(record.modelId, `Target ${targetId} legacy assistant model`);
  const reservationMinutes = positiveInteger(record.reservationMinutes, 15, `Target ${targetId} legacy assistant reservation duration`);
  return {
    id: "default",
    targetId,
    modelId,
    reservationMinutes,
    keepaliveMinutes: Math.min(60, reservationMinutes),
    requestTimeoutSeconds: positiveInteger(record.requestTimeoutSeconds, 120, `Target ${targetId} legacy assistant response timeout`),
    updatedAt
  };
}

export function withoutLegacyAssistant<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("profileAdvisor" in value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.profileAdvisor;
  return copy as T;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value.trim();
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}
