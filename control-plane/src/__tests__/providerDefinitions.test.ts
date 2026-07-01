import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeCapacityProvider } from "../capacity/CompositeCapacityProvider.js";
import { loadConfig } from "../config/loadConfig.js";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

const managedEnv = [
  "CAPACITY_PROVIDERS_JSON",
  "CAPACITY_TARGETS_JSON",
  "CAPACITY_TARGET_KEYS",
  "CAPACITY_TARGETS_FILE",
  "RUNTIME_PROFILES_JSON",
  "SHARED_PASSWORD"
];

afterEach(() => {
  for (const key of managedEnv) delete process.env[key];
  vi.restoreAllMocks();
});

describe("provider definitions", () => {
  it("loads reusable providers and lets targets reference provider IDs", async () => {
    process.env.CAPACITY_PROVIDERS_JSON = JSON.stringify([
      {
        id: "runpod-main",
        displayName: "RunPod Main",
        type: "runpod",
        config: { runpod: { apiKeyEnv: "RUNPOD_MAIN_KEY", apiBaseUrl: "https://rest.runpod.io/v1" } }
      }
    ]);
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([
      {
        id: "runpod-qwen",
        displayName: "RunPod Qwen",
        providerId: "runpod-main",
        modelIds: ["qwen"],
        runpod: { podId: "pod-qwen", runtimePort: 8080 }
      }
    ]);

    const { config } = await loadConfig();

    expect(config.capacityProviders).toMatchObject([
      {
        id: "runpod-main",
        displayName: "RunPod Main",
        type: "runpod",
        config: { runpod: { apiKeyEnv: "RUNPOD_MAIN_KEY" } }
      }
    ]);
    expect(config.capacityTargets[0]).toMatchObject({
      id: "runpod-qwen",
      provider: "runpod",
      providerId: "runpod-main"
    });
  });

  it("does not materialize implicit provider rows from targets", async () => {
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([
      {
        id: "local",
        displayName: "Local",
        provider: "docker",
        modelIds: []
      }
    ]);

    const { config } = await loadConfig();

    expect(config.capacityProviders).toEqual([]);
    expect(config.capacityTargets[0]).toMatchObject({
      id: "local",
      provider: "docker",
      providerId: "docker"
    });
  });

  it("starts without configured providers or targets", async () => {
    const { config, models } = await loadConfig();

    expect(config.capacityProviders).toEqual([]);
    expect(config.capacityTargets).toEqual([]);
    expect(models).toEqual([]);
  });

  it("prefers persisted providers over same-id configured providers in admin lists", async () => {
    process.env.CAPACITY_PROVIDERS_JSON = JSON.stringify([{ id: "runpod", displayName: "RunPod Config", type: "runpod" }]);
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([]);
    const { config } = await loadConfig();
    const { ProviderCatalog } = await import("../services/ProviderCatalog.js");
    const { ProviderService } = await import("../services/ProviderService.js");
    const { InMemoryCapacityProviderRepository } = await import("../repository/InMemoryCapacityProviderRepository.js");
    const repository = new InMemoryCapacityProviderRepository();
    await repository.create({ id: "runpod", displayName: "RunPod DB", type: "runpod" });
    const service = new ProviderService(config.capacityProviders, repository, new ProviderCatalog(config.capacityProviders));

    const providers = await service.list();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "runpod", displayName: "RunPod DB", source: "persisted" });
  });


  it("materializes provider-level RunPod config before dispatching to the adapter", async () => {
    const captured: CapacityTarget[] = [];
    const runpodProvider: CapacityProvider = {
      provisionTarget: async (target) => {
        captured.push(target);
      },
      ensureTargetOn: async (target) => {
        captured.push(target);
      },
      ensureTargetOff: async () => undefined,
      getTargetStatus: async (): Promise<CapacityProviderStatus> => ({ observed: "stopped", message: "Stopped" }),
      forceStopTarget: async () => undefined
    };
    const composite = new CompositeCapacityProvider(
      { runpod: runpodProvider },
      [
        {
          id: "runpod-main",
          displayName: "RunPod Main",
          type: "runpod",
          config: { runpod: { apiKeyEnv: "RUNPOD_MAIN_KEY", apiBaseUrl: "https://rest.runpod.io/v1" } }
        }
      ]
    );

    await composite.ensureTargetOn({
      id: "runpod-qwen",
      displayName: "RunPod Qwen",
      provider: "runpod",
      providerId: "runpod-main",
      modelIds: ["qwen"],
      runpod: { podId: "pod-qwen", runtimePort: 8080 }
    });

    expect(captured[0].runpod).toEqual({
      apiKeyEnv: "RUNPOD_MAIN_KEY",
      apiBaseUrl: "https://rest.runpod.io/v1",
      podId: "pod-qwen",
      runtimePort: 8080
    });
  });

  it("syncs targets and model metadata from an upstream NeurOn provider", async () => {
    process.env.CAPACITY_PROVIDERS_JSON = JSON.stringify([
      {
        id: "upstream",
        displayName: "Upstream NeurOn",
        type: "neuron",
        config: {
          neuron: {
            apiBaseUrl: "https://neuron.example.test",
            apiKey: "secret",
            syncTargets: true
          }
        }
      }
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/status")) {
          return {
            ok: true,
            json: async () => ({
              capacityTargets: [
                {
                  id: "qwen",
                  displayName: "Qwen GPU",
                  modelIds: ["qwen"],
                  modelsMax: 2,
                  apiUrl: "https://runtime.example.test"
                }
              ]
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                id: "qwen",
                displayName: "Qwen",
                aliases: ["qwen", "qwen/latest"],
                targetIds: ["qwen"],
                contextWindowTokens: 32768
              }
            ]
          })
        };
      })
    );

    const { config, models } = await loadConfig();

    expect(config.capacityTargets[0]).toMatchObject({
      id: "upstream-qwen",
      displayName: "Qwen GPU",
      provider: "neuron",
      providerId: "upstream",
      modelIds: ["qwen"],
      modelsMax: 2,
      apiUrl: "https://runtime.example.test",
      neuron: { targetId: "qwen" }
    });
    expect(models[0]).toMatchObject({
      id: "qwen",
      displayName: "Qwen",
      aliases: ["qwen", "qwen/latest"],
      targetIds: ["upstream-qwen"],
      contextWindowTokens: 32768
    });
  });

  it("materializes provider-level NeurOn config before dispatching to the adapter", async () => {
    const captured: CapacityTarget[] = [];
    const neuronProvider: CapacityProvider = {
      provisionTarget: async () => undefined,
      ensureTargetOn: async (target) => {
        captured.push(target);
      },
      ensureTargetOff: async () => undefined,
      getTargetStatus: async (): Promise<CapacityProviderStatus> => ({ observed: "stopped", message: "Stopped" }),
      forceStopTarget: async () => undefined
    };
    const composite = new CompositeCapacityProvider(
      { neuron: neuronProvider },
      [
        {
          id: "upstream",
          displayName: "Upstream",
          type: "neuron",
          config: { neuron: { apiBaseUrl: "https://neuron.example.test", apiKeyEnv: "UPSTREAM_NEURON_KEY" } }
        }
      ]
    );

    await composite.ensureTargetOn({
      id: "upstream-qwen",
      displayName: "Upstream Qwen",
      provider: "neuron",
      providerId: "upstream",
      modelIds: ["qwen"],
      neuron: { targetId: "qwen" }
    });

    expect(captured[0].neuronProvider).toEqual({
      apiBaseUrl: "https://neuron.example.test",
      apiKeyEnv: "UPSTREAM_NEURON_KEY"
    });
  });

  it("dispatches aws-ecs-asg provider definitions to the existing AWS adapter key", async () => {
    const captured: CapacityTarget[] = [];
    const awsProvider: CapacityProvider = {
      provisionTarget: async () => undefined,
      ensureTargetOn: async (target) => {
        captured.push(target);
      },
      ensureTargetOff: async () => undefined,
      getTargetStatus: async (): Promise<CapacityProviderStatus> => ({ observed: "stopped", message: "Stopped" }),
      forceStopTarget: async () => undefined
    };
    const composite = new CompositeCapacityProvider(
      { "aws-ecs": awsProvider },
      [{ id: "aws-main", displayName: "AWS Main", type: "aws-ecs-asg", config: {} }]
    );

    await composite.ensureTargetOn({
      id: "gpu-pool",
      displayName: "GPU Pool",
      provider: "aws-ecs-asg",
      providerId: "aws-main",
      modelIds: ["qwen"],
      aws: { cluster: "cluster", service: "service", autoScalingGroupName: "asg" }
    });

    expect(captured[0].provider).toBe("aws-ecs");
  });

  it("requires providers to explicitly allow resource provisioning", async () => {
    let provisioned = false;
    const runpodProvider: CapacityProvider = {
      provisionTarget: async () => {
        provisioned = true;
      },
      ensureTargetOn: async () => undefined,
      ensureTargetOff: async () => undefined,
      getTargetStatus: async (): Promise<CapacityProviderStatus> => ({ observed: "stopped", message: "Stopped" }),
      forceStopTarget: async () => undefined
    };
    const target: CapacityTarget = {
      id: "runpod-qwen",
      displayName: "RunPod Qwen",
      provider: "runpod",
      providerId: "runpod-main",
      modelIds: [],
      runpod: { create: { name: "qwen" } }
    };

    await expect(
      new CompositeCapacityProvider({ runpod: runpodProvider }, [{ id: "runpod-main", displayName: "RunPod Main", type: "runpod" }]).provisionTarget(target)
    ).rejects.toThrow("does not allow resource provisioning");

    await new CompositeCapacityProvider({ runpod: runpodProvider }, [{ id: "runpod-main", displayName: "RunPod Main", type: "runpod", provisioning: { enabled: true } }]).provisionTarget(target);

    expect(provisioned).toBe(true);
  });

  it("loads provider-neutral runtime profiles with simple defaults", async () => {
    process.env.RUNTIME_PROFILES_JSON = JSON.stringify([
      {
        id: "prefer-nightly",
        name: "PreFer Nightly",
        type: "docker",
        image: "ghcr.io/cvalusek/prefer:nightly",
        discovery: false
      }
    ]);
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([
      {
        id: "local",
        displayName: "Local",
        provider: "docker",
        modelIds: []
      }
    ]);

    const { config } = await loadConfig();

    expect(config.runtimeProfiles).toContainEqual({
      id: "prefer",
      name: "PreFer",
      type: "docker",
      image: "ghcr.io/cvalusek/prefer:latest",
      volumes: { "/models": "prefer-model-cache" },
      variants: [
        {
          id: "standard",
          name: "Standard",
          description: "Let PreFer auto-select a preset from the runtime environment"
        },
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          description: "Pin PreFer to the deepseek-v4-flash named preset",
          env: { LLAMA_ARG_MODELS_PRESET: "/presets/deepseek-v4-flash.ini" }
        },
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          description: "Pin PreFer to the glm-5.2 named preset",
          env: { LLAMA_ARG_MODELS_PRESET: "/presets/glm-5.2.ini" }
        },
        {
          id: "glm-5.2-reap",
          name: "GLM 5.2 REAP",
          description: "Pin PreFer to the glm-5.2-reap named preset",
          env: { LLAMA_ARG_MODELS_PRESET: "/presets/glm-5.2-reap.ini" }
        },
        {
          id: "smol",
          name: "Smol",
          description: "Tiny PreFer preset for automated UI tests and local smoke checks",
          env: { LLAMA_ARG_MODELS_PRESET: "/presets/smol.ini" }
        }
      ]
    });
    expect(config.runtimeProfiles).toContainEqual({
      id: "prefer-nightly",
      name: "PreFer Nightly",
      type: "docker",
      image: "ghcr.io/cvalusek/prefer:nightly",
      discovery: false
    });
  });
});
