import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeCapacityProvider } from "../capacity/CompositeCapacityProvider.js";
import { loadConfig } from "../config/loadConfig.js";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

const managedEnv = [
  "CAPACITY_PROVIDERS_JSON",
  "CAPACITY_TARGETS_JSON",
  "CAPACITY_TARGET_KEYS",
  "CAPACITY_TARGET_GPU_DISPLAY_NAME",
  "CAPACITY_TARGET_GPU_PROVIDER",
  "CAPACITY_TARGET_GPU_MODEL_IDS",
  "CAPACITY_TARGET_GPU_ESTIMATED_HOURLY_COST_USD",
  "CAPACITY_TARGET_GPU_AUDIENCE_SCOPE",
  "CAPACITY_TARGET_GPU_AUDIENCE_TEAM_IDS",
  "LITELLM_UI_URL",
  "CAPACITY_TARGETS_FILE",
  "CAPACITY_TARGET_EC2_GPU_DISPLAY_NAME",
  "CAPACITY_TARGET_EC2_GPU_PROVIDER",
  "CAPACITY_TARGET_EC2_GPU_AWS_INSTANCE_ID",
  "CAPACITY_TARGET_EC2_GPU_AWS_RUNTIME_PORT",
  "CAPACITY_TARGET_EC2_GPU_AWS_RUNTIME_PROTOCOL",
  "CAPACITY_TARGET_EC2_GPU_AWS_HEALTH_PATH",
  "CAPACITY_TARGET_EC2_GPU_AWS_API_PATH",
  "CAPACITY_TARGET_EC2_GPU_LITELLM_CREDENTIAL_NAME",
  "CAPACITY_TARGET_EC2_GPU_LITELLM_API_KEY_ENV",
  "CAPACITY_TARGET_EC2_GPU_LITELLM_SYNC_DISCOVERED_MODELS",
  "CAPACITY_PROVIDER_KEYS",
  "CAPACITY_PROVIDER_AWS_MAIN_ID",
  "CAPACITY_PROVIDER_AWS_MAIN_DISPLAY_NAME",
  "CAPACITY_PROVIDER_AWS_MAIN_TYPE",
  "CAPACITY_PROVIDER_AWS_MAIN_AWS_EC2_INSTANCE_NAME_PATTERN",
  "RUNTIME_PROFILES_JSON",
  "RECONCILER_INTERVAL_SECONDS",
  "RESERVATION_STATUS_POLL_SECONDS",
  "ADMIN_STATUS_POLL_SECONDS",
  "NEURON_BUILD_SHA",
  "NEURON_UPDATE_CHECK_ENABLED",
  "NEURON_UPDATE_REPOSITORY",
  "NEURON_UPDATE_CHECK_SECONDS",
  "CONTROL_PLANE_MAINTENANCE_MODE",
  "CONTROL_PLANE_FORCE_MAINTENANCE_MODE",
  "CONTROL_PLANE_MAINTENANCE_STATE_PATH",
  "STORAGE_OPERATION_LOCK_PATH",
  "SHARED_PASSWORD_ENABLED",
  "SHARED_PASSWORD"
];

afterEach(() => {
  for (const key of managedEnv) delete process.env[key];
  vi.restoreAllMocks();
});

describe("provider definitions", () => {
  it("uses responsive scheduling and UI polling defaults", async () => {
    delete process.env.RECONCILER_INTERVAL_SECONDS;
    delete process.env.RESERVATION_STATUS_POLL_SECONDS;
    delete process.env.ADMIN_STATUS_POLL_SECONDS;

    const { config } = await loadConfig();

    expect(config.reconcilerIntervalSeconds).toBe(10);
    expect(config.reservationStatusPollSeconds).toBe(5);
    expect(config.adminStatusPollSeconds).toBe(5);
  });

  it("does not expose the retired shared-password configuration", async () => {
    process.env.SHARED_PASSWORD_ENABLED = "true";
    process.env.SHARED_PASSWORD = "legacy-value";

    const { config } = await loadConfig();

    expect(config).not.toHaveProperty("sharedPasswordEnabled");
    expect(config).not.toHaveProperty("sharedPassword");
  });

  it("enables update checks for revision-stamped published images", async () => {
    process.env.NEURON_BUILD_SHA = "abcdef1234567890";
    process.env.NEURON_UPDATE_REPOSITORY = "example/neuron";
    process.env.NEURON_UPDATE_CHECK_SECONDS = "300";

    const { config } = await loadConfig();

    expect(config.updates).toEqual({
      enabled: true,
      repository: "example/neuron",
      currentRevision: "abcdef1234567890",
      checkIntervalSeconds: 300,
      githubToken: undefined
    });
  });

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

  it("loads target cost estimate settings from env-expanded target config", async () => {
    process.env.CAPACITY_TARGET_KEYS = "GPU";
    process.env.CAPACITY_TARGET_GPU_DISPLAY_NAME = "GPU Pool";
    process.env.CAPACITY_TARGET_GPU_PROVIDER = "fake";
    process.env.CAPACITY_TARGET_GPU_MODEL_IDS = "m1";
    process.env.CAPACITY_TARGET_GPU_ESTIMATED_HOURLY_COST_USD = "3.25";

    const { config } = await loadConfig();

    expect(config.capacityTargets[0]).toMatchObject({
      id: "gpu",
      costEstimate: { hourlyUsd: 3.25 }
    });
  });

  it("loads an exact LiteLLM UI destination and target audience from environment configuration", async () => {
    process.env.LITELLM_UI_URL = "https://litellm.example.test/tools/playground";
    process.env.CAPACITY_TARGET_KEYS = "GPU";
    process.env.CAPACITY_TARGET_GPU_DISPLAY_NAME = "GPU Pool";
    process.env.CAPACITY_TARGET_GPU_PROVIDER = "fake";
    process.env.CAPACITY_TARGET_GPU_MODEL_IDS = "m1";
    process.env.CAPACITY_TARGET_GPU_AUDIENCE_SCOPE = "teams";
    process.env.CAPACITY_TARGET_GPU_AUDIENCE_TEAM_IDS = "team-platform,team-research";

    const { config } = await loadConfig();

    expect(config.litellmUiUrl).toBe("https://litellm.example.test/tools/playground");
    expect(config.capacityTargets[0]?.audience).toEqual({ scope: "teams", teamIds: ["team-platform", "team-research"] });
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
      getTargetCostEstimate: async (target) => {
        captured.push(target);
        return { hourlyUsd: 0.69 };
      },
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

    const costEstimate = await composite.getTargetCostEstimate({
      id: "runpod-qwen",
      displayName: "RunPod Qwen",
      provider: "runpod",
      providerId: "runpod-main",
      modelIds: ["qwen"],
      runpod: { podId: "pod-qwen", runtimePort: 8080 }
    });

    expect(costEstimate).toEqual({ hourlyUsd: 0.69 });
    expect(captured[1].runpod).toEqual(captured[0].runpod);
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

  it("dispatches aws-ec2 provider definitions to the EC2 adapter key", async () => {
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
      { "aws-ec2": awsProvider },
      [{ id: "aws-main", displayName: "AWS Main", type: "aws-ec2", config: {} }]
    );

    await composite.ensureTargetOn({
      id: "gpu-instance",
      displayName: "GPU Instance",
      provider: "aws-ec2",
      providerId: "aws-main",
      modelIds: ["qwen"],
      aws: { instanceId: "i-1234567890abcdef0" }
    });

    expect(captured[0]).toMatchObject({
      provider: "aws-ec2",
      aws: { instanceId: "i-1234567890abcdef0" }
    });
  });

  it("loads AWS EC2 targets from environment variables", async () => {
    process.env.CAPACITY_TARGET_KEYS = "EC2_GPU";
    process.env.CAPACITY_TARGET_EC2_GPU_DISPLAY_NAME = "EC2 GPU";
    process.env.CAPACITY_TARGET_EC2_GPU_PROVIDER = "aws-ec2";
    process.env.CAPACITY_TARGET_EC2_GPU_AWS_INSTANCE_ID = "i-1234567890abcdef0";
    process.env.CAPACITY_TARGET_EC2_GPU_AWS_RUNTIME_PORT = "9000";
    process.env.CAPACITY_TARGET_EC2_GPU_AWS_RUNTIME_PROTOCOL = "https";
    process.env.CAPACITY_TARGET_EC2_GPU_AWS_HEALTH_PATH = "/ready";
    process.env.CAPACITY_TARGET_EC2_GPU_AWS_API_PATH = "/openai/v1";
    process.env.CAPACITY_TARGET_EC2_GPU_LITELLM_CREDENTIAL_NAME = "neuron/ec2-gpu";
    process.env.CAPACITY_TARGET_EC2_GPU_LITELLM_API_KEY_ENV = "PREFER_EC2_GPU_API_KEY";
    process.env.CAPACITY_TARGET_EC2_GPU_LITELLM_SYNC_DISCOVERED_MODELS = "false";

    const { config } = await loadConfig();

    expect(config.capacityTargets[0]).toMatchObject({
      id: "ec2-gpu",
      displayName: "EC2 GPU",
      provider: "aws-ec2",
      providerId: "aws-ec2",
      aws: {
        instanceId: "i-1234567890abcdef0",
        runtimePort: 9000,
        runtimeProtocol: "https",
        healthPath: "/ready",
        apiPath: "/openai/v1"
      },
      litellm: {
        credentialName: "neuron/ec2-gpu",
        apiKeyEnv: "PREFER_EC2_GPU_API_KEY",
        syncDiscoveredModels: false
      }
    });
  });

  it("loads the AWS EC2 provider instance discovery pattern from expanded environment config", async () => {
    process.env.CAPACITY_PROVIDER_KEYS = "AWS_MAIN";
    process.env.CAPACITY_PROVIDER_AWS_MAIN_ID = "aws-main";
    process.env.CAPACITY_PROVIDER_AWS_MAIN_DISPLAY_NAME = "AWS Main";
    process.env.CAPACITY_PROVIDER_AWS_MAIN_TYPE = "aws-ec2";
    process.env.CAPACITY_PROVIDER_AWS_MAIN_AWS_EC2_INSTANCE_NAME_PATTERN = "*.prefer.*";

    const { config } = await loadConfig();

    expect(config.capacityProviders).toMatchObject([{
      id: "aws-main",
      type: "aws-ec2",
      config: { awsEc2: { instanceNamePattern: "*.prefer.*" } }
    }]);
  });

  it("resolves AWS EC2 target validation through a provider ID", async () => {
    process.env.CAPACITY_PROVIDERS_JSON = JSON.stringify([
      { id: "aws-main", displayName: "AWS Main", type: "aws-ec2" }
    ]);
    process.env.CAPACITY_TARGETS_JSON = JSON.stringify([
      {
        id: "ec2-gpu",
        displayName: "EC2 GPU",
        providerId: "aws-main",
        modelIds: [],
        aws: { instanceId: "i-1234567890abcdef0" }
      }
    ]);

    const { config } = await loadConfig();

    expect(config.capacityTargets[0]).toMatchObject({
      provider: "aws-ec2",
      providerId: "aws-main",
      aws: { instanceId: "i-1234567890abcdef0" }
    });
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
