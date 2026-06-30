import type { CapacityTarget, ModelDefinition, ModelTag } from "../domain/types.js";
import type { RuntimeModelInfo } from "./RuntimeModelDiscovery.js";

export class ModelCatalog {
  private readonly modelById: Map<string, ModelDefinition>;
  private readonly modelByLookupId = new Map<string, ModelDefinition>();
  private readonly targetById: Map<string, CapacityTarget>;

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

  getTarget(id: string): CapacityTarget | undefined {
    return this.targetById.get(id);
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
    const runtimeIds = runtimeInfos.map((model) => model.id);
    const target = this.targetById.get(targetId);
    if (target) target.modelIds = Array.from(new Set([...target.modelIds, ...runtimeIds]));
    for (const runtimeInfo of runtimeInfos) {
      const runtimeId = runtimeInfo.id;
      const existing = this.modelByLookupId.get(runtimeId);
      if (existing) {
        this.updateModelFromRuntimeInfo(existing, targetId, runtimeInfo);
        continue;
      }
      const model: ModelDefinition = {
        id: runtimeId,
        displayName: readableModelName(runtimeId),
        modelFamily: inferModelFamily(runtimeId),
        aliases: aliasesForRuntimeModel(runtimeInfo),
        tags: tagsForRuntimeModel(runtimeInfo),
        runtimeModelIds: [runtimeId],
        runtimeMeta: runtimeInfo.meta ?? undefined,
        targetIds: [targetId],
        contextWindowTokens: contextWindowTokensForRuntimeModel(runtimeInfo),
        contextLabel: contextLabelForRuntimeModel(runtimeInfo)
      };
      this.modelById.set(model.id, model);
      this.addModelLookups(model);
    }
    for (const model of this.modelById.values()) {
      if (!model.targetIds.includes(targetId)) continue;
      const expected = new Set([model.id, ...model.aliases, ...(model.backendModelIds ?? [])]);
      const matches = runtimeIds.filter((runtimeId) => expected.has(runtimeId));
      model.runtimeModelIds = matches.length > 0 ? matches : model.runtimeModelIds;
      this.addModelLookups(model);
    }
  }

  private updateModelFromRuntimeInfo(model: ModelDefinition, targetId: string, runtimeInfo: RuntimeModelInfo & { id: string }): void {
    model.aliases = mergeStrings(model.aliases, aliasesForRuntimeModel(runtimeInfo));
    model.tags = mergeTags(model.tags, tagsForRuntimeModel(runtimeInfo));
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

function contextWindowTokensForRuntimeModel(model: RuntimeModelInfo): number | undefined {
  return model.meta?.n_ctx ?? model.meta?.n_ctx_train;
}

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
