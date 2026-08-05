import { createHash } from "node:crypto";
import type { BackendConfigSync } from "../domain/interfaces.js";
import type { CapacityTarget, RuntimeDiscoveredModel } from "../domain/types.js";
import { litellmModelName } from "./modelRouting.js";

interface LiteLlmDeployment {
  model_name?: string;
  model_info?: {
    id?: string;
    managed_by?: string;
    neuron_target_id?: string;
    neuron_runtime_model_id?: string;
    [key: string]: unknown;
  };
}

interface LiteLlmModelInfoResponse {
  data?: LiteLlmDeployment[];
}

export class NoopBackendConfigSync implements BackendConfigSync {
  async syncTargetHealthy(_target: CapacityTarget, _discoveredModels: RuntimeDiscoveredModel[]): Promise<void> {}
}

export class LiteLlmBackendConfigSync implements BackendConfigSync {
  private readonly syncedFingerprints = new Map<string, string>();

  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string
  ) {}

  async syncTargetHealthy(target: CapacityTarget, discoveredModels: RuntimeDiscoveredModel[]): Promise<void> {
    if (target.litellm?.syncDiscoveredModels === false) return;
    const runtimeModelIds = uniqueRuntimeModelIds(discoveredModels);
    if (runtimeModelIds.length === 0) return;

    const runtimeApiBaseUrl = target.litellm?.apiBaseUrl ?? target.apiUrl;
    if (!runtimeApiBaseUrl) throw new Error(`Target ${target.id} has no runtime API URL for LiteLLM synchronization`);
    const credentialName = target.litellm?.credentialName ?? `neuron/${target.id}`;
    const runtimeApiKey = runtimeApiKeyFor(target);
    const fingerprint = syncFingerprint(target, runtimeModelIds, runtimeApiBaseUrl, credentialName, runtimeApiKey);
    if (this.syncedFingerprints.get(target.id) === fingerprint) return;

    await this.upsertCredential(target, credentialName, runtimeApiBaseUrl, runtimeApiKey);
    const deployments = await this.listDeployments();
    const ownedDeployments = deployments.filter((deployment) => isOwnedDeployment(deployment, target.id));
    const existingByRuntimeModelId = new Map(
      ownedDeployments
        .filter((deployment) => deployment.model_info?.neuron_runtime_model_id && deployment.model_info.id)
        .map((deployment) => [deployment.model_info!.neuron_runtime_model_id!, deployment])
    );

    for (const runtimeModelId of runtimeModelIds) {
      const payload = modelPayload(target, runtimeModelId, credentialName);
      const existing = existingByRuntimeModelId.get(runtimeModelId);
      if (existing?.model_info?.id) {
        await this.request(`/model/${encodeURIComponent(existing.model_info.id)}/update`, {
          method: "PATCH",
          body: JSON.stringify({
            ...payload,
            model_info: { ...payload.model_info, id: existing.model_info.id }
          })
        });
      } else {
        await this.request("/model/new", { method: "POST", body: JSON.stringify(payload) });
      }
    }

    this.syncedFingerprints.set(target.id, fingerprint);
  }

  private async upsertCredential(
    target: CapacityTarget,
    credentialName: string,
    apiBaseUrl: string,
    runtimeApiKey: string
  ): Promise<void> {
    const credential = {
      credential_name: credentialName,
      credential_values: {
        api_base: apiBaseUrl.replace(/\/$/, ""),
        api_key: runtimeApiKey
      },
      credential_info: {
        custom_llm_provider: "openai",
        provider: "openai",
        managed_by: "neuron",
        neuron_target_id: target.id,
        neuron_target_display_name: target.displayName
      }
    };
    const pathName = credentialName.split("/").map(encodeURIComponent).join("/");
    const existing = await this.fetch(`/credentials/by_name/${pathName}`, { method: "GET" });
    if (existing.status === 404) {
      await this.request("/credentials", { method: "POST", body: JSON.stringify(credential) });
      return;
    }
    await ensureSuccessful(existing, "GET", `/credentials/by_name/${pathName}`);
    await this.request(`/credentials/${pathName}`, { method: "PATCH", body: JSON.stringify(credential) });
  }

  private async listDeployments(): Promise<LiteLlmDeployment[]> {
    const response = await this.request("/model/info", { method: "GET" });
    const body = (await response.json()) as LiteLlmModelInfoResponse;
    return body.data ?? [];
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetch(path, init);
    await ensureSuccessful(response, init.method ?? "GET", path);
    return response;
  }

  private fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.apiBaseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...init.headers
      },
      signal: init.signal ?? AbortSignal.timeout(10_000)
    });
  }
}

function uniqueRuntimeModelIds(models: RuntimeDiscoveredModel[]): string[] {
  return Array.from(new Set(models.map((model) => model.id?.trim()).filter((id): id is string => Boolean(id)))).sort();
}

function runtimeApiKeyFor(target: CapacityTarget): string {
  const envName = target.litellm?.apiKeyEnv;
  if (!envName) return "noapikey";
  const apiKey = process.env[envName];
  if (!apiKey) throw new Error(`Target ${target.id} LiteLLM API key environment variable ${envName} is not set`);
  return apiKey;
}

function modelPayload(target: CapacityTarget, runtimeModelId: string, credentialName: string) {
  return {
    model_name: litellmModelName(target, runtimeModelId),
    litellm_params: {
      custom_llm_provider: "openai",
      litellm_credential_name: credentialName,
      model: runtimeModelId
    },
    model_info: {
      mode: "chat",
      managed_by: "neuron",
      neuron_target_id: target.id,
      neuron_target_display_name: target.displayName,
      neuron_runtime_model_id: runtimeModelId
    }
  };
}

function isOwnedDeployment(deployment: LiteLlmDeployment, targetId: string): boolean {
  return deployment.model_info?.managed_by === "neuron" && deployment.model_info.neuron_target_id === targetId;
}

function syncFingerprint(
  target: CapacityTarget,
  runtimeModelIds: string[],
  apiBaseUrl: string,
  credentialName: string,
  runtimeApiKey: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetId: target.id,
      targetDisplayName: target.displayName,
      runtimeModelIds,
      apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
      credentialName,
      modelNames: runtimeModelIds.map((modelId) => litellmModelName(target, modelId)),
      runtimeApiKeyHash: createHash("sha256").update(runtimeApiKey).digest("hex")
    }))
    .digest("hex");
}

async function ensureSuccessful(response: Response, method: string, path: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`LiteLLM ${method} ${path} returned ${response.status} ${response.statusText}`.trim());
}
