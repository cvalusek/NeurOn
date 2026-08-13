import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelSelectionCatalogConfig, ProfileAdvisorConfig } from "../domain/types.js";

const provenanceSchema = z.object({
  source: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  sourceModelId: z.string().min(1).optional(),
  retrievedAt: z.string().datetime({ offset: true }).optional(),
  version: z.string().min(1).optional(),
  notes: z.string().max(500).optional()
}).strict();

const scoreSchema = z.number().min(0).max(100);
const positiveMetricSchema = z.number().positive().finite();

export const modelSelectionCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  models: z.array(z.object({
    modelId: z.string().min(1),
    intelligence: scoreSchema.optional(),
    domains: z.record(scoreSchema).optional(),
    provenance: provenanceSchema.optional()
  }).strict()).default([]),
  deployments: z.array(z.object({
    targetId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindowTokens: z.number().int().positive().optional(),
    quantization: z.object({
      format: z.string().min(1),
      qualityRetentionPercent: scoreSchema.optional(),
      reference: z.string().min(1).optional()
    }).strict().optional(),
    performance: z.object({
      decodeTokensPerSecond: positiveMetricSchema.optional(),
      prefillTokensPerSecond: positiveMetricSchema.optional(),
      timeToFirstTokenSeconds: positiveMetricSchema.optional(),
      measuredAt: z.string().datetime({ offset: true }).optional(),
      sampleCount: z.number().int().positive().optional()
    }).strict().optional(),
    provenance: provenanceSchema.optional()
  }).strict()).default([])
}).strict().superRefine((catalog, context) => {
  const modelIds = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    if (modelIds.has(model.modelId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["models", index, "modelId"], message: "Duplicate model metadata" });
    modelIds.add(model.modelId);
    for (const domain of Object.keys(model.domains ?? {})) {
      if (!/^[a-z0-9][a-z0-9._-]*$/u.test(domain)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["models", index, "domains", domain], message: "Domain keys must be lowercase slugs" });
    }
  }
  const deployments = new Set<string>();
  for (const [index, deployment] of catalog.deployments.entries()) {
    const key = `${deployment.targetId}\0${deployment.modelId}`;
    if (deployments.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["deployments", index], message: "Duplicate target/model deployment metadata" });
    deployments.add(key);
  }
});

export function parseModelSelectionCatalog(value: unknown): ModelSelectionCatalogConfig {
  return modelSelectionCatalogSchema.parse(value) as ModelSelectionCatalogConfig;
}

export async function loadModelSelectionCatalogFromEnvironment(): Promise<ModelSelectionCatalogConfig | undefined> {
  const inline = optionalEnv("MODEL_SELECTION_CATALOG_JSON");
  const file = optionalEnv("MODEL_SELECTION_CATALOG_FILE");
  if (inline && file) throw new Error("Set only one of MODEL_SELECTION_CATALOG_JSON or MODEL_SELECTION_CATALOG_FILE");
  if (!inline && !file) return undefined;
  const raw = inline ?? await readFile(path.resolve(process.cwd(), file!), "utf8");
  return parseModelSelectionCatalog(JSON.parse(raw));
}

export function loadProfileAdvisorFromEnvironment(): ProfileAdvisorConfig | undefined {
  const apiBaseUrl = optionalEnv("PROFILE_ADVISOR_API_BASE_URL");
  const model = optionalEnv("PROFILE_ADVISOR_MODEL");
  const apiKey = optionalEnv("PROFILE_ADVISOR_API_KEY");
  if (!apiBaseUrl && !model && !apiKey) return undefined;
  if (!apiBaseUrl || !model) throw new Error("PROFILE_ADVISOR_API_BASE_URL and PROFILE_ADVISOR_MODEL are both required when profile guidance is configured");
  const timeoutSeconds = Number(optionalEnv("PROFILE_ADVISOR_TIMEOUT_SECONDS") ?? "15");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error("PROFILE_ADVISOR_TIMEOUT_SECONDS must be an integer from 1 to 120");
  const parsedUrl = new URL(apiBaseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("PROFILE_ADVISOR_API_BASE_URL must use HTTP or HTTPS");
  return {
    apiBaseUrl: z.string().url().parse(apiBaseUrl).replace(/\/$/u, ""),
    apiKey,
    model,
    timeoutSeconds
  };
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
