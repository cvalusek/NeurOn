import type { ConfiguredModel, RuntimeDeploymentPlan, RuntimeProfile } from "../domain/types.js";

const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const CACHE_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface RuntimeCatalogOption {
  id: string;
  engine: string;
  providerType: string;
  hardwareLabel: string;
  configurationLabel: string;
  description?: string;
  gpuCount?: number;
  vramGbEach?: number;
  advertisedHourlyUsd?: number;
  modelCount: number;
  modelIds: string[];
  capabilities: string[];
}

interface LoadedCatalog {
  schemaVersion: string;
  fingerprint: string;
  deployments: Record<string, unknown>[];
}

interface CacheEntry {
  expiresAt: number;
  catalog: LoadedCatalog;
}

export class RuntimeCatalogService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async list(profile: RuntimeProfile, revision: string, providerType: string): Promise<RuntimeCatalogOption[]> {
    const catalog = await this.load(profile, revision);
    const catalogProvider = catalogProviderType(providerType);
    return catalog.deployments
      .filter((deployment) => stringValue(deployment.provider) === catalogProvider)
      .map((deployment) => optionFromDeployment(profile, providerType, deployment))
      .sort((left, right) => left.hardwareLabel.localeCompare(right.hardwareLabel)
        || left.configurationLabel.localeCompare(right.configurationLabel)
        || left.id.localeCompare(right.id));
  }

  async resolve(profile: RuntimeProfile, revision: string, providerType: string, deploymentId: string): Promise<RuntimeDeploymentPlan> {
    const catalog = await this.load(profile, revision);
    const expectedProvider = catalogProviderType(providerType);
    const matching = catalog.deployments.filter((deployment) => stringValue(deployment.id) === deploymentId);
    if (matching.length !== 1) throw new Error(`Runtime deployment ${deploymentId} was not found exactly once in the selected catalog`);
    const deployment = matching[0]!;
    if (stringValue(deployment.provider) !== expectedProvider) throw new Error(`Runtime deployment ${deploymentId} is not compatible with provider ${providerType}`);
    return planFromDeployment(profile, revision, providerType, catalog, deployment);
  }

  private async load(profile: RuntimeProfile, revisionInput: string): Promise<LoadedCatalog> {
    const descriptor = profile.catalog;
    if (!descriptor) throw new Error(`Runtime ${profile.id} does not publish a provisioning catalog`);
    const revision = normalizeRevision(revisionInput);
    const key = `${profile.id}\u0000${revision}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.catalog;
    const url = `https://raw.githubusercontent.com/${descriptor.repository}/${revision}/${descriptor.inventoryPath}`;
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Runtime catalog download returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_CATALOG_BYTES) throw new Error("Runtime catalog is larger than NeurOn's safety limit");
    const text = await responseTextWithinLimit(response);
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new Error("Runtime catalog is not valid JSON"); }
    const catalog = validateCatalog(raw, descriptor.schemaVersion);
    this.cache.set(key, { expiresAt: Date.now() + CACHE_MILLISECONDS, catalog });
    return catalog;
  }
}

function normalizeRevision(value: string): string {
  const revision = value.trim();
  if (!/^[0-9a-f]{40}$/iu.test(revision)) throw new Error("PreFer release must be a full 40-character commit SHA");
  return revision.toLowerCase();
}

function validateCatalog(value: unknown, expectedSchema: string): LoadedCatalog {
  const catalog = objectValue(value, "Runtime catalog");
  const schemaVersion = stringValue(catalog.schema_version);
  if (schemaVersion !== expectedSchema) throw new Error(`Runtime catalog schema ${schemaVersion || "missing"} is incompatible; expected ${expectedSchema}`);
  const fingerprint = stringValue(catalog.catalog_fingerprint);
  if (!/^[0-9a-f]{64}$/iu.test(fingerprint)) throw new Error("Runtime catalog is missing a valid compatibility fingerprint");
  if (!Array.isArray(catalog.deployments) || catalog.deployments.length > 10_000) throw new Error("Runtime catalog deployments are missing or exceed the safety limit");
  const deployments = catalog.deployments.map((deployment, index) => objectValue(deployment, `Runtime deployment ${index}`));
  const ids = new Set<string>();
  for (const deployment of deployments) {
    const id = stringValue(deployment.id);
    if (!id) throw new Error("Runtime catalog contains a deployment without an id");
    if (ids.has(id)) throw new Error(`Runtime catalog contains duplicate deployment id ${id}`);
    ids.add(id);
  }
  return { schemaVersion, fingerprint, deployments };
}

function optionFromDeployment(profile: RuntimeProfile, providerType: string, deployment: Record<string, unknown>): RuntimeCatalogOption {
  const hardware = optionalObject(deployment.hardware);
  const models = modelsFromDeployment(deployment);
  const id = requiredString(deployment.id, "deployment id");
  const gpuCount = positiveInteger(hardware?.gpu_count);
  const gpuName = stringValue(hardware?.gpu_name) || stringValue(hardware?.provider_gpu_type_id);
  const providerSku = stringValue(hardware?.provider_sku);
  const vram = positiveNumber(hardware?.vram_gb_each);
  const hardwareLabel = providerSku
    || [gpuCount && gpuCount > 1 ? `${gpuCount}×` : "", gpuName, vram ? `${vram} GB each` : ""].filter(Boolean).join(" ")
    || "Provider default";
  const configuration = id.split("/").at(-1) ?? id;
  return {
    id,
    engine: profile.catalog?.engine ?? profile.id,
    providerType,
    hardwareLabel,
    configurationLabel: title(configuration),
    description: stringValue(deployment.description) || undefined,
    gpuCount,
    vramGbEach: vram,
    advertisedHourlyUsd: positiveNumber(hardware?.advertised_hourly_usd_per_gpu),
    modelCount: models.length,
    modelIds: models.map((model) => model.id),
    capabilities: stringArray(deployment.capabilities)
  };
}

function planFromDeployment(
  profile: RuntimeProfile,
  revision: string,
  providerType: string,
  catalog: LoadedCatalog,
  deployment: Record<string, unknown>
): RuntimeDeploymentPlan {
  const descriptor = profile.catalog!;
  const hardware = optionalObject(deployment.hardware);
  const container = optionalObject(deployment.container);
  const environment = stringRecord(deployment.environment);
  const image = imageFor(descriptor.engine, descriptor.imageRepository, revision, deployment);
  return {
    pluginId: descriptor.pluginId,
    pluginVersion: normalizeRevision(revision),
    profileId: profile.id,
    engine: descriptor.engine,
    catalogSchemaVersion: catalog.schemaVersion,
    catalogFingerprint: catalog.fingerprint,
    deploymentId: requiredString(deployment.id, "deployment id"),
    providerType,
    image,
    port: positiveInteger(container?.internal_port) ?? profile.port ?? 8080,
    healthPath: stringValue(container?.health_path) || profile.health || "/health",
    apiPath: profile.api || "/v1",
    environment,
    hardware: hardware ? {
      providerSku: stringValue(hardware.provider_sku) || undefined,
      providerGpuTypeId: stringValue(hardware.provider_gpu_type_id) || undefined,
      gpuCount: positiveInteger(hardware.gpu_count),
      gpuName: stringValue(hardware.gpu_name) || undefined,
      vramGbEach: positiveNumber(hardware.vram_gb_each),
      vcpu: positiveInteger(hardware.vcpu) ?? positiveInteger(hardware.observed_vcpu),
      advertisedHourlyUsd: positiveNumber(hardware.advertised_hourly_usd_per_gpu)
    } : undefined,
    models: modelsFromDeployment(deployment)
  };
}

function modelsFromDeployment(deployment: Record<string, unknown>): ConfiguredModel[] {
  if (!Array.isArray(deployment.models)) throw new Error(`Runtime deployment ${stringValue(deployment.id) || "unknown"} is missing models`);
  const models = new Map<string, ConfiguredModel>();
  for (const raw of deployment.models) {
    const model = objectValue(raw, "Runtime deployment model");
    const id = requiredString(model.request_model_id, "request model id");
    const task = stringValue(model.task);
    const capability = technicalCapability(task);
    const contextWindowTokens = positiveInteger(model.context_per_request) ?? positiveInteger(model.context_size);
    const entry: ConfiguredModel = {
      id,
      displayName: id,
      modelFamily: stringValue(model.family) || undefined,
      aliases: Array.from(new Set([id, ...stringArray(model.aliases)])),
      ...(capability ? { technicalCapabilities: [capability] } : {}),
      ...(stringValue(model.section) ? { backendModelIds: [stringValue(model.section)] } : {}),
      ...(contextWindowTokens ? { contextWindowTokens, contextLabel: contextLabel(contextWindowTokens) } : {})
    };
    const existing = models.get(id);
    if (!existing) models.set(id, entry);
    else {
      existing.aliases = Array.from(new Set([...(existing.aliases ?? []), ...(entry.aliases ?? [])]));
      existing.technicalCapabilities = Array.from(new Map([...(existing.technicalCapabilities ?? []), ...(entry.technicalCapabilities ?? [])].map((item) => [item.label, item])).values());
    }
  }
  return Array.from(models.values());
}

function imageFor(engine: string, repository: string, revision: string, deployment: Record<string, unknown>): string {
  const short = normalizeRevision(revision).slice(0, 7);
  if (engine === "audio.cpp") {
    const baseTag = requiredString(deployment.image_tag, "audio image tag");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(baseTag)) throw new Error("Runtime catalog contains an invalid audio image tag");
    return `${repository}:${baseTag}-sha-${short}`;
  }
  return `${repository}:llama-cuda-sha-${short}`;
}

function technicalCapability(task: string): { label: string; title?: string } | undefined {
  if (task === "asr") return { label: "speech-to-text", title: "Speech to text" };
  if (task === "tts") return { label: "text-to-speech", title: "Text to speech" };
  if (task === "s2s") return { label: "realtime-speech", title: "Real-time speech" };
  if (task === "vdes") return { label: "voice-design", title: "Voice design" };
  if (task === "gen") return { label: "audio-generation", title: "Audio generation" };
  return undefined;
}

function catalogProviderType(providerType: string): string {
  if (providerType === "aws-ec2") return "aws";
  if (providerType === "runpod") return "runpod";
  throw new Error(`Provisioning from a runtime catalog is not supported for provider type ${providerType}`);
}

function title(value: string): string {
  return value.split(/[-_]/u).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function contextLabel(tokens: number): string {
  return tokens % 1_000 === 0 ? `${tokens / 1_000}k` : tokens.toLocaleString("en-US");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function requiredString(value: unknown, label: string): string { const result = stringValue(value); if (!result) throw new Error(`Runtime catalog is missing ${label}`); return result; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }
function stringRecord(value: unknown): Record<string, string> {
  const object = optionalObject(value);
  if (!object) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof entry !== "string" || entry.length > 4_000 || /[\r\n\0]/u.test(entry)) {
      throw new Error("Runtime catalog contains an invalid environment entry");
    }
    output[key] = entry;
  }
  return output;
}
function positiveNumber(value: unknown): number | undefined { const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) && result >= 0 ? result : undefined; }
function positiveInteger(value: unknown): number | undefined { const result = positiveNumber(value); return result !== undefined && Number.isInteger(result) && result > 0 ? result : undefined; }

async function responseTextWithinLimit(response: Response): Promise<string> {
  if (!response.body) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > MAX_CATALOG_BYTES) throw new Error("Runtime catalog is larger than NeurOn's safety limit");
    return value.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let reading = true;
  while (reading) {
    const { value, done } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }
    bytes += value.byteLength;
    if (bytes > MAX_CATALOG_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Runtime catalog is larger than NeurOn's safety limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
