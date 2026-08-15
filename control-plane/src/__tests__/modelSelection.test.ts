import { afterEach, describe, expect, it, vi } from "vitest";
import { parseModelSelectionCatalog } from "../config/modelSelectionConfig.js";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelSelectionService, rankModelDeployments } from "../services/ModelSelectionService.js";
import { ProfileAdvisorService } from "../services/ProfileAdvisorService.js";
import { InMemoryAssistantConfigRepository } from "../repository/InMemoryAssistantConfigRepository.js";

const targets: CapacityTarget[] = [
  { id: "small", displayName: "Small", provider: "docker", modelIds: ["fast"] },
  { id: "large", displayName: "Large", provider: "docker", modelIds: ["smart"] }
];
const models: ModelDefinition[] = [
  { id: "fast", displayName: "Fast", aliases: ["fast"], targetIds: ["small"], contextWindowTokens: 64_000, technicalCapabilities: [{ label: "tools" }] },
  { id: "smart", displayName: "Smart", aliases: ["smart"], targetIds: ["large"], contextWindowTokens: 128_000 }
];

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(service.availableTechnicalCapabilities()).toEqual(["tools"]);
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

  it("applies hard context, technical-capability, and cost requirements while strengths only refine ranking", () => {
    const deployments = selectionService().listDeployments({ small: { hourlyUsd: 1.25 }, large: { hourlyUsd: 4 } });
    const ranked = rankModelDeployments(deployments, {
      minimumContextTokens: 64_000,
      maximumHourlyUsd: 2,
      domains: ["coding"],
      technicalCapabilities: ["tools"],
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

});

describe("profile advisor", () => {
  it("reserves the selected NeurOn deployment and validates a UI configuration tool", async () => {
    const { advisor, createForUser, fetchMock } = profileAdvisorHarness([{
      name: "configure_profile", value: {
        useCase: "interactive coding", responseLength: "short",
        profile: { name: "Coding", description: "Interactive coding", defaultDurationMinutes: 30, defaultKeepaliveMinutes: 5 },
        requirements: { domains: ["coding"], technicalCapabilities: ["tools"], minimumContextTokens: 32_000, maximumHourlyUsd: 5, hostingMode: null, weights: { intelligence: 60, speed: 30, cost: 10 } },
        selections: [{ targetId: "small", modelIds: ["fast"] }]
      }
    }]);

    await expect(advisor.interpret("I need a coding model with 32K context", {
      currentDraft: { name: "Working draft", selections: [] },
      screen: {
        path: "/profiles/new", title: "New profile", surface: "profile_create",
        profileRequirements: { minimumContextTokens: 32_000, domains: ["coding"], weights: { intelligence: 0.6, speed: 0.3, cost: 0.1 } }
      }
    })).resolves.toMatchObject({
      type: "configure_profile",
      guidance: { useCase: "interactive coding", responseLength: "short", requirements: {
        domains: ["coding"],
        technicalCapabilities: ["tools"],
        hostingMode: undefined,
        minimumContextTokens: 32_000,
        maximumHourlyUsd: 5,
        weights: { intelligence: 0.6, speed: 0.3, cost: 0.1 }
      }, draft: { name: "Coding", selections: [{ targetId: "small", modelIds: ["fast"] }] } }
    });
    expect(createForUser).toHaveBeenCalledWith(expect.objectContaining({ username: "profile-advisor" }), expect.objectContaining({ targetIds: ["small"], modelIds: ["fast"], synthetic: true }));
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ authorization: "Bearer private" });
    expect(String(init?.body)).toContain("I need a coding model with 32K context");
    expect(String(init?.body)).toContain("shared self-hosted LLM capacity");
    expect(String(init?.body)).toContain("synthetic traffic reservation");
    expect(String(init?.body)).toContain('\\"surface\\":\\"profile_create\\"');
    expect(String(init?.body)).toContain('\\"minimumContextTokens\\":32000');
    expect(String(init?.body)).not.toContain("<main");
    expect(String(init?.body)).not.toContain("https://advisor.example.test");
  });

  it("returns separate confirmation-gated save and start proposals without performing either action", async () => {
    const { advisor, createForUser, fetchMock } = profileAdvisorHarness([
      { name: "save_profile", value: { message: "Save this coding setup?", profile: { name: "Coding", description: "Daily coding", defaultDurationMinutes: 30, defaultKeepaliveMinutes: 5, selections: [{ targetId: "small", modelIds: ["fast"] }] } } },
      { name: "start_reservation", value: { message: "Start Coding for 30 minutes?", profileId: "profile-1", durationMinutes: 30, keepaliveMinutes: 5 } }
    ]);
    const context = { savedProfiles: [{ id: "profile-1", name: "Coding" }], screen: { path: "/", title: "NeurOn", surface: "home" as const, startControls: { selectedProfileId: "profile-1", durationMinutes: 30, keepaliveMinutes: 5 } } };

    await expect(advisor.interpret("Save this profile", context)).resolves.toMatchObject({ type: "save_profile", requiresConfirmation: true, draft: { name: "Coding" } });
    await expect(advisor.interpret("Start it", context)).resolves.toMatchObject({ type: "start_reservation", requiresConfirmation: true, profileId: "profile-1", durationMinutes: 30 });
    expect(createForUser).toHaveBeenCalledTimes(2);
    expect(createForUser.mock.calls.every(([user, input]) => user.username === "profile-advisor" && input.synthetic === true)).toBe(true);
    const tools = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).tools.map((entry: { function: { name: string } }) => entry.function.name);
    expect(tools).toContain("save_profile");
    expect(tools).toContain("start_reservation");
    expect(tools).not.toContain("rediscover_target");
  });
});

function profileAdvisorHarness(results: Array<{ name: string; value: unknown }>) {
  const target: CapacityTarget = { ...targets[0], apiUrl: "https://advisor.example.test/v1", modelWarmup: { apiKey: "private" } };
  const catalog = new ModelCatalog([models[0]], [target]);
  const assistantConfig = new InMemoryAssistantConfigRepository();
  void assistantConfig.save({ targetId: "small", modelId: "fast", reservationMinutes: 10, keepaliveMinutes: 5, requestTimeoutSeconds: 5 });
  const createForUser = vi.fn(async (_user: { username: string }, _input: { synthetic?: boolean }) => ({ id: "advisor-reservation" }));
  const queue = [...results];
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const result = queue.shift();
    if (!result) throw new Error("No mocked profile-advisor result remains");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: result.name, arguments: JSON.stringify(result.value) } }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const advisor = new ProfileAdvisorService({
    assistantConfig,
    catalog,
    reservationService: { listActiveOwned: async () => [], createForUser, markDone: vi.fn(), extend: vi.fn() } as never,
    statuses: { get: () => ({ targetId: "small", desired: "on", observed: "healthy", message: "Ready" }), set: vi.fn(), list: () => [] },
    capacityProvider: { getTargetStatus: async () => ({ observed: "healthy", message: "Ready" }), provisionTarget: vi.fn(), ensureTargetOn: vi.fn(), ensureTargetOff: vi.fn(), forceStopTarget: vi.fn() },
    availableDomains: () => ["coding"],
    availableDeployments: () => [selectionService().listDeployments({ small: { hourlyUsd: 1.25 } }).find((deployment) => deployment.key === "small::fast")!],
    fetchImpl: fetchMock as typeof fetch,
    sleep: async () => undefined
  });
  return { advisor, createForUser, fetchMock };
}

function selectionService(): ModelSelectionService {
  return new ModelSelectionService(new ModelCatalog(models, targets), {
    schemaVersion: 1,
    models: [
      { modelId: "fast", intelligence: 62, domains: { coding: 77 }, quantization: { format: "Q4_K_M", qualityRetentionPercent: 97, reference: "BF16" }, provenance: { source: "private benchmark", version: "1" } },
      { modelId: "smart", intelligence: 90, domains: { coding: 96 }, provenance: { source: "private benchmark", version: "1" } }
    ],
    deployments: [{
      targetId: "small",
      modelId: "fast",
      contextWindowTokens: 32_000,
      performance: { decodeTokensPerSecond: 80, timeToFirstTokenSeconds: 0.5, sampleCount: 10 },
      provenance: { source: "operator measurement" }
    }]
  });
}
