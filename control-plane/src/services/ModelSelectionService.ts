import type {
  ModelCapabilityMetadata,
  ModelDeploymentMetadata,
  ModelDeploymentPerformance,
  ModelMetricProvenance,
  ModelSelectionCatalogConfig
} from "../domain/types.js";
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
  contextWindowTokens?: number;
  hourlyUsd?: number;
  intelligence?: number;
  domains: Record<string, number>;
  quantization?: ModelDeploymentMetadata["quantization"];
  performance?: ModelDeploymentPerformance & { source: "configured" | "observed" };
  capabilityProvenance?: ModelMetricProvenance;
  deploymentProvenance?: ModelMetricProvenance;
}

export interface ModelSelectionRequirements {
  minimumContextTokens?: number;
  maximumHourlyUsd?: number;
  domain?: string;
  minimumQualityRetentionPercent?: number;
  weights: {
    intelligence: number;
    speed: number;
    cost: number;
  };
}

export interface RankedModelDeployment extends ModelDeploymentSelectionView {
  fitScore: number;
  dataCoveragePercent: number;
  qualityScore?: number;
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
    configured: ModelSelectionCatalogConfig = { schemaVersion: 1, models: [], deployments: [] }
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

  availableDomains(): string[] {
    return Array.from(new Set(Array.from(this.capabilities.values()).flatMap((metadata) => Object.keys(metadata.domains ?? {})))).sort();
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
        views.push({
          key,
          targetId: target.id,
          targetDisplayName: target.displayName,
          modelId: model.id,
          modelDisplayName: model.displayName,
          modelFamily: model.modelFamily,
          contextWindowTokens: deployment?.contextWindowTokens ?? model.contextWindowTokens,
          hourlyUsd: costs[target.id]?.hourlyUsd,
          intelligence: capability?.intelligence,
          domains: { ...(capability?.domains ?? {}) },
          quantization: deployment?.quantization ? structuredClone(deployment.quantization) : undefined,
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
    if (requirements.domain && deployment.domains[requirements.domain] === undefined) return false;
    if (requirements.minimumQualityRetentionPercent !== undefined && (deployment.quantization?.qualityRetentionPercent === undefined || deployment.quantization.qualityRetentionPercent < requirements.minimumQualityRetentionPercent)) return false;
    return true;
  });
  const qualityValues = eligible.map((deployment) => qualityValue(deployment, requirements.domain)).filter(isNumber);
  const decodeValues = eligible.map((deployment) => deployment.performance?.decodeTokensPerSecond).filter(isNumber);
  const prefillValues = eligible.map((deployment) => deployment.performance?.prefillTokensPerSecond).filter(isNumber);
  const latencyValues = eligible.map((deployment) => deployment.performance?.timeToFirstTokenSeconds).filter(isNumber);
  const costValues = eligible.map((deployment) => deployment.hourlyUsd).filter(isNumber);
  const weights = normalizedWeights(requirements.weights);

  return eligible.map((deployment) => {
    const rawQuality = qualityValue(deployment, requirements.domain);
    const qualityScore = rawQuality === undefined ? undefined : percentile(rawQuality, qualityValues, true);
    const decodeScore = deployment.performance?.decodeTokensPerSecond === undefined ? undefined : percentile(deployment.performance.decodeTokensPerSecond, decodeValues, true);
    const prefillScore = deployment.performance?.prefillTokensPerSecond === undefined ? undefined : percentile(deployment.performance.prefillTokensPerSecond, prefillValues, true);
    const latencyScore = deployment.performance?.timeToFirstTokenSeconds === undefined ? undefined : percentile(deployment.performance.timeToFirstTokenSeconds, latencyValues, false);
    const speedParts = [
      decodeScore === undefined ? undefined : { score: decodeScore, weight: 0.7 },
      prefillScore === undefined ? undefined : { score: prefillScore, weight: 0.2 },
      latencyScore === undefined ? undefined : { score: latencyScore, weight: 0.1 }
    ].filter(isDefined);
    const speedScore = speedParts.length ? weightedAverage(speedParts) : undefined;
    const costScore = deployment.hourlyUsd === undefined ? undefined : percentile(deployment.hourlyUsd, costValues, false);
    const dimensions = [
      qualityScore === undefined ? undefined : { score: qualityScore, weight: weights.intelligence },
      speedScore === undefined ? undefined : { score: speedScore, weight: weights.speed },
      costScore === undefined ? undefined : { score: costScore, weight: weights.cost }
    ].filter(isDefined);
    const coverage = dimensions.reduce((total, dimension) => total + dimension.weight, 0);
    return {
      ...deployment,
      fitScore: dimensions.length ? weightedAverage(dimensions) : 0,
      dataCoveragePercent: Math.round(coverage * 100),
      qualityScore,
      speedScore,
      costScore
    };
  }).sort((left, right) => right.fitScore - left.fitScore || right.dataCoveragePercent - left.dataCoveragePercent || left.targetDisplayName.localeCompare(right.targetDisplayName));
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

function qualityValue(deployment: ModelDeploymentSelectionView, domain: string | undefined): number | undefined {
  return domain ? deployment.domains[domain] : deployment.intelligence;
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

function percentile(value: number, values: number[], higherIsBetter: boolean): number {
  if (values.length <= 1 || values.every((candidate) => candidate === values[0])) return 1;
  const better = values.filter((candidate) => higherIsBetter ? candidate < value : candidate > value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return (better + Math.max(0, equal - 1) / 2) / (values.length - 1);
}

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
