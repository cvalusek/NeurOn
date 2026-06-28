import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";

export class ModelWarmupService {
  private readonly warmed = new Set<string>();

  constructor(private readonly catalog: ModelCatalog) {}

  async warmupTargetModels(target: CapacityTarget, modelIds: string[]): Promise<void> {
    if (target.modelWarmup?.enabled === false) return;
    const uniqueModelIds = Array.from(new Set(modelIds)).filter(Boolean);
    if (uniqueModelIds.length === 0) return;
    const apiBaseUrl = warmupApiBaseUrl(target);
    if (!apiBaseUrl) return;

    for (const modelId of uniqueModelIds) {
      const model = this.catalog.getModel(modelId);
      const warmupModelId = warmupModelIdFor(model, modelId);
      const key = `${target.id}:${warmupModelId}`;
      if (this.warmed.has(key)) continue;
      await warmupModel(apiBaseUrl, warmupModelId, target);
      this.warmed.add(key);
    }
  }
}

function warmupModelIdFor(model: ModelDefinition | undefined, fallback: string): string {
  return model?.id ?? fallback;
}

function warmupApiBaseUrl(target: CapacityTarget): string | undefined {
  const configured = target.modelWarmup?.apiBaseUrl;
  if (configured) return configured.replace(/\/$/, "");
  if (target.runtimeApiBaseUrl) return target.runtimeApiBaseUrl.replace(/\/$/, "");
  if (target.litellm?.apiBaseUrl) return target.litellm.apiBaseUrl.replace(/\/$/, "");
  if (target.provider === "runpod" && target.runpod?.podId) {
    return `https://${target.runpod.podId}-${target.runpod.runtimePort ?? 8080}.proxy.runpod.net/v1`;
  }
  if (!target.healthCheckUrl) return undefined;
  try {
    const health = new URL(target.healthCheckUrl);
    return `${health.origin}/v1`;
  } catch {
    return undefined;
  }
}

async function warmupModel(apiBaseUrl: string, modelId: string, target: CapacityTarget): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = target.modelWarmup?.apiKey ?? process.env[target.modelWarmup?.apiKeyEnv ?? ""];
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout((target.modelWarmup?.timeoutSeconds ?? 60) * 1000),
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
      stream: false
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Model warmup for ${modelId} returned ${response.status}: ${body || response.statusText}`);
  }
}
