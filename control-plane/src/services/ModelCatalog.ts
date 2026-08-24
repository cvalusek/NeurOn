import type { CapacityTarget, ModelDefinition, ModelTag } from "../domain/types.js";
import type { RuntimeModelInfo } from "./RuntimeModelDiscovery.js";

export class ModelCatalog {
  private readonly modelById: Map<string, ModelDefinition>;
  private readonly modelByLookupId = new Map<string, ModelDefinition>();
  private readonly targetById: Map<string, CapacityTarget>;
  private readonly runtimeModelsByDeployment = new Map<string, RuntimeModelInfo[]>();

  constructor(models: ModelDefinition[], targets: CapacityTarget[]) {
    this.modelById = new Map(models.map((model) => [model.id, model]));
    this.targetById = new Map(targets.map((target) => [target.id, target]));
    for (const model of models) this.addModelLookups(model);
  }

  listModels(): ModelDefinition[] {
    return Array.from(this.modelById.values());
  }

  getModel(modelId: string): ModelDefinition | undefined {
    return this.modelByLookupId.get(modelId);
  }

  listTargets(): CapacityTarget[] {
    return Array.from(this.targetById.values());
  }

  listModelsForTarget(targetId: string): ModelDefinition[] {
    return this.listModels().filter((model) => model.targetIds.includes(targetId));
  }

  requestModelId(targetId: string, modelId: string): string | undefined {
    const model = this.getModel(modelId);
    if (!model) return undefined;
    const discovered = this.runtimeModelsByDeployment
      .get(deploymentKey(targetId, model.id))
      ?.find((candidate) => candidate.id?.trim())
      ?.id
      ?.trim();
    return discovered ?? model.backendModelIds?.[0] ?? model.runtimeModelIds?.[0] ?? model.id;
  }

  getTarget(id: string): CapacityTarget | undefined {
    return this.targetById.get(id);
  }

  deploymentContext(targetId: string, modelId: string): { tokens?: number; source?: "runtime" | "runtime-shared" | "configured"; concurrency?: number } {
    const model = this.getModel(modelId);
    if (!model) return {};
    const runtimeContexts = (this.runtimeModelsByDeployment.get(deploymentKey(targetId, model.id)) ?? [])
      .map(runtimeContext)
      .filter((value): value is NonNullable<ReturnType<typeof runtimeContext>> => Boolean(value));
    if (runtimeContexts.length) return runtimeContexts.sort((left, right) => left.tokens - right.tokens)[0];
    const configured = this.targetById.get(targetId)?.models?.find((candidate) => candidate.id === model.id || candidate.aliases?.includes(model.id));
    const tokens = configured?.contextWindowTokens ?? model.contextWindowTokens;
    return tokens ? { tokens, source: "configured" } : {};
  }

  deploymentAliases(targetId: string, modelId: string): string[] {
    const model = this.getModel(modelId);
    if (!model) return [];
    const configured = this.targetById.get(targetId)?.models?.find((candidate) => candidate.id === model.id);
    if (configured?.aliases !== undefined) return Array.from(new Set(configured.aliases.map((value) => value.trim()).filter(Boolean)));
    const runtime = this.runtimeModelsByDeployment.get(deploymentKey(targetId, model.id)) ?? [];
    const runtimeAliases = runtime.flatMap((value) => value.aliases ?? []).map((value) => value.trim()).filter(Boolean);
    return Array.from(new Set(runtimeAliases.length ? runtimeAliases : model.aliases));
  }

  upsertTarget(target: CapacityTarget): void {
    this.targetById.set(target.id, target);
    for (const modelId of target.modelIds) {
      const existing = this.modelById.get(modelId);
      if (existing) {
        existing.targetIds = mergeStrings(existing.targetIds, [target.id]);
        this.addModelLookups(existing);
      } else {
        const model: ModelDefinition = { id: modelId, displayName: modelId, aliases: [modelId], targetIds: [target.id] };
        this.modelById.set(model.id, model);
        this.addModelLookups(model);
      }
    }
  }

  removeTarget(targetId: string): void {
    this.targetById.delete(targetId);
    for (const model of this.modelById.values()) {
      model.targetIds = model.targetIds.filter((id) => id !== targetId);
    }
  }

  recordRuntimeModels(targetId: string, runtimeModels: Array<string | RuntimeModelInfo>): void {
    const runtimeInfos = dedupeRuntimeModels(runtimeModels.map(toRuntimeModelInfo).filter(isSelectableRuntimeModel));
    for (const key of this.runtimeModelsByDeployment.keys()) if (key.startsWith(`${targetId}\u0000`)) this.runtimeModelsByDeployment.delete(key);
    const runtimeIds = runtimeInfos.map((model) => model.id);
    const target = this.targetById.get(targetId);
    if (target) target.modelIds = Array.from(new Set([...target.modelIds, ...runtimeIds]));
    for (const runtimeInfo of runtimeInfos) {
      const runtimeId = runtimeInfo.id;
      const existing = [runtimeId, ...(runtimeInfo.aliases ?? [])]
        .map((candidate) => this.modelByLookupId.get(candidate))
        .find((candidate): candidate is ModelDefinition => Boolean(candidate));
      if (existing) {
        this.updateModelFromRuntimeInfo(existing, targetId, runtimeInfo);
        this.recordDeploymentRuntime(targetId, existing.id, runtimeInfo);
        continue;
      }
      const model: ModelDefinition = {
        id: runtimeId,
        displayName: readableModelName(runtimeId),
        modelFamily: inferModelFamily(runtimeId),
        aliases: aliasesForRuntimeModel(runtimeInfo),
        tags: tagsForRuntimeModel(runtimeInfo),
        technicalCapabilities: technicalCapabilitiesForRuntimeModel(runtimeInfo),
        runtimeModelIds: [runtimeId],
        runtimeMeta: runtimeInfo.meta ?? undefined,
        targetIds: [targetId],
        contextWindowTokens: contextWindowTokensForRuntimeModel(runtimeInfo),
        contextLabel: contextLabelForRuntimeModel(runtimeInfo)
      };
      this.modelById.set(model.id, model);
      this.addModelLookups(model);
      this.recordDeploymentRuntime(targetId, model.id, runtimeInfo);
    }
    for (const model of this.modelById.values()) {
      if (!model.targetIds.includes(targetId)) continue;
      const expected = new Set([model.id, ...model.aliases, ...(model.backendModelIds ?? [])]);
      const matches = runtimeInfos
        .filter((runtimeInfo) => expected.has(runtimeInfo.id) || (runtimeInfo.aliases ?? []).some((alias) => expected.has(alias)))
        .map((runtimeInfo) => runtimeInfo.id);
      model.runtimeModelIds = matches.length > 0 ? matches : model.runtimeModelIds;
      this.addModelLookups(model);
    }
  }

  private recordDeploymentRuntime(targetId: string, modelId: string, runtimeInfo: RuntimeModelInfo): void {
    const key = deploymentKey(targetId, modelId);
    this.runtimeModelsByDeployment.set(key, [...(this.runtimeModelsByDeployment.get(key) ?? []), runtimeInfo]);
  }

  private updateModelFromRuntimeInfo(model: ModelDefinition, targetId: string, runtimeInfo: RuntimeModelInfo & { id: string }): void {
    model.aliases = mergeStrings(model.aliases, aliasesForRuntimeModel(runtimeInfo));
    model.tags = mergeTags(model.tags, tagsForRuntimeModel(runtimeInfo));
    model.technicalCapabilities = mergeTags(model.technicalCapabilities, technicalCapabilitiesForRuntimeModel(runtimeInfo));
    model.runtimeModelIds = mergeStrings(model.runtimeModelIds ?? [], [runtimeInfo.id]);
    model.targetIds = mergeStrings(model.targetIds, [targetId]);
    if (runtimeInfo.meta) model.runtimeMeta = { ...(model.runtimeMeta ?? {}), ...runtimeInfo.meta };
    const contextWindowTokens = contextWindowTokensForRuntimeModel(runtimeInfo);
    if (contextWindowTokens) model.contextWindowTokens = contextWindowTokens;
    model.contextLabel = contextLabelForRuntimeModel(runtimeInfo) ?? model.contextLabel;
    this.addModelLookups(model);
  }

  targetsForModels(modelIds: string[]): CapacityTarget[] {
    const targetIds = new Set<string>();
    for (const modelId of modelIds) {
      const model = this.modelByLookupId.get(modelId);
      if (!model) throw new Error(`Unknown model ID: ${modelId}`);
      for (const targetId of model.targetIds) targetIds.add(targetId);
    }
    return Array.from(targetIds)
      .map((id) => this.targetById.get(id))
      .filter((target): target is CapacityTarget => Boolean(target));
  }

  validateTargetIds(targetIds: string[]): string[] {
    if (targetIds.length === 0) throw new Error("At least one target ID is required");
    for (const targetId of targetIds) {
      if (!this.targetById.has(targetId)) throw new Error(`Unknown target ID: ${targetId}`);
    }
    return targetIds;
  }

  validateModelIds(modelIds: string[]): void {
    if (modelIds.length === 0) throw new Error("At least one model ID is required");
    for (const modelId of modelIds) {
      if (!this.modelByLookupId.has(modelId)) throw new Error(`Unknown model ID: ${modelId}`);
    }
  }

  canonicalModelIds(modelIds: string[]): string[] {
    return Array.from(
      new Set(
        modelIds.map((modelId) => {
          const model = this.modelByLookupId.get(modelId);
          if (!model) throw new Error(`Unknown model ID: ${modelId}`);
          return model.id;
        })
      )
    );
  }

  private addModelLookups(model: ModelDefinition): void {
    const lookupIds = [model.id, ...model.aliases, ...(model.backendModelIds ?? []), ...(model.runtimeModelIds ?? [])];
    for (const lookupId of lookupIds) this.modelByLookupId.set(lookupId, model);
  }
}

function mergeStrings(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right]));
}

function mergeTags(left: ModelTag[] | undefined, right: ModelTag[]): ModelTag[] | undefined {
  const merged = new Map<string, ModelTag>();
  for (const tag of [...(left ?? []), ...right]) merged.set(tag.label, tag);
  const tags = Array.from(merged.values());
  return tags.length > 0 ? tags : undefined;
}

function toRuntimeModelInfo(model: string | RuntimeModelInfo): RuntimeModelInfo {
  return typeof model === "string" ? { id: model } : model;
}

function isSelectableRuntimeModel(model: RuntimeModelInfo): model is RuntimeModelInfo & { id: string } {
  return Boolean(model.id?.trim()) && model.id!.trim().toLowerCase() !== "default";
}

function dedupeRuntimeModels(models: Array<RuntimeModelInfo & { id: string }>): Array<RuntimeModelInfo & { id: string }> {
  const byId = new Map<string, RuntimeModelInfo & { id: string }>();
  for (const model of models) byId.set(model.id, model);
  return Array.from(byId.values());
}

function aliasesForRuntimeModel(model: RuntimeModelInfo & { id: string }): string[] {
  return Array.from(new Set([model.id, ...(model.aliases ?? [])].filter(Boolean)));
}

function tagsForRuntimeModel(model: RuntimeModelInfo & { id: string }): ModelTag[] {
  const apiTags = (model.tags ?? []).map((tag) => (typeof tag === "string" ? { label: tag } : { label: tag.label ?? "", title: tag.title })).filter((tag) => tag.label);
  if (apiTags.length > 0) return apiTags;
  const canonical = canonicalRuntimeName(model.id);
  const tags = new Map<string, string | undefined>();
  addArchitectureTag(tags, canonical);
  if (/(?:^|-)mtp(?:-|$)/i.test(canonical)) tags.set("MTP", "Multi-token prediction variant");
  if (/(?:^|-)it(?:-|$)/i.test(canonical)) tags.set("IT", "Instruction-tuned model");
  if (/(?:^|-)qat(?:-|$)/i.test(canonical)) tags.set("QAT", "Quantization-aware trained variant");
  if (/(?:^|-)gguf(?:-|$)/i.test(canonical)) tags.set("GGUF", "GGUF runtime format");
  const quantization = model.id.match(/:([^:/]+)$/)?.[1];
  if (quantization) tags.set(quantization.toUpperCase(), "Runtime quantization");
  return Array.from(tags.entries()).map(([label, title]) => ({ label, title }));
}

function technicalCapabilitiesForRuntimeModel(model: RuntimeModelInfo & { id: string }): ModelTag[] {
  const capabilities = new Map<string, ModelTag>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (!normalized || normalized === "text") return;
    const canonical = /^(?:image|images|vision|multimodal)$/.test(normalized) ? "vision"
      : /^(?:tool|tools|tool-calling|function-calling|functions)$/.test(normalized) ? "tools"
        : /^(?:embedding|embeddings)$/.test(normalized) ? "embeddings"
          : normalized;
    capabilities.set(canonical, { label: canonical, title: `Runtime-advertised ${canonical} support` });
  };
  const addCollection = (value: unknown) => {
    if (Array.isArray(value)) for (const entry of value) add(entry);
    else if (value && typeof value === "object") for (const [name, enabled] of Object.entries(value as Record<string, unknown>)) if (enabled === true) add(name);
  };
  addCollection(model.capabilities);
  addCollection(model.modalities);
  addCollection(model.input_modalities);
  addCollection(model.output_modalities);
  if (model.supports_vision === true) add("vision");
  if (model.supports_tools === true || model.supports_tool_calls === true) add("tools");
  for (const tag of model.tags ?? []) {
    const label = typeof tag === "string" ? tag : tag.label;
    if (label && /^(?:vision|image|images|multimodal|tools?|tool[_-]calling|function[_-]calling|audio|video|embeddings?)$/i.test(label)) add(label);
  }
  return Array.from(capabilities.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function contextWindowTokensForRuntimeModel(model: RuntimeModelInfo): number | undefined {
  return runtimeContext(model)?.tokens;
}

function runtimeContext(model: RuntimeModelInfo): { tokens: number; source: "runtime" | "runtime-shared"; concurrency?: number } | undefined {
  const perSequence = positiveInteger(model.meta?.n_ctx_per_sequence);
  if (perSequence) return { tokens: perSequence, source: "runtime", concurrency: positiveInteger(model.meta?.n_parallel) };
  const total = positiveInteger(model.meta?.n_ctx);
  if (!total) return undefined;
  const concurrency = positiveInteger(model.meta?.n_parallel);
  if (concurrency && concurrency > 1) return { tokens: Math.floor(total / concurrency), source: "runtime-shared", concurrency };
  return { tokens: total, source: "runtime", concurrency };
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function deploymentKey(targetId: string, modelId: string): string { return `${targetId}\u0000${modelId}`; }

function contextLabelForRuntimeModel(model: RuntimeModelInfo & { id: string }): string | undefined {
  return contextLabelForTokens(contextWindowTokensForRuntimeModel(model)) ?? inferContextLabel(model.id);
}

function contextLabelForTokens(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return tokens.toLocaleString();
}

function addArchitectureTag(tags: Map<string, string | undefined>, value: string): void {
  const tokens = value.split("-");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!/^(?:\d+|e)\d*b$/i.test(token)) continue;
    const next = tokens[index + 1];
    if (/^[ae]\d+b$/i.test(next ?? "")) {
      tags.set(`${token}-${next}`.toUpperCase(), "Parameter count and active-parameter architecture");
      return;
    }
    tags.set(token.toUpperCase(), token.toLowerCase().startsWith("e") ? "Expert parameter tier" : "Parameter count");
    return;
  }
}

function canonicalRuntimeName(runtimeId: string): string {
  return runtimeId
    .split("/")
    .at(-1)!
    .split(":")[0]
    .replace(/-gguf(?=-|$)/i, "")
    .toLowerCase();
}

function readableModelName(id: string): string {
  return canonicalRuntimeName(id)
    .split("-")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function inferContextLabel(modelId: string): string | undefined {
  return modelId.match(/(?:^|-)(\d+[km])(?:$|-|:)/i)?.[1].toLowerCase();
}

function inferModelFamily(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("gemma-4") || normalized.includes("gemma 4")) return "Gemma 4";
  if (normalized.includes("qwen3.6") || normalized.includes("qwen-3.6") || normalized.includes("qwen 3.6")) return "Qwen 3.6";
  if (normalized.includes("glm-4.7-flash") || normalized.includes("glm 4.7 flash")) return "GLM 4.7 Flash";
  return value.split(/[-\s]/).slice(0, 2).join(" ");
}
