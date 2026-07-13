import type { CapacityProvider, TargetModelDiscoveryRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget, RuntimeDiscoveredModel } from "../domain/types.js";
import type { HealthChecker } from "../reconciler/HealthChecker.js";
import { ModelCatalog } from "./ModelCatalog.js";
import type { TargetOperationCoordinator } from "./TargetOperationCoordinator.js";

interface OpenAiModelsResponse {
  data?: RuntimeModelInfo[];
}

export interface RuntimeModelInfo extends RuntimeDiscoveredModel {}

export class RuntimeModelDiscovery {
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly catalog: ModelCatalog,
    private readonly repository?: TargetModelDiscoveryRepository,
    private readonly targetOperations?: TargetOperationCoordinator,
    private readonly statuses?: TargetStatusRepository
  ) {}

  async hydrateCachedTargets(): Promise<void> {
    if (!this.repository) return;
    const knownTargets = new Set(this.catalog.listTargets().map((target) => target.id));
    for (const record of await this.repository.list()) {
      if (!knownTargets.has(record.targetId)) continue;
      this.catalog.recordRuntimeModels(record.targetId, record.models);
    }
  }

  async refreshTarget(target: CapacityTarget): Promise<void> {
    const existing = this.refreshes.get(target.id);
    if (existing) return existing;
    const refresh = Promise.resolve().then(() => this.readTargetCatalog(target));
    this.refreshes.set(target.id, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshes.get(target.id) === refresh) this.refreshes.delete(target.id);
    }
  }

  private async readTargetCatalog(target: CapacityTarget): Promise<void> {
    const url = modelsUrlForTarget(target);
    if (!url) throw new Error(`Target ${target.id} is missing apiUrl, litellm.apiBaseUrl, or healthUrl for model discovery`);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Runtime models returned ${response.status}`);
    const body = (await response.json()) as OpenAiModelsResponse;
    const models = body.data ?? [];
    this.catalog.recordRuntimeModels(target.id, models);
    await this.repository?.record({ targetId: target.id, models, discoveredAt: new Date() });
  }

  async bootstrapTarget(target: CapacityTarget, capacityProvider: CapacityProvider, healthChecker: HealthChecker): Promise<void> {
    if (!this.targetOperations) throw new Error("Target operation coordinator is not configured for runtime model discovery");
    const timeoutMs = (target.modelDiscovery?.bootstrapTimeoutSeconds ?? 600) * 1000;
    const startedAt = Date.now();
    try {
      await this.targetOperations.runRuntimeModelDiscovery(
        target.id,
        async () => {
          const status = await capacityProvider.getTargetStatus(target);
          return { wasRunning: status.observed === "healthy" || status.observed === "starting" };
        },
        async () => {
          let lastError: string | undefined;
          while (Date.now() - startedAt < timeoutMs) {
            const providerStatus = await capacityProvider.getTargetStatus(target);
            if (providerStatus.observed === "healthy") {
              const health = await healthChecker.check(target);
              if (health.ok) {
                try {
                  await this.refreshTarget(target);
                  return;
                } catch (error) {
                  // Runtime may be running before the OpenAI-compatible API is ready.
                  lastError = error instanceof Error ? error.message : String(error);
                }
              } else {
                lastError = health.message;
              }
            } else {
              lastError = providerStatus.message;
            }
            await sleep(5000);
          }
          throw new Error(`Timed out waiting for ${target.id} runtime model discovery${lastError ? `: ${lastError}` : ""}`);
        }
      );
      this.recordStatus(target.id, "Runtime model discovery complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordStatus(target.id, `Runtime model discovery failed: ${message}`);
      throw error;
    }
  }

  private recordStatus(targetId: string, message: string): void {
    if (!this.statuses) return;
    const current = this.statuses.get(targetId);
    this.statuses.set({
      ...current,
      targetId,
      desired: current?.desired ?? "off",
      observed: current?.observed ?? "stopped",
      message,
      lastCheckedAt: new Date()
    });
  }
}

export function shouldBootstrapRuntimeModels(target: { modelIds: string[]; models?: unknown[]; modelDiscovery?: { bootstrapOnStartup?: boolean } }): boolean {
  if (target.modelDiscovery?.bootstrapOnStartup === false) return false;
  if (target.modelDiscovery?.bootstrapOnStartup === true) return true;
  return target.modelIds.length === 0 && (target.models?.length ?? 0) === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelsUrlForTarget(target: CapacityTarget): string | undefined {
  if (target.apiUrl) {
    return `${target.apiUrl.replace(/\/$/, "")}/models`;
  }
  if (target.provider === "runpod" && target.runpod?.podId) {
    return `https://${target.runpod.podId}-${target.runpod.runtimePort ?? 8080}.proxy.runpod.net/v1/models`;
  }
  if (target.litellm?.apiBaseUrl) {
    return `${target.litellm.apiBaseUrl.replace(/\/$/, "")}/models`;
  }
  if (!target.healthUrl) return undefined;
  try {
    const health = new URL(target.healthUrl);
    return `${health.origin}/v1/models`;
  } catch {
    return undefined;
  }
}
