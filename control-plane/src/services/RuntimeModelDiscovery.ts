import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityTarget, RuntimeModelMeta } from "../domain/types.js";
import type { HealthChecker } from "../reconciler/HealthChecker.js";
import { ModelCatalog } from "./ModelCatalog.js";

interface OpenAiModelsResponse {
  data?: RuntimeModelInfo[];
}

export interface RuntimeModelInfo {
  id?: string;
  aliases?: string[];
  tags?: Array<string | { label?: string; title?: string }>;
  meta?: RuntimeModelMeta | null;
}

export class RuntimeModelDiscovery {
  constructor(private readonly catalog: ModelCatalog) {}

  async refreshTarget(target: CapacityTarget): Promise<void> {
    const url = modelsUrlForTarget(target);
    if (!url) throw new Error(`Target ${target.id} is missing runtimeApiBaseUrl, litellm.apiBaseUrl, or healthCheckUrl for model discovery`);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Runtime models returned ${response.status}`);
    const body = (await response.json()) as OpenAiModelsResponse;
    this.catalog.recordRuntimeModels(target.id, body.data ?? []);
  }

  async bootstrapTarget(target: CapacityTarget, capacityProvider: CapacityProvider, healthChecker: HealthChecker): Promise<void> {
    const timeoutMs = (target.modelDiscovery?.bootstrapTimeoutSeconds ?? 600) * 1000;
    const startedAt = Date.now();
    await capacityProvider.ensureTargetOn(target);
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const providerStatus = await capacityProvider.getTargetStatus(target);
        if (providerStatus.observed === "healthy") {
          const health = await healthChecker.check(target);
          if (health.ok) {
            try {
              await this.refreshTarget(target);
              return;
            } catch {
              // Runtime may be running before the OpenAI-compatible API is ready.
            }
          }
        }
        await sleep(5000);
      }
      throw new Error(`Timed out waiting for ${target.id} runtime model discovery`);
    } finally {
      await capacityProvider.ensureTargetOff(target);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelsUrlForTarget(target: CapacityTarget): string | undefined {
  if (target.runtimeApiBaseUrl) {
    return `${target.runtimeApiBaseUrl.replace(/\/$/, "")}/models`;
  }
  if (target.provider === "runpod" && target.runpod?.podId) {
    return `https://${target.runpod.podId}-${target.runpod.runtimePort ?? 8080}.proxy.runpod.net/v1/models`;
  }
  if (target.litellm?.apiBaseUrl) {
    return `${target.litellm.apiBaseUrl.replace(/\/$/, "")}/models`;
  }
  if (!target.healthCheckUrl) return undefined;
  try {
    const health = new URL(target.healthCheckUrl);
    return `${health.origin}/v1/models`;
  } catch {
    return undefined;
  }
}
