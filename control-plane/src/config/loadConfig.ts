import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig, CapacityTarget, ModelDefinition, StorageConfig } from "../domain/types.js";

const targetSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().default("aws-ecs"),
  modelIds: z.array(z.string()).default([]),
  models: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        modelFamily: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        tags: z.array(z.object({ label: z.string(), title: z.string().optional() })).optional(),
        description: z.string().optional(),
        backendModelIds: z.array(z.string()).optional(),
        contextWindowTokens: z.number().int().positive().optional(),
        contextLabel: z.string().optional()
      })
    )
    .optional(),
  modelDiscovery: z
    .object({
      bootstrapOnStartup: z.boolean().optional(),
      bootstrapTimeoutSeconds: z.number().int().positive().optional()
    })
    .optional(),
  trafficModelPrefixes: z.array(z.string()).optional(),
  modelsMax: z.number().int().positive().optional(),
  aws: z
    .object({
      cluster: z.string().optional(),
      service: z.string().optional(),
      clusterName: z.string().optional(),
      serviceName: z.string().optional(),
      autoScalingGroupName: z.string()
    })
    .refine((value) => Boolean(value.cluster ?? value.clusterName), "AWS cluster is required")
    .refine((value) => Boolean(value.service ?? value.serviceName), "AWS service is required")
    .optional(),
  docker: z
    .object({
      containerName: z.string(),
      image: z.string().optional(),
      ports: z.array(z.string()).optional(),
      volumes: z.array(z.string()).optional(),
      environment: z.record(z.string()).optional(),
      gpus: z.string().optional(),
      restart: z.string().optional(),
      network: z.string().optional(),
      command: z.array(z.string()).optional(),
      extraArgs: z.array(z.string()).optional()
    })
    .optional(),
  dockerCompose: z
    .object({
      projectDirectory: z.string(),
      projectName: z.string().optional(),
      composeFile: z.string().optional(),
      composeFiles: z.array(z.string()).optional(),
      profiles: z.array(z.string()).optional(),
      serviceName: z.string()
    })
    .optional(),
  runpod: z
    .object({
      podId: z.string().optional(),
      apiKey: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      apiBaseUrl: z.string().url().optional(),
      runtimePort: z.number().int().positive().optional(),
      create: z.record(z.unknown()).optional()
    })
    .optional(),
  healthCheckUrl: z.string().url().optional(),
  runtimeApiBaseUrl: z.string().url().optional(),
  litellm: z
    .object({
      backendName: z.string(),
      apiBaseUrl: z.string().url()
    })
    .optional()
});

export async function loadConfig(): Promise<{ config: AppConfig; models: ModelDefinition[] }> {
  const capacityTargets = await loadCapacityTargets();
  const modelsById = new Map<string, ModelDefinition>();

  for (const target of capacityTargets) {
    const configuredModels: ModelDefinition[] = (target.models ?? []).map((model) => ({
      id: model.id,
      displayName: model.displayName ?? model.id,
      modelFamily: model.modelFamily ?? inferModelFamily(model.displayName ?? model.id),
      aliases: Array.from(new Set([model.id, ...(model.aliases ?? [])])),
      tags: model.tags,
      description: model.description,
      backendModelIds: model.backendModelIds,
      contextWindowTokens: model.contextWindowTokens,
      contextLabel: model.contextLabel ?? contextLabelForTokens(model.contextWindowTokens) ?? inferContextLabel(model.id),
      targetIds: [target.id]
    }));
    const targetModelIds = new Set([...target.modelIds, ...configuredModels.map((model) => model.id)]);
    target.modelIds = Array.from(targetModelIds);
    for (const model of configuredModels) {
      const existing = modelsById.get(model.id);
      if (existing) {
        existing.targetIds = Array.from(new Set([...existing.targetIds, target.id]));
        existing.aliases = mergeRequired(existing.aliases, model.aliases);
        existing.tags = mergeTags(existing.tags, model.tags);
        existing.runtimeModelIds = mergeOptional(existing.runtimeModelIds, model.runtimeModelIds);
        existing.backendModelIds = mergeOptional(existing.backendModelIds, model.backendModelIds);
      } else {
        modelsById.set(model.id, { ...model, targetIds: [target.id] });
      }
    }
    for (const modelId of target.modelIds) {
      if (!modelsById.has(modelId)) {
        modelsById.set(modelId, { id: modelId, displayName: modelId, aliases: [modelId], targetIds: [target.id] });
      }
    }
  }

  return {
    config: {
      port: intEnv("PORT", 8090),
      sharedPassword: requiredEnv("SHARED_PASSWORD", "dev-password"),
      cookieSecret: process.env.COOKIE_SECRET,
      storage: loadStorageConfig(),
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
      litellmApiBaseUrl: process.env.LITELLM_API_BASE_URL,
      litellmApiKey: process.env.LITELLM_API_KEY,
      litellmTrafficPollSeconds: intEnv("LITELLM_TRAFFIC_POLL_SECONDS", 60),
      litellmTrafficLookbackSeconds: intEnv("LITELLM_TRAFFIC_LOOKBACK_SECONDS", 300),
      capacityTargets,
      reconcilerIntervalSeconds: intEnv("RECONCILER_INTERVAL_SECONDS", 60),
      reservationStatusPollSeconds: intEnv("RESERVATION_STATUS_POLL_SECONDS", 10),
      adminStatusPollSeconds: intEnv("ADMIN_STATUS_POLL_SECONDS", 30),
      healthCheckTimeoutSeconds: intEnv("HEALTH_CHECK_TIMEOUT_SECONDS", 5),
      healthCheckIntervalSeconds: intEnv("HEALTH_CHECK_INTERVAL_SECONDS", 15),
      adminUsers: (process.env.ADMIN_USERS ?? "")
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean)
    },
    models: Array.from(modelsById.values()).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function mergeRequired(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right]));
}

function mergeOptional(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const merged = Array.from(new Set([...(left ?? []), ...(right ?? [])]));
  return merged.length > 0 ? merged : undefined;
}

function mergeTags(left: ModelDefinition["tags"], right: ModelDefinition["tags"]): ModelDefinition["tags"] {
  const merged = new Map<string, NonNullable<ModelDefinition["tags"]>[number]>();
  for (const tag of [...(left ?? []), ...(right ?? [])]) merged.set(tag.label, tag);
  const tags = Array.from(merged.values());
  return tags.length > 0 ? tags : undefined;
}

function contextLabelForTokens(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return tokens.toLocaleString();
}

function inferContextLabel(modelId: string): string | undefined {
  return modelId.match(/(?:^|-)(\d+k)(?:$|-)/i)?.[1].toLowerCase();
}

function inferModelFamily(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("gemma-4") || normalized.includes("gemma 4")) return "Gemma 4";
  if (normalized.includes("qwen3.6") || normalized.includes("qwen-3.6") || normalized.includes("qwen 3.6")) return "Qwen 3.6";
  if (normalized.includes("glm-4.7-flash") || normalized.includes("glm 4.7 flash")) return "GLM 4.7 Flash";
  return value.split(/[-\s]/).slice(0, 2).join(" ");
}

async function loadCapacityTargets(): Promise<CapacityTarget[]> {
  const raw = env("CAPACITY_TARGETS_JSON") ?? (env("CAPACITY_TARGET_KEYS") ? JSON.stringify(loadTargetsFromEnv()) : await readTargetsFile());
  const parsed = z.array(targetSchema).parse(JSON.parse(raw));
  return parsed.map((target) => ({ ...target, provider: normalizeProvider(target.provider) }));
}

function loadTargetsFromEnv(): unknown[] {
  return listEnv("CAPACITY_TARGET_KEYS").map((targetKey) => {
    const prefix = `CAPACITY_TARGET_${envKey(targetKey)}`;
    const provider = normalizeProvider(env(`${prefix}_PROVIDER`) ?? "aws-ecs");
    return compactObject({
      id: env(`${prefix}_ID`) ?? targetKey.toLowerCase().replace(/_/g, "-"),
      displayName: requiredScopedEnv(`${prefix}_DISPLAY_NAME`),
      provider,
      modelIds: listEnv(`${prefix}_MODEL_IDS`),
      models: loadModelsFromEnv(prefix),
      modelDiscovery: compactObject({
        bootstrapOnStartup: boolEnv(`${prefix}_MODEL_DISCOVERY_BOOTSTRAP_ON_STARTUP`),
        bootstrapTimeoutSeconds: intOptionalEnv(`${prefix}_MODEL_DISCOVERY_BOOTSTRAP_TIMEOUT_SECONDS`)
      }),
      trafficModelPrefixes: listEnv(`${prefix}_TRAFFIC_MODEL_PREFIXES`),
      modelsMax: intOptionalEnv(`${prefix}_MODELS_MAX`),
      aws: provider === "aws-ecs" ? loadAwsTargetFromEnv(prefix) : undefined,
      docker: provider === "docker" ? loadDockerContainerTargetFromEnv(prefix) : undefined,
      dockerCompose: provider === "docker-compose" ? loadDockerTargetFromEnv(prefix) : undefined,
      runpod: provider === "runpod" ? loadRunPodTargetFromEnv(prefix) : undefined,
      healthCheckUrl: env(`${prefix}_HEALTH_CHECK_URL`),
      runtimeApiBaseUrl: env(`${prefix}_RUNTIME_API_BASE_URL`),
      litellm: env(`${prefix}_LITELLM_BACKEND_NAME`) || env(`${prefix}_LITELLM_API_BASE_URL`)
        ? {
            backendName: requiredScopedEnv(`${prefix}_LITELLM_BACKEND_NAME`),
            apiBaseUrl: requiredScopedEnv(`${prefix}_LITELLM_API_BASE_URL`)
          }
        : undefined
    });
  });
}

function loadModelsFromEnv(targetPrefix: string): unknown[] | undefined {
  const modelKeys = listEnv(`${targetPrefix}_MODEL_KEYS`);
  if (modelKeys.length === 0) return undefined;
  return modelKeys.map((modelKey) => {
    const prefix = `${targetPrefix}_MODEL_${envKey(modelKey)}`;
    return compactObject({
      id: requiredScopedEnv(`${prefix}_ID`),
      displayName: env(`${prefix}_DISPLAY_NAME`),
      modelFamily: env(`${prefix}_FAMILY`),
      aliases: listEnv(`${prefix}_ALIASES`),
      description: env(`${prefix}_DESCRIPTION`),
      backendModelIds: listEnv(`${prefix}_BACKEND_MODEL_IDS`),
      contextWindowTokens: intOptionalEnv(`${prefix}_CONTEXT_WINDOW_TOKENS`),
      contextLabel: env(`${prefix}_CONTEXT_LABEL`)
    });
  });
}

function loadAwsTargetFromEnv(prefix: string): unknown {
  return compactObject({
    cluster: env(`${prefix}_AWS_CLUSTER`),
    service: env(`${prefix}_AWS_SERVICE`),
    clusterName: env(`${prefix}_AWS_CLUSTER_NAME`),
    serviceName: env(`${prefix}_AWS_SERVICE_NAME`),
    autoScalingGroupName: requiredScopedEnv(`${prefix}_AWS_ASG_NAME`)
  });
}

function loadDockerTargetFromEnv(prefix: string): unknown {
  return compactObject({
    projectDirectory: requiredScopedEnv(`${prefix}_DOCKER_PROJECT_DIRECTORY`),
    projectName: env(`${prefix}_DOCKER_PROJECT_NAME`),
    composeFile: env(`${prefix}_DOCKER_COMPOSE_FILE`),
    composeFiles: listEnv(`${prefix}_DOCKER_COMPOSE_FILES`),
    profiles: listEnv(`${prefix}_DOCKER_PROFILES`),
    serviceName: requiredScopedEnv(`${prefix}_DOCKER_SERVICE_NAME`)
  });
}

function loadDockerContainerTargetFromEnv(prefix: string): unknown {
  return compactObject({
    containerName: requiredScopedEnv(`${prefix}_DOCKER_CONTAINER_NAME`),
    image: env(`${prefix}_DOCKER_IMAGE`),
    ports: listEnv(`${prefix}_DOCKER_PORTS`),
    volumes: listEnv(`${prefix}_DOCKER_VOLUMES`),
    environment: loadDockerEnvironmentFromEnv(prefix),
    gpus: env(`${prefix}_DOCKER_GPUS`),
    restart: env(`${prefix}_DOCKER_RESTART`),
    network: env(`${prefix}_DOCKER_NETWORK`),
    command: listEnv(`${prefix}_DOCKER_COMMAND`),
    extraArgs: listEnv(`${prefix}_DOCKER_EXTRA_ARGS`)
  });
}

function loadDockerEnvironmentFromEnv(prefix: string): Record<string, string> | undefined {
  const keys = listEnv(`${prefix}_DOCKER_ENV_KEYS`);
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.map((key) => [key, env(`${prefix}_DOCKER_ENV_${envKey(key)}`) ?? ""]));
}

function loadRunPodTargetFromEnv(prefix: string): unknown {
  return compactObject({
    podId: env(`${prefix}_RUNPOD_POD_ID`),
    apiKey: env(`${prefix}_RUNPOD_API_KEY`),
    apiKeyEnv: env(`${prefix}_RUNPOD_API_KEY_ENV`),
    apiBaseUrl: env(`${prefix}_RUNPOD_API_BASE_URL`),
    runtimePort: intOptionalEnv(`${prefix}_RUNPOD_RUNTIME_PORT`),
    create: jsonOptionalEnv(`${prefix}_RUNPOD_CREATE_JSON`)
  });
}

function normalizeProvider(provider: string): CapacityTarget["provider"] {
  return provider === "compose" ? "docker-compose" : (provider as CapacityTarget["provider"]);
}

function loadStorageConfig(): StorageConfig {
  const driver = (env("STORAGE_DRIVER") ?? "memory").toLowerCase();
  if (driver === "memory") return { driver: "memory" };
  if (driver === "sqlite") return { driver: "sqlite", path: env("SQLITE_PATH") ?? path.resolve(process.cwd(), "data", "neuron.db") };
  if (driver === "postgres") return { driver: "postgres", connectionString: requiredScopedEnv("DATABASE_URL") };
  throw new Error(`Unsupported STORAGE_DRIVER: ${driver}`);
}

async function readTargetsFile(): Promise<string> {
  const configPath = env("CAPACITY_TARGETS_FILE") ?? path.resolve(process.cwd(), "examples", "capacity-targets.prefer-docker.json");
  return readFile(configPath, "utf8");
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intOptionalEnv(name: string): number | undefined {
  const value = env(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolEnv(name: string): boolean | undefined {
  const value = env(name);
  if (!value) return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function jsonOptionalEnv(name: string): unknown | undefined {
  const value = env(name);
  if (!value) return undefined;
  return JSON.parse(value) as unknown;
}

function listEnv(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function envKey(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function requiredScopedEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined) return false;
      if (Array.isArray(entry) && entry.length === 0) return false;
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && Object.keys(entry).length === 0) return false;
      return true;
    })
  ) as Partial<T>;
}

function requiredEnv(name: string, localFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error(`${name} is required`);
  return localFallback;
}
