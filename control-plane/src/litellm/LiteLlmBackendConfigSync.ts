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
    neuron_route_name?: string;
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
  private readonly routesByTarget = new Map<string, LiteLlmRoute[]>();

  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string
  ) {}

  async syncTargetHealthy(target: CapacityTarget, discoveredModels: RuntimeDiscoveredModel[]): Promise<void> {
    if (target.litellm?.syncDiscoveredModels === false) return;
    const routes = routesForTarget(target, discoveredModels);
    if (routes.length === 0) return;
    const proposedRoutes = new Map(this.routesByTarget);
    proposedRoutes.set(target.id, routes);
    validateAliasPriorities(proposedRoutes);

    const runtimeApiBaseUrl = target.litellm?.apiBaseUrl ?? target.apiUrl;
    if (!runtimeApiBaseUrl) throw new Error(`Target ${target.id} has no runtime API URL for LiteLLM synchronization`);
    const credentialName = target.litellm?.credentialName ?? `neuron/${target.id}`;
    const runtimeApiKey = runtimeApiKeyFor(target);
    const fingerprint = syncFingerprint(target, routes, runtimeApiBaseUrl, credentialName, runtimeApiKey);
    if (this.syncedFingerprints.get(target.id) === fingerprint) return;

    await this.upsertCredential(target, credentialName, runtimeApiBaseUrl, runtimeApiKey);
    const deployments = await this.listDeployments();
    const ownedDeployments = deployments.filter((deployment) => isOwnedDeployment(deployment, target.id));
    const existingByRoute = new Map(
      ownedDeployments
        .filter((deployment) => deployment.model_info?.neuron_runtime_model_id && (deployment.model_info.neuron_route_name ?? deployment.model_name) && deployment.model_info.id)
        .map((deployment) => [routeKey(deployment.model_info!.neuron_route_name ?? deployment.model_name!, deployment.model_info!.neuron_runtime_model_id!), deployment])
    );
    const desiredRouteKeys = new Set(routes.map((route) => routeKey(route.routeName, route.runtimeModelId)));

    for (const route of routes) {
      const payload = modelPayload(target, route, credentialName);
      const existing = existingByRoute.get(routeKey(route.routeName, route.runtimeModelId));
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

    // LiteLLM currently offers only hard deletion for model deployments. Rename
    // routes NeurOn no longer owns so alias edits take effect without erasing
    // LiteLLM's historical deployment record.
    for (const deployment of ownedDeployments) {
      const id = deployment.model_info?.id;
      const runtimeModelId = deployment.model_info?.neuron_runtime_model_id;
      const routeName = deployment.model_info?.neuron_route_name ?? deployment.model_name;
      if (!id || !runtimeModelId || !routeName || desiredRouteKeys.has(routeKey(routeName, runtimeModelId))) continue;
      const retiredRouteName = `neuron-retired/${target.id}/${id}`;
      await this.request(`/model/${encodeURIComponent(id)}/update`, {
        method: "PATCH",
        body: JSON.stringify({
          model_name: retiredRouteName,
          model_info: {
            ...deployment.model_info,
            id,
            neuron_route_name: retiredRouteName,
            neuron_alias_scope: "retired"
          }
        })
      });
    }

    this.routesByTarget.set(target.id, routes);
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

interface LiteLlmRoute { routeName: string; runtimeModelId: string; order: number; scoped: boolean; }

function routesForTarget(target: CapacityTarget, models: RuntimeDiscoveredModel[]): LiteLlmRoute[] {
  const routes = new Map<string, LiteLlmRoute>();
  for (const runtime of models) {
    const runtimeModelId = runtime.id?.trim();
    if (!runtimeModelId) continue;
    const configured = target.models?.find((model) => [model.id, ...(model.aliases ?? []), ...(model.backendModelIds ?? [])].includes(runtimeModelId));
    const candidates = Array.from(new Set((configured?.aliases !== undefined ? configured.aliases : runtime.aliases ?? []).map((value) => value.trim()).filter(Boolean)));
    const aliases = candidates.some((alias) => alias !== runtimeModelId) ? candidates.filter((alias) => alias !== runtimeModelId) : [runtimeModelId];
    for (const alias of aliases) {
      const scoped = litellmModelName(target, alias);
      routes.set(routeKey(scoped, runtimeModelId), { routeName: scoped, runtimeModelId, order: 1, scoped: true });
      routes.set(routeKey(alias, runtimeModelId), { routeName: alias, runtimeModelId, order: target.aliasPriority ?? 100, scoped: false });
    }
  }
  return Array.from(routes.values()).sort((a, b) => a.routeName.localeCompare(b.routeName) || a.order - b.order || a.runtimeModelId.localeCompare(b.runtimeModelId));
}

function validateAliasPriorities(routesByTarget: Map<string, LiteLlmRoute[]>): void {
  const claims = new Map<string, Array<{ targetId: string; route: LiteLlmRoute }>>();
  for (const [targetId, routes] of routesByTarget) for (const route of routes) claims.set(route.routeName, [...(claims.get(route.routeName) ?? []), { targetId, route }]);
  for (const [alias, entries] of claims) {
    if (entries.length < 2) continue;
    const byOrder = new Map<number, typeof entries>();
    for (const entry of entries) byOrder.set(entry.route.order, [...(byOrder.get(entry.route.order) ?? []), entry]);
    const collision = Array.from(byOrder.entries()).find(([, values]) => new Set(values.map((value) => `${value.targetId}::${value.route.runtimeModelId}`)).size > 1);
    if (collision) throw new Error(`LiteLLM alias ${alias} has multiple deployments at priority ${collision[0]}; assign distinct target alias priorities`);
  }
}

function routeKey(routeName: string, runtimeModelId: string): string { return `${routeName}\u0000${runtimeModelId}`; }

function runtimeApiKeyFor(target: CapacityTarget): string {
  const envName = target.litellm?.apiKeyEnv;
  if (!envName) return "noapikey";
  const apiKey = process.env[envName];
  if (!apiKey) throw new Error(`Target ${target.id} LiteLLM API key environment variable ${envName} is not set`);
  return apiKey;
}

function modelPayload(target: CapacityTarget, route: LiteLlmRoute, credentialName: string) {
  return {
    model_name: route.routeName,
    litellm_params: {
      custom_llm_provider: "openai",
      litellm_credential_name: credentialName,
      model: route.runtimeModelId,
      order: route.order
    },
    model_info: {
      mode: "chat",
      managed_by: "neuron",
      neuron_target_id: target.id,
      neuron_target_display_name: target.displayName,
      neuron_runtime_model_id: route.runtimeModelId,
      neuron_route_name: route.routeName,
      neuron_alias_scope: route.scoped ? "target" : "global",
      neuron_alias_priority: route.order
    }
  };
}

function isOwnedDeployment(deployment: LiteLlmDeployment, targetId: string): boolean {
  return deployment.model_info?.managed_by === "neuron" && deployment.model_info.neuron_target_id === targetId;
}

function syncFingerprint(
  target: CapacityTarget,
  routes: LiteLlmRoute[],
  apiBaseUrl: string,
  credentialName: string,
  runtimeApiKey: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetId: target.id,
      targetDisplayName: target.displayName,
      routes,
      apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
      credentialName,
      runtimeApiKeyHash: createHash("sha256").update(runtimeApiKey).digest("hex")
    }))
    .digest("hex");
}

async function ensureSuccessful(response: Response, method: string, path: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`LiteLLM ${method} ${path} returned ${response.status} ${response.statusText}`.trim());
}
