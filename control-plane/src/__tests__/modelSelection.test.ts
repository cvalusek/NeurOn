import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadModelSelectionCatalogFromEnvironment,
  loadProfileAdvisorFromEnvironment,
  parseModelSelectionCatalog
} from "../config/modelSelectionConfig.js";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelSelectionService, rankModelDeployments } from "../services/ModelSelectionService.js";
import { ProfileAdvisorService } from "../services/ProfileAdvisorService.js";

const targets: CapacityTarget[] = [
  { id: "small", displayName: "Small", provider: "docker", modelIds: ["fast"] },
  { id: "large", displayName: "Large", provider: "docker", modelIds: ["smart"] }
];
const models: ModelDefinition[] = [
  { id: "fast", displayName: "Fast", aliases: ["fast"], targetIds: ["small"], contextWindowTokens: 32_000 },
  { id: "smart", displayName: "Smart", aliases: ["smart"], targetIds: ["large"], contextWindowTokens: 128_000 }
];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of [
    "MODEL_SELECTION_CATALOG_JSON",
    "MODEL_SELECTION_CATALOG_FILE",
    "PROFILE_ADVISOR_API_BASE_URL",
    "PROFILE_ADVISOR_API_KEY",
    "PROFILE_ADVISOR_MODEL",
    "PROFILE_ADVISOR_TIMEOUT_SECONDS"
  ]) delete process.env[key];
});

describe("model selection metadata", () => {
  it("validates private catalog scores, domains, and unique deployments", () => {
    expect(() => parseModelSelectionCatalog({ schemaVersion: 1, models: [{ modelId: "fast", intelligence: 101 }], deployments: [] })).toThrow();
    expect(() => parseModelSelectionCatalog({ schemaVersion: 1, models: [{ modelId: "fast", domains: { "Coding Work": 80 } }], deployments: [] })).toThrow();
    expect(() => parseModelSelectionCatalog({ schemaVersion: 1, models: [], deployments: [{ targetId: "small", modelId: "fast" }, { targetId: "small", modelId: "fast" }] })).toThrow();
  });

  it("combines capability, deployment, context, cost, and provenance without inferring missing values", () => {
    const service = selectionService();
    expect(service.availableDomains()).toEqual(["coding"]);
    expect(service.listDeployments({ small: { hourlyUsd: 1.25 }, large: { hourlyUsd: 4 } })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "small::fast",
        contextWindowTokens: 64_000,
        hourlyUsd: 1.25,
        intelligence: 62,
        domains: { coding: 77 },
        performance: expect.objectContaining({ decodeTokensPerSecond: 80, source: "configured" })
      }),
      expect.objectContaining({ key: "large::smart", intelligence: 90, performance: undefined, quantization: undefined })
    ]));
  });

  it("uses deduplicated rolling LiteLLM medians after three valid observations", () => {
    const service = selectionService();
    const now = Date.now();
    for (const [index, [requestId, decode]] of ([["r1", 20], ["r2", 60], ["r3", 40]] as const).entries()) {
      expect(service.recordObservation("small", "fast", { requestId, seenAt: new Date(now - (2 - index) * 60_000), decodeTokensPerSecond: decode, timeToFirstTokenSeconds: decode / 100 })).toBe(true);
    }
    expect(service.recordObservation("small", "fast", { requestId: "r3", seenAt: new Date(), decodeTokensPerSecond: 999 })).toBe(false);
    const deployment = service.listDeployments().find((candidate) => candidate.key === "small::fast");
    expect(deployment?.performance).toMatchObject({ decodeTokensPerSecond: 40, timeToFirstTokenSeconds: 0.4, sampleCount: 3, source: "observed" });
  });

  it("keeps configured metrics when the observed overlay lacks three samples for that metric", () => {
    const service = selectionService();
    const now = Date.now();
    for (const [index, decodeTokensPerSecond] of [20, 40, 60].entries()) {
      service.recordObservation("small", "fast", { requestId: `decode-${index}`, seenAt: new Date(now - index * 1_000), decodeTokensPerSecond });
    }
    expect(service.listDeployments().find((deployment) => deployment.key === "small::fast")?.performance).toMatchObject({
      decodeTokensPerSecond: 40,
      timeToFirstTokenSeconds: 0.5,
      source: "observed"
    });
  });

  it("applies hard context/domain/cost requirements and reports preference-data coverage", () => {
    const deployments = selectionService().listDeployments({ small: { hourlyUsd: 1.25 }, large: { hourlyUsd: 4 } });
    const ranked = rankModelDeployments(deployments, {
      minimumContextTokens: 64_000,
      maximumHourlyUsd: 2,
      domain: "coding",
      weights: { intelligence: 0.5, speed: 0.3, cost: 0.2 }
    });
    expect(ranked.map((deployment) => deployment.key)).toEqual(["small::fast"]);
    expect(ranked[0].dataCoveragePercent).toBe(100);
  });

  it("includes target-specific prefill throughput in speed ranking", () => {
    const deployments = selectionService().listDeployments().map((deployment, index) => ({
      ...deployment,
      performance: {
        decodeTokensPerSecond: 50,
        prefillTokensPerSecond: index === 0 ? 2_000 : 500,
        timeToFirstTokenSeconds: 0.5,
        source: "configured" as const
      }
    }));
    const ranked = rankModelDeployments(deployments, { weights: { intelligence: 0, speed: 1, cost: 0 } });
    expect(ranked[0].performance?.prefillTokensPerSecond).toBe(2_000);
  });

  it("fails closed when deployment metadata does not describe a selectable target/model pair", () => {
    const catalog = new ModelCatalog(models, targets);
    expect(() => new ModelSelectionService(catalog, { schemaVersion: 1, models: [], deployments: [{ targetId: "small", modelId: "smart" }] })).toThrow(/not selectable/);
  });

  it("loads one private catalog source and refuses ambiguous sources", async () => {
    process.env.MODEL_SELECTION_CATALOG_JSON = JSON.stringify({ schemaVersion: 1, models: [], deployments: [] });
    await expect(loadModelSelectionCatalogFromEnvironment()).resolves.toEqual({ schemaVersion: 1, models: [], deployments: [] });
    process.env.MODEL_SELECTION_CATALOG_FILE = "model-selection.local.private.json";
    await expect(loadModelSelectionCatalogFromEnvironment()).rejects.toThrow(/only one/);
  });
});

describe("profile advisor", () => {
  it("requires a complete HTTP(S) advisor configuration", () => {
    process.env.PROFILE_ADVISOR_API_BASE_URL = "file:///private/advisor";
    process.env.PROFILE_ADVISOR_MODEL = "guide";
    expect(() => loadProfileAdvisorFromEnvironment()).toThrow(/HTTP or HTTPS/);
    process.env.PROFILE_ADVISOR_API_BASE_URL = "https://advisor.example.test/v1/";
    process.env.PROFILE_ADVISOR_TIMEOUT_SECONDS = "10";
    expect(loadProfileAdvisorFromEnvironment()).toEqual({
      apiBaseUrl: "https://advisor.example.test/v1",
      model: "guide",
      timeoutSeconds: 10,
      apiKey: undefined
    });
  });

  it("sends only the workload and domain vocabulary, then validates structured requirements", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"useCase\":\"interactive coding\",\"domain\":\"coding\",\"minimumContextTokens\":64000,\"maximumHourlyUsd\":5,\"minimumQualityRetentionPercent\":null,\"responseLength\":\"short\",\"weights\":{\"intelligence\":60,\"speed\":30,\"cost\":10}}\n```" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const advisor = new ProfileAdvisorService({ apiBaseUrl: "https://advisor.example.test", apiKey: "private", model: "guide", timeoutSeconds: 5 }, () => ["coding"]);

    await expect(advisor.interpret("I need a coding model with 64K context")).resolves.toEqual({
      useCase: "interactive coding",
      responseLength: "short",
      requirements: {
        domain: "coding",
        minimumContextTokens: 64_000,
        maximumHourlyUsd: 5,
        minimumQualityRetentionPercent: undefined,
        weights: { intelligence: 0.6, speed: 0.3, cost: 0.1 }
      }
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ authorization: "Bearer private" });
    expect(String(init?.body)).toContain("I need a coding model with 64K context");
    expect(String(init?.body)).not.toContain("62");
  });
});

function selectionService(): ModelSelectionService {
  return new ModelSelectionService(new ModelCatalog(models, targets), {
    schemaVersion: 1,
    models: [
      { modelId: "fast", intelligence: 62, domains: { coding: 77 }, provenance: { source: "private benchmark", version: "1" } },
      { modelId: "smart", intelligence: 90, domains: { coding: 96 }, provenance: { source: "private benchmark", version: "1" } }
    ],
    deployments: [{
      targetId: "small",
      modelId: "fast",
      contextWindowTokens: 64_000,
      quantization: { format: "Q4_K_M", qualityRetentionPercent: 97, reference: "BF16" },
      performance: { decodeTokensPerSecond: 80, timeToFirstTokenSeconds: 0.5, sampleCount: 10 },
      provenance: { source: "operator measurement" }
    }]
  });
}
