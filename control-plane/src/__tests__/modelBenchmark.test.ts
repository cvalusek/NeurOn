import { describe, expect, it, vi } from "vitest";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { ModelBenchmarkError, ModelBenchmarkService } from "../services/ModelBenchmarkService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelSelectionService } from "../services/ModelSelectionService.js";

const target: CapacityTarget = {
  id: "benchmark-target",
  displayName: "Benchmark target",
  provider: "docker",
  modelIds: ["model-a"],
  apiUrl: "http://runtime.test/v1"
};
const models: ModelDefinition[] = [{
  id: "model-a",
  displayName: "Model A",
  aliases: ["coding"],
  runtimeModelIds: ["runtime-a"],
  targetIds: [target.id]
}];

describe("ModelBenchmarkService", () => {
  it("discards one warmup, avoids prompt caching, and stores medians with suite provenance", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const samples = [
      { prompt_per_second: 999, predicted_per_second: 999 },
      { prompt_per_second: 100, predicted_per_second: 20 },
      { prompt_per_second: 300, predicted_per_second: 40 },
      { prompt_per_second: 200, predicted_per_second: 30 }
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ usage: { prompt_tokens: 200, completion_tokens: 64 }, timings: samples[bodies.length - 1] });
    });
    const catalog = new ModelCatalog(models, [target]);
    const selection = new ModelSelectionService(catalog);
    await selection.upsertDeployment({
      targetId: target.id,
      modelId: "model-a",
      quantization: { format: "Q6", qualityRetentionPercent: 98.5 },
      provenance: { source: "Artifact evaluation", version: "quality-v1" }
    });
    const result = await new ModelBenchmarkService(catalog, selection, fetchMock as typeof fetch).benchmarkTarget(target);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodies[0]).toMatchObject({ model: "runtime-a", max_tokens: 8, cache_prompt: false, stream: false });
    expect(bodies.slice(1).every((body) => body.max_tokens === 64 && body.cache_prompt === false)).toBe(true);
    expect(new Set(bodies.map((body) => JSON.stringify(body.messages))).size).toBe(4);
    expect(result[0]).toMatchObject({ decodeTokensPerSecond: 30, prefillTokensPerSecond: 200, sampleCount: 3, suiteVersion: "neuron-speed-v1" });
    expect(selection.catalogConfig().deployments[0]).toMatchObject({
      targetId: target.id,
      modelId: "model-a",
      performance: {
        decodeTokensPerSecond: 30,
        prefillTokensPerSecond: 200,
        sampleCount: 3,
        provenance: { source: "NeurOn direct benchmark", version: "neuron-speed-v1" }
      },
      provenance: { source: "Artifact evaluation", version: "quality-v1" }
    });
  });

  it("classifies a benchmark failure so discovery does not repeatedly benchmark a healthy runtime", async () => {
    const catalog = new ModelCatalog(models, [target]);
    const service = new ModelBenchmarkService(catalog, new ModelSelectionService(catalog), vi.fn(async () => new Response("failed", { status: 500 })) as typeof fetch);
    await expect(service.benchmarkTarget(target)).rejects.toBeInstanceOf(ModelBenchmarkError);
  });
});
