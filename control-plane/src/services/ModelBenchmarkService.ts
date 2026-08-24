import { randomUUID } from "node:crypto";
import type { CapacityTarget, ModelDeploymentMetadata, ModelDefinition } from "../domain/types.js";
import type { ModelCatalog } from "./ModelCatalog.js";
import type { ModelSelectionService } from "./ModelSelectionService.js";

export const MODEL_BENCHMARK_SUITE_VERSION = "neuron-speed-v2-50k";
const MEASURED_SAMPLES = 3;
const MINIMUM_REPORTED_PROMPT_TOKENS = 40_000;
// A leading unique marker prevents prefix-cache reuse; the repeated token is
// intentionally tokenizer-friendly and produces approximately 50K tokens.
const PREFILL_TEXT = " data".repeat(50_000);

export interface ModelBenchmarkResult {
  targetId: string;
  modelId: string;
  runtimeModelId: string;
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  sampleCount: number;
  measuredAt: string;
  suiteVersion: string;
}

export class ModelBenchmarkError extends Error {}

interface CompletionResponse {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: { prompt_per_second?: number; predicted_per_second?: number; prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number };
}

export class ModelBenchmarkService {
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly selection: ModelSelectionService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async benchmarkTarget(target: CapacityTarget): Promise<ModelBenchmarkResult[]> {
    try {
      const endpoint = completionsUrl(target);
      if (!endpoint) throw new Error(`Target ${target.id} has no OpenAI-compatible API URL for benchmarking`);
      const results: ModelBenchmarkResult[] = [];
      for (const model of this.catalog.listModelsForTarget(target.id)) results.push(await this.benchmarkDeployment(target, model, endpoint));
      return results;
    } catch (error) {
      throw new ModelBenchmarkError(error instanceof Error ? error.message : String(error));
    }
  }

  private async benchmarkDeployment(target: CapacityTarget, model: ModelDefinition, endpoint: string): Promise<ModelBenchmarkResult> {
    const runtimeModelId = this.catalog.requestModelId(target.id, model.id) ?? model.id;
    await this.sample(target, runtimeModelId, endpoint, 0, true);
    const samples = [];
    for (let index = 0; index < MEASURED_SAMPLES; index += 1) samples.push(await this.sample(target, runtimeModelId, endpoint, index + 1, false));
    const decodeTokensPerSecond = median(samples.map((sample) => sample.decodeTokensPerSecond).filter(isNumber));
    const prefillTokensPerSecond = median(samples.map((sample) => sample.prefillTokensPerSecond).filter(isNumber));
    if (decodeTokensPerSecond === undefined && prefillTokensPerSecond === undefined) throw new Error(`Target ${target.id} model ${model.id} did not return measurable timing data`);
    const measuredAt = new Date().toISOString();
    const existing = this.selection.catalogConfig().deployments.find((value) => value.targetId === target.id && value.modelId === model.id);
    const metadata: ModelDeploymentMetadata = {
      ...existing,
      targetId: target.id,
      modelId: model.id,
      performance: {
        ...existing?.performance,
        decodeTokensPerSecond,
        prefillTokensPerSecond,
        measuredAt,
        sampleCount: MEASURED_SAMPLES,
        provenance: { source: "NeurOn direct benchmark", version: MODEL_BENCHMARK_SUITE_VERSION, retrievedAt: measuredAt }
      },
      provenance: existing?.provenance
    };
    await this.selection.upsertDeployment(metadata);
    return { targetId: target.id, modelId: model.id, runtimeModelId, decodeTokensPerSecond, prefillTokensPerSecond, sampleCount: MEASURED_SAMPLES, measuredAt, suiteVersion: MODEL_BENCHMARK_SUITE_VERSION };
  }

  private async sample(target: CapacityTarget, runtimeModelId: string, endpoint: string, index: number, warmup: boolean) {
    const startedAt = performance.now();
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...authorizationHeaders(target) },
      body: JSON.stringify({
        model: runtimeModelId,
        messages: [{ role: "user", content: `NeurOn benchmark run ${index}-${randomUUID()}. Read the full payload before answering.${PREFILL_TEXT}\nRespond with a concise operational checklist.` }],
        temperature: 0,
        max_tokens: warmup ? 8 : 128,
        stream: false,
        cache_prompt: false
      }),
      signal: AbortSignal.timeout((target.modelWarmup?.timeoutSeconds ?? 120) * 1000)
    });
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
    if (!response.ok) throw new Error(`Target ${target.id} benchmark returned ${response.status}`);
    const body = await response.json() as CompletionResponse;
    const promptTokens = positive(body.usage?.prompt_tokens) ?? positive(body.timings?.prompt_n);
    const completionTokens = positive(body.usage?.completion_tokens) ?? positive(body.timings?.predicted_n);
    const prefillTokensPerSecond = positive(body.timings?.prompt_per_second) ?? rate(body.timings?.prompt_n, body.timings?.prompt_ms);
    const decodeTokensPerSecond = positive(body.timings?.predicted_per_second) ?? rate(body.timings?.predicted_n, body.timings?.predicted_ms) ?? (completionTokens ? completionTokens / elapsedSeconds : undefined);
    if (promptTokens === undefined || promptTokens < MINIMUM_REPORTED_PROMPT_TOKENS) {
      throw new Error(`Target ${target.id} benchmark did not process the required 50K-class prompt`);
    }
    return { promptTokens, completionTokens, prefillTokensPerSecond, decodeTokensPerSecond };
  }
}

function completionsUrl(target: CapacityTarget): string | undefined {
  const base = target.apiUrl ?? target.litellm?.apiBaseUrl ?? target.modelWarmup?.apiBaseUrl;
  if (!base) return undefined;
  const normalized = base.replace(/\/$/u, "");
  return `${normalized.endsWith("/v1") ? normalized : `${normalized}/v1`}/chat/completions`;
}
function authorizationHeaders(target: CapacityTarget): Record<string, string> {
  const direct = target.modelWarmup?.apiKey;
  const envName = target.modelWarmup?.apiKeyEnv ?? target.litellm?.apiKeyEnv;
  const value = direct ?? (envName ? process.env[envName] : undefined);
  return value ? { authorization: `Bearer ${value}` } : {};
}
function positive(value: number | undefined): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
function rate(tokens: number | undefined, milliseconds: number | undefined): number | undefined {
  const count = positive(tokens); const duration = positive(milliseconds); return count && duration ? count / (duration / 1000) : undefined;
}
function median(values: number[]): number | undefined {
  if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function isNumber(value: number | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }
