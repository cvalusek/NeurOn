import { z } from "zod";
import type { ModelSelectionCatalogConfig } from "../domain/types.js";

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
      sampleCount: z.number().int().positive().optional(),
      provenance: provenanceSchema.optional()
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
