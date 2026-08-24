import { describe, expect, it, vi } from "vitest";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { InMemoryAssistantConfigRepository } from "../repository/InMemoryAssistantConfigRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ProfileAdvisorService } from "../services/ProfileAdvisorService.js";

describe("assistant runtime identity", () => {
  it("projects llama.cpp architecture modalities into the model catalog", () => {
    const modelId = "unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL";
    const target: CapacityTarget = {
      id: "local-prefer",
      displayName: "PreFer",
      provider: "docker",
      modelIds: [modelId]
    };
    const catalog = new ModelCatalog([{
      id: modelId,
      displayName: "Gemma 4 E2B",
      aliases: ["gemma-4-e2b"],
      targetIds: [target.id]
    }], [target]);

    catalog.recordRuntimeModels(target.id, [{
      id: modelId,
      architecture: {
        input_modalities: ["text", "image", "audio"],
        output_modalities: ["text"]
      }
    }]);

    expect(catalog.getModel(modelId)?.technicalCapabilities?.map((capability) => capability.label)).toEqual(["audio", "vision"]);
  });

  it("reconciles a persisted UD quant ID and requests the target-scoped discovered ID", async () => {
    const configuredId = "unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL";
    const discoveredId = "unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL";
    const target: CapacityTarget = {
      id: "local-prefer",
      displayName: "PreFer",
      provider: "docker",
      modelIds: [discoveredId],
      apiUrl: "https://runtime.example.test/v1"
    };
    const model: ModelDefinition = {
      id: discoveredId,
      displayName: "Gemma 4 E2B",
      aliases: ["gemma-4-e2b"],
      runtimeModelIds: [discoveredId],
      targetIds: [target.id]
    };
    const catalog = new ModelCatalog([model], [target]);
    catalog.recordRuntimeModels(target.id, [{ id: discoveredId, aliases: ["gemma-4-e2b"] }]);
    const assistantConfig = new InMemoryAssistantConfigRepository();
    await assistantConfig.save({
      targetId: target.id,
      modelId: configuredId,
      reservationMinutes: 5,
      keepaliveMinutes: 2,
      requestTimeoutSeconds: 30
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "answer_question", arguments: JSON.stringify({ message: "Ready." }) } }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const advisor = new ProfileAdvisorService({
      assistantConfig,
      catalog,
      reservationService: {
        listActiveOwned: async () => [],
        createForUser: vi.fn(async () => ({ id: "assistant-reservation" })),
        markDone: vi.fn(),
        extend: vi.fn()
      } as never,
      statuses: {
        get: () => ({ targetId: target.id, desired: "on", observed: "healthy", message: "Ready" }),
        set: vi.fn(),
        list: () => []
      },
      capacityProvider: {
        getTargetStatus: vi.fn(async () => ({ observed: "healthy" as const, message: "Ready" })),
        provisionTarget: vi.fn(),
        ensureTargetOn: vi.fn(),
        ensureTargetOff: vi.fn(),
        forceStopTarget: vi.fn()
      },
      availableDomains: () => [],
      availableDeployments: () => [],
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined
    });

    await expect(advisor.configuration()).resolves.toMatchObject({ config: { modelId: discoveredId } });
    await expect(advisor.interpret("Are you ready?")).resolves.toEqual({ type: "answer", message: "Ready." });
    const completionBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(completionBody.model).toBe(discoveredId);
    expect(completionBody.messages[0].content).toContain("supersedes catalog claims in prior conversation");

    await expect(advisor.saveConfiguration({
      targetId: target.id,
      modelId: configuredId,
      reservationMinutes: 5,
      keepaliveMinutes: 2,
      requestTimeoutSeconds: 30
    })).resolves.toMatchObject({ modelId: discoveredId });
  });
});
