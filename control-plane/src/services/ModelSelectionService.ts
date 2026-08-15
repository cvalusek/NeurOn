import type {
  ModelCapabilityMetadata,
  ModelDeploymentMetadata,
  ModelDeploymentPerformance,
  ModelMetricProvenance,
  ModelSelectionCatalogConfig
} from "../domain/types.js";
import type { ModelMetadataRepository } from "../domain/interfaces.js";
import { parseModelSelectionCatalog } from "../config/modelSelectionConfig.js";
import { ModelCatalog } from "./ModelCatalog.js";

const MIN_OBSERVED_SAMPLES = 3;
const MAX_SAMPLES_PER_DEPLOYMENT = 200;
const MAX_SEEN_REQUESTS = 5_000;
const SAMPLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModelPerformanceObservation {
  requestId?: string;
  seenAt: Date;
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
}

export interface ModelDeploymentSelectionView {
  key: string;
  targetId: string;
  targetDisplayName: string;
  modelId: string;
  modelDisplayName: string;
  modelFamily?: string;
  aliases: string[];
  technicalCapabilities: Array<{ label: string; title?: string }>;
  hostingMode?: "dedicated" | "multi-model";
  contextWindowTokens?: number;
  contextSource?: "operator" | "runtime" | "runtime-shared" | "configured";
  contextConcurrency?: number;
  hourlyUsd?: number;
  intelligence?: number;
  domains: Record<string, number>;
  quantization?: ModelDeploymentMetadata["quantization"];
  performance?: ModelDeploymentPerformance & { source: "configured" | "observed" };
  capabilityProvenance?: ModelMetricProvenance;
  deploymentProvenance?: ModelMetricProvenance;
  favorite?: boolean;
  profileCount?: number;
  reservationCount?: number;
  distinctUserCount?: number;
  lastUsedAt?: string;
  popularityScore?: number;
}

export interface ModelSelectionRequirements {
  minimumContextTokens?: number;
  maximumHourlyUsd?: number;
  domains?: string[];
  technicalCapabilities?: string[];
  hostingMode?: "dedicated" | "multi-model";
  weights: {
    intelligence: number;
    speed: number;
    cost: number;
  };
}

export interface RankedModelDeployment extends ModelDeploymentSelectionView {
  fitScore: number;
  dataCoveragePercent: number;
  intelligenceScore?: number;
  speedScore?: number;
  costScore?: number;
}

interface StoredObservation extends ModelPerformanceObservation {}

export class ModelSelectionService {
  private readonly capabilities = new Map<string, ModelCapabilityMetadata>();
  private readonly configuredDeployments = new Map<string, ModelDeploymentMetadata>();
  private readonly observations = new Map<string, StoredObservation[]>();
  private readonly seenRequests = new Map<string, number>();

  constructor(
    private readonly catalog: ModelCatalog,
    configured: ModelSelectionCatalogConfig = { schemaVersion: 1, models: [], deployments: [] },
    private readonly repository?: ModelMetadataRepository
  ) {
    for (const capability of configured.models) {
      const model = catalog.getModel(capability.modelId);
      if (!model || model.id !== capability.modelId) throw new Error(`Model selection metadata references unknown or non-canonical model ${capability.modelId}`);
      this.capabilities.set(capability.modelId, structuredClone(capability));
    }
    for (const deployment of configured.deployments) {
      const target = catalog.getTarget(deployment.targetId);
      const model = catalog.getModel(deployment.modelId);
      if (!target) throw new Error(`Model selection metadata references unknown target ${deployment.targetId}`);
      if (!model || model.id !== deployment.modelId || !model.targetIds.includes(target.id)) {
        throw new Error(`Model selection metadata deployment ${deployment.targetId}/${deployment.modelId} is not selectable`);
      }
      this.configuredDeployments.set(deploymentKey(deployment.targetId, deployment.modelId), structuredClone(deployment));
    }
  }

  async initialize(): Promise<void> {
    if (!this.repository) return;
    const [capabilities, deployments] = await Promise.all([this.repository.listCapabilities(), this.repository.listDeployments()]);
    if (capabilities.length === 0 && deployments.length === 0 && (this.capabilities.size > 0 || this.configuredDeployments.size > 0)) {
      await Promise.all([
        ...Array.from(this.capabilities.values()).map((value) => this.repository!.upsertCapability(value)),
        ...Array.from(this.configuredDeployments.values()).map((value) => this.repository!.upsertDeployment(value))
      ]);
      return;
    }
    if (capabilities.length === 0 && deployments.length === 0) return;
    const parsed = parseModelSelectionCatalog({ schemaVersion: 1, models: capabilities.map(withoutUpdatedAt), deployments: deployments.map(withoutUpdatedAt) });
    this.capabilities.clear();
    this.configuredDeployments.clear();
    for (const capability of parsed.models) this.setCapability(capability);
    for (const deployment of parsed.deployments) this.setDeployment(deployment);
  }

  async upsertCapability(input: ModelCapabilityMetadata): Promise<void> {
    const parsed = parseModelSelectionCatalog({ schemaVersion: 1, models: [input], deployments: [] }).models[0];
    this.setCapability(parsed);
    await this.repository?.upsertCapability(parsed);
  }

  async upsertDeployment(input: ModelDeploymentMetadata): Promise<void> {
    const parsed = parseModelSelectionCatalog({ schemaVersion: 1, models: [], deployments: [input] }).deployments[0];
    this.setDeployment(parsed);
    await this.repository?.upsertDeployment(parsed);
  }

  private setCapability(capability: ModelCapabilityMetadata): void {
    const model = this.catalog.getModel(capability.modelId);
    if (!model || model.id !== capability.modelId) throw new Error(`Model selection metadata references unknown or non-canonical model ${capability.modelId}`);
    this.capabilities.set(capability.modelId, structuredClone(capability));
  }

  private setDeployment(deployment: ModelDeploymentMetadata): void {
    const target = this.catalog.getTarget(deployment.targetId);
    const model = this.catalog.getModel(deployment.modelId);
    if (!target) throw new Error(`Model selection metadata references unknown target ${deployment.targetId}`);
    if (!model || model.id !== deployment.modelId || !model.targetIds.includes(target.id)) throw new Error(`Model selection metadata deployment ${deployment.targetId}/${deployment.modelId} is not selectable`);
    this.configuredDeployments.set(deploymentKey(deployment.targetId, deployment.modelId), structuredClone(deployment));
  }

  availableDomains(): string[] {
    return Array.from(new Set(Array.from(this.capabilities.values()).flatMap((metadata) => Object.keys(metadata.domains ?? {})))).sort();
  }

  availableTechnicalCapabilities(): string[] {
    return Array.from(new Set(this.catalog.listModels().flatMap((model) => (model.technicalCapabilities ?? []).map((capability) => capability.label)))).sort();
  }

  catalogConfig(): ModelSelectionCatalogConfig {
    return {
      schemaVersion: 1,
      models: Array.from(this.capabilities.values()).sort((a, b) => a.modelId.localeCompare(b.modelId)).map((value) => structuredClone(value)),
      deployments: Array.from(this.configuredDeployments.values()).sort((a, b) => a.targetId.localeCompare(b.targetId) || a.modelId.localeCompare(b.modelId)).map((value) => structuredClone(value))
    };
  }

  recordObservation(targetId: string, modelId: string, observation: ModelPerformanceObservation): boolean {
    const target = this.catalog.getTarget(targetId);
    const model = this.catalog.getModel(modelId);
    if (!target || !model || !model.targetIds.includes(targetId)) return false;
    if (!hasFinitePositiveMetric(observation)) return false;
    this.prune(observation.seenAt.getTime());
    if (observation.requestId) {
      if (this.seenRequests.has(observation.requestId)) return false;
      this.seenRequests.set(observation.requestId, observation.seenAt.getTime());
    }
    const key = deploymentKey(targetId, model.id);
    const samples = [...(this.observations.get(key) ?? []), sanitizeObservation(observation)]
      .sort((left, right) => left.seenAt.getTime() - right.seenAt.getTime())
      .slice(-MAX_SAMPLES_PER_DEPLOYMENT);
    this.observations.set(key, samples);
    return true;
  }

  listDeployments(costs: Record<string, { hourlyUsd: number }> = {}): ModelDeploymentSelectionView[] {
    this.prune(Date.now());
    const views: ModelDeploymentSelectionView[] = [];
    for (const target of this.catalog.listTargets()) {
      for (const model of this.catalog.listModelsForTarget(target.id)) {
        const key = deploymentKey(target.id, model.id);
        const capability = this.capabilities.get(model.id);
        const deployment = this.configuredDeployments.get(key);
        const observed = aggregateObservations(this.observations.get(key) ?? []);
        const performance = mergePerformance(deployment?.performance, observed);
        const runtimeContext = this.catalog.deploymentContext(target.id, model.id);
        views.push({
          key,
          targetId: target.id,
          targetDisplayName: target.displayName,
          modelId: model.id,
          modelDisplayName: model.displayName,
          modelFamily: model.modelFamily,
          aliases: this.catalog.deploymentAliases(target.id, model.id),
          technicalCapabilities: structuredClone(model.technicalCapabilities ?? []),
          hostingMode: target.hostingMode,
          contextWindowTokens: runtimeContext.tokens,
          contextSource: runtimeContext.source,
          contextConcurrency: runtimeContext.concurrency,
          hourlyUsd: costs[target.id]?.hourlyUsd,
          intelligence: capability?.intelligence,
          domains: { ...(capability?.domains ?? {}) },
          quantization: capability?.quantization ? structuredClone(capability.quantization) : deployment?.quantization ? structuredClone(deployment.quantization) : undefined,
          performance,
          capabilityProvenance: capability?.provenance ? structuredClone(capability.provenance) : undefined,
          deploymentProvenance: deployment?.provenance ? structuredClone(deployment.provenance) : undefined
        });
      }
    }
    return views.sort((left, right) => left.targetDisplayName.localeCompare(right.targetDisplayName) || left.modelDisplayName.localeCompare(right.modelDisplayName));
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - SAMPLE_MAX_AGE_MS;
    for (const [key, samples] of this.observations) {
      const recent = samples.filter((sample) => sample.seenAt.getTime() >= cutoff);
      if (recent.length) this.observations.set(key, recent);
      else this.observations.delete(key);
    }
    for (const [requestId, seenAt] of this.seenRequests) {
      if (seenAt < cutoff) this.seenRequests.delete(requestId);
    }
    while (this.seenRequests.size > MAX_SEEN_REQUESTS) {
      const oldest = this.seenRequests.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenRequests.delete(oldest);
    }
  }
}

export function rankModelDeployments(
  deployments: ModelDeploymentSelectionView[],
  requirements: ModelSelectionRequirements
): RankedModelDeployment[] {
  const eligible = deployments.filter((deployment) => {
    if (requirements.minimumContextTokens && (deployment.contextWindowTokens ?? 0) < requirements.minimumContextTokens) return false;
    if (requirements.maximumHourlyUsd !== undefined && (deployment.hourlyUsd === undefined || deployment.hourlyUsd > requirements.maximumHourlyUsd)) return false;
    if (requirements.technicalCapabilities?.some((required) => !deployment.technicalCapabilities.some((capability) => capability.label === required))) return false;
    if (requirements.hostingMode && deployment.hostingMode !== requirements.hostingMode) return false;
    return true;
  });
  const decodeValues = eligible.map((deployment) => deployment.performance?.decodeTokensPerSecond).filter(isNumber);
  const prefillValues = eligible.map((deployment) => deployment.performance?.prefillTokensPerSecond).filter(isNumber);
  const costValues = eligible.map((deployment) => deployment.hourlyUsd).filter(isNumber);
  const weights = normalizedWeights(requirements.weights);

  return eligible.map((deployment) => {
    const rawIntelligence = intelligenceValue(deployment, requirements.domains);
    const intelligenceScore = rawIntelligence === undefined ? undefined : clamp01(rawIntelligence / 100);
    const decodeScore = deployment.performance?.decodeTokensPerSecond === undefined ? undefined : relativeToMaximum(deployment.performance.decodeTokensPerSecond, decodeValues);
    const prefillScore = deployment.performance?.prefillTokensPerSecond === undefined ? undefined : relativeToMaximum(deployment.performance.prefillTokensPerSecond, prefillValues);
    const speedParts = [
      decodeScore === undefined ? undefined : { score: decodeScore, weight: 0.8 },
      prefillScore === undefined ? undefined : { score: prefillScore, weight: 0.2 }
    ].filter(isDefined);
    const speedScore = speedParts.length ? weightedAverage(speedParts) : undefined;
    const costScore = deployment.hourlyUsd === undefined ? undefined : relativeCostScore(deployment.hourlyUsd, costValues);
    const dimensions = [
      intelligenceScore === undefined ? undefined : { score: intelligenceScore, weight: weights.intelligence },
      speedScore === undefined ? undefined : { score: speedScore, weight: weights.speed },
      costScore === undefined ? undefined : { score: costScore, weight: weights.cost }
    ].filter(isDefined);
    const coverage = dimensions.reduce((total, dimension) => total + dimension.weight, 0);
    return {
      ...deployment,
      fitScore: dimensions.length ? weightedAverage(dimensions) : 0,
      dataCoveragePercent: Math.round(coverage * 100),
      intelligenceScore,
      speedScore,
      costScore
    };
  }).sort((left, right) => right.fitScore - left.fitScore || Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) || (right.popularityScore ?? 0) - (left.popularityScore ?? 0) || right.dataCoveragePercent - left.dataCoveragePercent || left.targetDisplayName.localeCompare(right.targetDisplayName));
}

function deploymentKey(targetId: string, modelId: string): string {
  return `${targetId}::${modelId}`;
}

function sanitizeObservation(observation: ModelPerformanceObservation): StoredObservation {
  return {
    requestId: observation.requestId,
    seenAt: new Date(observation.seenAt),
    decodeTokensPerSecond: finitePositive(observation.decodeTokensPerSecond),
    prefillTokensPerSecond: finitePositive(observation.prefillTokensPerSecond),
    timeToFirstTokenSeconds: finitePositive(observation.timeToFirstTokenSeconds)
  };
}

function hasFinitePositiveMetric(observation: ModelPerformanceObservation): boolean {
  return [observation.decodeTokensPerSecond, observation.prefillTokensPerSecond, observation.timeToFirstTokenSeconds].some((value) => finitePositive(value) !== undefined);
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function aggregateObservations(samples: StoredObservation[]): ModelDeploymentPerformance | undefined {
  if (samples.length < MIN_OBSERVED_SAMPLES) return undefined;
  const decode = samples.map((sample) => sample.decodeTokensPerSecond).filter(isNumber);
  const prefill = samples.map((sample) => sample.prefillTokensPerSecond).filter(isNumber);
  const latency = samples.map((sample) => sample.timeToFirstTokenSeconds).filter(isNumber);
  const decodeTokensPerSecond = medianWithMinimumSamples(decode);
  const prefillTokensPerSecond = medianWithMinimumSamples(prefill);
  const timeToFirstTokenSeconds = medianWithMinimumSamples(latency);
  if (decodeTokensPerSecond === undefined && prefillTokensPerSecond === undefined && timeToFirstTokenSeconds === undefined) return undefined;
  const newest = samples.at(-1)!;
  return {
    decodeTokensPerSecond,
    prefillTokensPerSecond,
    timeToFirstTokenSeconds,
    measuredAt: newest.seenAt.toISOString(),
    sampleCount: samples.length
  };
}

function mergePerformance(configured: ModelDeploymentPerformance | undefined, observed: ModelDeploymentPerformance | undefined): ModelDeploymentSelectionView["performance"] {
  if (observed) {
    const merged = { ...configured };
    for (const [key, value] of Object.entries(observed)) {
      if (value !== undefined) Object.assign(merged, { [key]: value });
    }
    return { ...merged, source: "observed" };
  }
  return configured ? { ...structuredClone(configured), source: "configured" } : undefined;
}

function medianWithMinimumSamples(values: number[]): number | undefined {
  return values.length >= MIN_OBSERVED_SAMPLES ? median(values) : undefined;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function intelligenceValue(deployment: ModelDeploymentSelectionView, domains: string[] | undefined): number | undefined {
  if (!domains?.length) return deployment.intelligence;
  const values = domains.map((domain) => deployment.domains[domain]).filter(isNumber);
  return values.length === domains.length ? Math.min(...values) : undefined;
}

function normalizedWeights(weights: ModelSelectionRequirements["weights"]): ModelSelectionRequirements["weights"] {
  const safe = {
    intelligence: Math.max(0, Number.isFinite(weights.intelligence) ? weights.intelligence : 0),
    speed: Math.max(0, Number.isFinite(weights.speed) ? weights.speed : 0),
    cost: Math.max(0, Number.isFinite(weights.cost) ? weights.cost : 0)
  };
  const total = safe.intelligence + safe.speed + safe.cost;
  if (!total) return { intelligence: 1 / 3, speed: 1 / 3, cost: 1 / 3 };
  return { intelligence: safe.intelligence / total, speed: safe.speed / total, cost: safe.cost / total };
}

function relativeToMaximum(value: number, values: number[]): number | undefined {
  const maximum = Math.max(...values);
  return Number.isFinite(maximum) && maximum > 0 ? clamp01(value / maximum) : undefined;
}

function relativeCostScore(value: number, values: number[]): number | undefined {
  const minimum = Math.min(...values);
  if (!Number.isFinite(minimum)) return undefined;
  if (minimum === 0) return value === 0 ? 1 : 0;
  return value > 0 ? clamp01(minimum / value) : undefined;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

function weightedAverage(parts: Array<{ score: number; weight: number }>): number {
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  return total ? parts.reduce((sum, part) => sum + part.score * part.weight, 0) / total : 0;
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function withoutUpdatedAt<T extends { updatedAt: Date }>(value: T): Omit<T, "updatedAt"> {
  const { updatedAt, ...rest } = value;
  void updatedAt;
  return rest;
}
