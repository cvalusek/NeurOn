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
    neuron_alias_scope?: string;
    neuron_alias_priority?: number;
    neuron_canonical_model_id?: string;
    neuron_global_aliases?: unknown;
    neuron_scoped_aliases?: unknown;
    [key: string]: unknown;
  };
}

interface LiteLlmModelInfoResponse {
  data?: LiteLlmDeployment[];
}

interface LiteLlmRouterSettingsResponse {
  current_values?: {
    model_group_alias?: unknown;
    fallbacks?: unknown;
  };
}

interface CanonicalDeployment {
  targetId: string;
  canonicalModelId: string;
  groupName: string;
  runtimeModelId: string;
  globalAliases: string[];
  scopedAliases: string[];
  priority: number;
}

interface RouterPlan {
  modelGroupAliases: Record<string, string>;
  fallbacks: Array<Record<string, string[]>>;
}

export class NoopBackendConfigSync implements BackendConfigSync {
  async syncTargetHealthy(_target: CapacityTarget, _discoveredModels: RuntimeDiscoveredModel[]): Promise<void> {}
}

export class LiteLlmBackendConfigSync implements BackendConfigSync {
  private readonly syncedFingerprints = new Map<string, string>();
  private readonly deploymentsByTarget = new Map<string, CanonicalDeployment[]>();

  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string
  ) {}

  async syncTargetHealthy(target: CapacityTarget, discoveredModels: RuntimeDiscoveredModel[]): Promise<void> {
    if (target.litellm?.syncDiscoveredModels === false) return;
    const desired = deploymentsForTarget(target, discoveredModels);
    if (desired.length === 0) return;

    const runtimeApiBaseUrl = target.litellm?.apiBaseUrl ?? target.apiUrl;
    if (!runtimeApiBaseUrl) throw new Error(`Target ${target.id} has no runtime API URL for LiteLLM synchronization`);
    const credentialName = target.litellm?.credentialName ?? `neuron/${target.id}`;
    const runtimeApiKey = runtimeApiKeyFor(target);
    const fingerprint = syncFingerprint(target, desired, runtimeApiBaseUrl, credentialName, runtimeApiKey);
    if (this.syncedFingerprints.get(target.id) === fingerprint) return;

    const deployments = await this.listDeployments();
    const proposed = mergePersistedDeployments(this.deploymentsByTarget, deployments);
    proposed.set(target.id, desired);
    const routerPlan = buildRouterPlan(proposed);
    const routerSettings = await this.getRouterSettings();
    const previousManagedKeys = managedRouterKeys(deployments);
    validateRouterSettings(routerSettings, routerPlan, previousManagedKeys);

    await this.upsertCredential(target, credentialName, runtimeApiBaseUrl, runtimeApiKey);

    const ownedForTarget = deployments.filter((deployment) => isOwnedDeployment(deployment, target.id));
    const existingCanonical = new Map(
      ownedForTarget
        .filter(isCanonicalDeployment)
        .filter((deployment) => deployment.model_info?.id)
        .map((deployment) => [canonicalKey(deployment.model_name!, deployment.model_info!.neuron_runtime_model_id!), deployment])
    );
    const preservedDeploymentIds = new Set<string>();

    for (const deployment of desired) {
      const payload = modelPayload(target, deployment, credentialName);
      const existing = existingCanonical.get(canonicalKey(deployment.groupName, deployment.runtimeModelId));
      if (existing?.model_info?.id) {
        preservedDeploymentIds.add(existing.model_info.id);
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

    await this.updateRouterSettings(routerSettings, routerPlan, previousManagedKeys);

    // Formal aliases now point at the canonical deployments, so only redundant
    // NeurOn-owned legacy/stale rows are removed. Operator-owned deployments are
    // never candidates for deletion.
    for (const deployment of ownedForTarget) {
      const id = deployment.model_info?.id;
      if (!id || preservedDeploymentIds.has(id)) continue;
      await this.request("/model/delete", { method: "POST", body: JSON.stringify({ id }) });
    }

    this.deploymentsByTarget.clear();
    for (const [targetId, targetDeployments] of proposed) this.deploymentsByTarget.set(targetId, targetDeployments);
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
    if (body.data === undefined) return [];
    if (!Array.isArray(body.data)) throw new Error("LiteLLM GET /model/info returned an invalid deployment list");
    return body.data;
  }

  private async getRouterSettings(): Promise<LiteLlmRouterSettingsResponse["current_values"]> {
    const response = await this.request("/router/settings", { method: "GET" });
    const body = (await response.json()) as LiteLlmRouterSettingsResponse;
    if (!isRecord(body.current_values)) throw new Error("LiteLLM GET /router/settings did not return current_values");
    return body.current_values;
  }

  private async updateRouterSettings(
    current: LiteLlmRouterSettingsResponse["current_values"],
    desired: RouterPlan,
    previousManagedKeys: { aliases: Set<string>; fallbacks: Set<string> }
  ): Promise<void> {
    const modelGroupAliases = parseModelGroupAliases(current?.model_group_alias);
    for (const alias of previousManagedKeys.aliases) delete modelGroupAliases[alias];
    Object.assign(modelGroupAliases, desired.modelGroupAliases);

    const fallbackMap = parseFallbacks(current?.fallbacks);
    for (const key of previousManagedKeys.fallbacks) fallbackMap.delete(key);
    for (const entry of desired.fallbacks) {
      for (const [key, values] of Object.entries(entry)) fallbackMap.set(key, values);
    }

    await this.request("/config/update", {
      method: "POST",
      body: JSON.stringify({
        router_settings: {
          model_group_alias: sortRecord(modelGroupAliases),
          fallbacks: Array.from(fallbackMap.entries()).map(([key, values]) => ({ [key]: values }))
        }
      })
    });
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

function deploymentsForTarget(target: CapacityTarget, models: RuntimeDiscoveredModel[]): CanonicalDeployment[] {
  const deployments = new Map<string, CanonicalDeployment>();
  for (const runtime of models) {
    const runtimeModelId = runtime.id?.trim();
    if (!runtimeModelId) continue;
    const configured = target.models?.find((model) => [model.id, ...(model.aliases ?? []), ...(model.backendModelIds ?? [])].includes(runtimeModelId));
    const canonicalModelId = (configured?.id ?? runtimeModelId).trim();
    const candidates = configured?.aliases !== undefined ? configured.aliases : runtime.aliases ?? [];
    const aliases = uniqueStrings(candidates);
    const groupName = litellmModelName(target, canonicalModelId);
    const globalAliases = aliases.length > 0 ? aliases : [canonicalModelId];
    const scopedAliases = uniqueStrings(globalAliases.map((alias) => litellmModelName(target, alias))).filter((alias) => alias !== groupName);
    const deployment: CanonicalDeployment = {
      targetId: target.id,
      canonicalModelId,
      groupName,
      runtimeModelId,
      globalAliases,
      scopedAliases,
      priority: target.aliasPriority ?? 100
    };
    const key = canonicalKey(groupName, runtimeModelId);
    const sameGroup = Array.from(deployments.values()).find((value) => value.groupName === groupName && value.runtimeModelId !== runtimeModelId);
    if (sameGroup) throw new Error(`LiteLLM canonical model group ${groupName} resolves to multiple runtime models on target ${target.id}`);
    deployments.set(key, deployment);
  }
  return Array.from(deployments.values()).sort((a, b) => a.groupName.localeCompare(b.groupName) || a.runtimeModelId.localeCompare(b.runtimeModelId));
}

function mergePersistedDeployments(
  inMemory: Map<string, CanonicalDeployment[]>,
  deployments: LiteLlmDeployment[]
): Map<string, CanonicalDeployment[]> {
  const merged = new Map(inMemory);
  const persisted = new Map<string, CanonicalDeployment[]>();
  for (const deployment of deployments) {
    const value = canonicalDeploymentFromMetadata(deployment);
    if (!value || merged.has(value.targetId)) continue;
    persisted.set(value.targetId, [...(persisted.get(value.targetId) ?? []), value]);
  }
  for (const [targetId, values] of persisted) merged.set(targetId, values);
  return merged;
}

function canonicalDeploymentFromMetadata(deployment: LiteLlmDeployment): CanonicalDeployment | undefined {
  if (deployment.model_info?.managed_by !== "neuron" || deployment.model_info.neuron_alias_scope !== "canonical") return undefined;
  if (!isCanonicalDeployment(deployment)) throw new Error("LiteLLM returned incomplete NeurOn canonical deployment metadata");
  const info = deployment.model_info!;
  if (!isStringArray(info.neuron_global_aliases) || !isStringArray(info.neuron_scoped_aliases)) {
    throw new Error(`LiteLLM canonical model group ${deployment.model_name} has invalid NeurOn alias metadata`);
  }
  if (info.neuron_alias_priority !== undefined && (!Number.isInteger(info.neuron_alias_priority) || info.neuron_alias_priority < 1)) {
    throw new Error(`LiteLLM canonical model group ${deployment.model_name} has invalid NeurOn alias priority`);
  }
  return {
    targetId: info.neuron_target_id!,
    canonicalModelId: info.neuron_canonical_model_id!,
    groupName: deployment.model_name!,
    runtimeModelId: info.neuron_runtime_model_id!,
    globalAliases: stringArray(info.neuron_global_aliases),
    scopedAliases: stringArray(info.neuron_scoped_aliases),
    priority: typeof info.neuron_alias_priority === "number" ? info.neuron_alias_priority : 100
  };
}

function buildRouterPlan(deploymentsByTarget: Map<string, CanonicalDeployment[]>): RouterPlan {
  const all = Array.from(deploymentsByTarget.values()).flat();
  const canonicalOwners = new Map<string, CanonicalDeployment>();
  for (const deployment of all) {
    const existing = canonicalOwners.get(deployment.groupName);
    if (existing && (existing.targetId !== deployment.targetId || existing.runtimeModelId !== deployment.runtimeModelId)) {
      throw new Error(`LiteLLM canonical model group ${deployment.groupName} is claimed by multiple target models; assign unique display prefixes`);
    }
    canonicalOwners.set(deployment.groupName, deployment);
  }

  const claims = new Map<string, CanonicalDeployment[]>();
  for (const deployment of all) {
    for (const alias of [...deployment.globalAliases, ...deployment.scopedAliases]) {
      const existing = claims.get(alias) ?? [];
      if (!existing.some((value) => value.groupName === deployment.groupName)) existing.push(deployment);
      claims.set(alias, existing);
    }
  }

  for (const [alias, entries] of claims) {
    const canonicalOwner = canonicalOwners.get(alias);
    if (!canonicalOwner || entries.some((entry) => entry.groupName === canonicalOwner.groupName)) continue;
    throw new Error(`LiteLLM alias ${alias} conflicts with canonical model group ${canonicalOwner.groupName}`);
  }

  const modelGroupAliases: Record<string, string> = {};
  const fallbackMap = new Map<string, string[]>();
  for (const [alias, entries] of claims) {
    const ordered = entries.sort((a, b) => a.priority - b.priority || a.groupName.localeCompare(b.groupName));
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1].priority === ordered[index].priority && ordered[index - 1].groupName !== ordered[index].groupName) {
        throw new Error(`LiteLLM alias ${alias} has multiple model groups at priority ${ordered[index].priority}; assign distinct target alias priorities`);
      }
    }
    const canonicalOwner = canonicalOwners.get(alias);
    if (canonicalOwner && ordered[0].groupName !== canonicalOwner.groupName) {
      throw new Error(`LiteLLM alias ${alias} is also a canonical model group; its owning target must have the highest alias priority`);
    }
    if (alias !== ordered[0].groupName) modelGroupAliases[alias] = ordered[0].groupName;
    const groups = ordered.map((entry) => entry.groupName);
    if (groups.length > 1) {
      fallbackMap.set(alias, groups.slice(1));
      for (let index = 0; index < groups.length - 1; index += 1) fallbackMap.set(groups[index], groups.slice(index + 1));
    }
  }
  return {
    modelGroupAliases: sortRecord(modelGroupAliases),
    fallbacks: Array.from(fallbackMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => ({ [key]: values }))
  };
}

function managedRouterKeys(deployments: LiteLlmDeployment[]): { aliases: Set<string>; fallbacks: Set<string> } {
  const aliases = new Set<string>();
  const fallbacks = new Set<string>();
  for (const deployment of deployments) {
    if (deployment.model_info?.managed_by !== "neuron") continue;
    const info = deployment.model_info;
    for (const alias of [...stringArray(info.neuron_global_aliases), ...stringArray(info.neuron_scoped_aliases)]) aliases.add(alias);
    if (info.neuron_alias_scope === "global" || info.neuron_alias_scope === "target") {
      const legacyAlias = info.neuron_route_name ?? deployment.model_name;
      if (legacyAlias) aliases.add(legacyAlias);
    }
    if (deployment.model_name) fallbacks.add(deployment.model_name);
  }
  for (const alias of aliases) fallbacks.add(alias);
  return { aliases, fallbacks };
}

function parseModelGroupAliases(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("LiteLLM router model_group_alias is not an object");
  return { ...value };
}

function validateRouterSettings(
  current: LiteLlmRouterSettingsResponse["current_values"],
  desired: RouterPlan,
  previousManagedKeys: { aliases: Set<string>; fallbacks: Set<string> }
): void {
  const aliases = parseModelGroupAliases(current?.model_group_alias);
  for (const [alias, group] of Object.entries(desired.modelGroupAliases)) {
    if (!(alias in aliases) || previousManagedKeys.aliases.has(alias) || aliases[alias] === group) continue;
    throw new Error(`LiteLLM model-group alias ${alias} is already operator-managed with a different destination`);
  }
  const fallbacks = parseFallbacks(current?.fallbacks);
  for (const entry of desired.fallbacks) {
    for (const [key, values] of Object.entries(entry)) {
      const existing = fallbacks.get(key);
      if (!existing || previousManagedKeys.fallbacks.has(key) || sameStrings(existing, values)) continue;
      throw new Error(`LiteLLM fallback ${key} is already operator-managed with a different chain`);
    }
  }
}

function parseFallbacks(value: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (value === undefined || value === null) return result;
  if (!Array.isArray(value)) throw new Error("LiteLLM router fallbacks is not an array");
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("LiteLLM router fallbacks contains an invalid entry");
    for (const [key, candidates] of Object.entries(entry)) {
      if (!isStringArray(candidates)) throw new Error(`LiteLLM router fallback ${key} is not a string array`);
      result.set(key, candidates);
    }
  }
  return result;
}

function isCanonicalDeployment(deployment: LiteLlmDeployment): boolean {
  const info = deployment.model_info;
  return info?.managed_by === "neuron"
    && info.neuron_alias_scope === "canonical"
    && typeof info.neuron_target_id === "string"
    && typeof info.neuron_canonical_model_id === "string"
    && typeof info.neuron_runtime_model_id === "string"
    && typeof deployment.model_name === "string";
}

function canonicalKey(groupName: string, runtimeModelId: string): string { return `${groupName}\u0000${runtimeModelId}`; }

function runtimeApiKeyFor(target: CapacityTarget): string {
  const envName = target.litellm?.apiKeyEnv;
  if (!envName) return "noapikey";
  const apiKey = process.env[envName];
  if (!apiKey) throw new Error(`Target ${target.id} LiteLLM API key environment variable ${envName} is not set`);
  return apiKey;
}

function modelPayload(target: CapacityTarget, deployment: CanonicalDeployment, credentialName: string) {
  return {
    model_name: deployment.groupName,
    litellm_params: {
      custom_llm_provider: "openai",
      litellm_credential_name: credentialName,
      model: deployment.runtimeModelId
    },
    model_info: {
      mode: "chat",
      managed_by: "neuron",
      neuron_target_id: target.id,
      neuron_target_display_name: target.displayName,
      neuron_runtime_model_id: deployment.runtimeModelId,
      neuron_route_name: deployment.groupName,
      neuron_alias_scope: "canonical",
      neuron_alias_priority: deployment.priority,
      neuron_canonical_model_id: deployment.canonicalModelId,
      neuron_global_aliases: deployment.globalAliases,
      neuron_scoped_aliases: deployment.scopedAliases
    }
  };
}

function isOwnedDeployment(deployment: LiteLlmDeployment, targetId: string): boolean {
  return deployment.model_info?.managed_by === "neuron" && deployment.model_info.neuron_target_id === targetId;
}

function syncFingerprint(
  target: CapacityTarget,
  deployments: CanonicalDeployment[],
  apiBaseUrl: string,
  credentialName: string,
  runtimeApiKey: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetId: target.id,
      targetDisplayName: target.displayName,
      deployments,
      apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
      credentialName,
      runtimeApiKeyHash: createHash("sha256").update(runtimeApiKey).digest("hex")
    }))
    .digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string")) : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortRecord<T>(values: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

async function ensureSuccessful(response: Response, method: string, path: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`LiteLLM ${method} ${path} returned ${response.status} ${response.statusText}`.trim());
}
