import { describe, expect, it, vi } from "vitest";
import type { RuntimeProfile } from "../domain/types.js";
import { RuntimeCatalogService } from "../services/RuntimeCatalogService.js";

const audioProfile: RuntimeProfile = {
  id: "prefer-audio",
  name: "PreFer audio.cpp",
  type: "docker",
  image: "ghcr.io/cvalusek/prefer:audio-cuda12",
  catalog: {
    pluginId: "prefer",
    engine: "audio.cpp",
    repository: "cvalusek/PreFer",
    inventoryPath: "docker/audio-cpp/deployment-inventory.generated.json",
    schemaVersion: "prefer.audio-deployment-inventory.v1",
    imageRepository: "ghcr.io/cvalusek/prefer"
  }
};

const revision = "8e7430a3faa43c8319edd276556ad8a05ca3e54b";

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "prefer.audio-deployment-inventory.v1",
    catalog_fingerprint: "99c6b5256b18b00f5198374280a370a3ac0ec318c8d663b4402e8785d5a17fa2",
    deployments: [
      {
        id: "runpod/rtx-4090/qwen-audio",
        provider: "runpod",
        image_tag: "audio-cuda12",
        description: "One audio model per GPU",
        capabilities: ["speech"],
        hardware: { provider_gpu_type_id: "NVIDIA GeForce RTX 4090", gpu_count: 1, vram_gb_each: 24, advertised_hourly_usd_per_gpu: 0.74 },
        container: { internal_port: 8090, health_path: "/ready" },
        environment: { AUDIO_CONFIG: "/configs/qwen-asr.ini" },
        models: [
          { request_model_id: "qwen3-asr-0.6b", task: "asr", family: "qwen3-audio", context_per_request: 50_000 },
          { request_model_id: "qwen3-tts", task: "tts", family: "qwen3-audio" }
        ]
      },
      {
        id: "aws/g6e/qwen-audio",
        provider: "aws",
        image_tag: "audio-cuda12",
        hardware: { provider_sku: "g6e.xlarge", gpu_count: 1, vram_gb_each: 48 },
        container: { internal_port: 8080, health_path: "/health" },
        environment: {},
        models: [{ request_model_id: "personaplex", task: "s2s" }]
      }
    ],
    ...overrides
  };
}

describe("RuntimeCatalogService", () => {
  it("loads a pinned raw catalog once, presents provider choices, and resolves an immutable plan", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog()), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new RuntimeCatalogService(fetchImpl as typeof fetch);

    const first = await service.list(audioProfile, revision, "runpod");
    const second = await service.list(audioProfile, revision, "runpod");
    const plan = await service.resolve(audioProfile, revision, "runpod", "runpod/rtx-4090/qwen-audio");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://raw.githubusercontent.com/cvalusek/PreFer/${revision}/docker/audio-cpp/deployment-inventory.generated.json`,
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
    expect(second).toEqual(first);
    expect(first).toEqual([expect.objectContaining({
      id: "runpod/rtx-4090/qwen-audio",
      engine: "audio.cpp",
      providerType: "runpod",
      modelCount: 2,
      modelIds: ["qwen3-asr-0.6b", "qwen3-tts"],
      gpuCount: 1,
      vramGbEach: 24
    })]);
    expect(plan).toMatchObject({
      pluginId: "prefer",
      pluginVersion: revision,
      catalogSchemaVersion: "prefer.audio-deployment-inventory.v1",
      catalogFingerprint: "99c6b5256b18b00f5198374280a370a3ac0ec318c8d663b4402e8785d5a17fa2",
      providerType: "runpod",
      image: "ghcr.io/cvalusek/prefer:audio-cuda12-sha-8e7430a",
      port: 8090,
      healthPath: "/ready",
      apiPath: "/v1",
      environment: { AUDIO_CONFIG: "/configs/qwen-asr.ini" },
      models: [
        expect.objectContaining({ id: "qwen3-asr-0.6b", contextWindowTokens: 50_000, technicalCapabilities: [{ label: "speech-to-text", title: "Speech to text" }] }),
        expect.objectContaining({ id: "qwen3-tts", technicalCapabilities: [{ label: "text-to-speech", title: "Text to speech" }] })
      ]
    });
  });

  it("maps the NeurOn AWS provider to catalog AWS entries", async () => {
    const service = new RuntimeCatalogService(async () => new Response(JSON.stringify(catalog()), { status: 200 }));
    await expect(service.list(audioProfile, revision, "aws-ec2")).resolves.toEqual([
      expect.objectContaining({ id: "aws/g6e/qwen-audio", providerType: "aws-ec2", hardwareLabel: "g6e.xlarge" })
    ]);
  });

  it("fails closed for incompatible schemas, duplicate IDs, provider mismatches, and unpinned revisions", async () => {
    await expect(new RuntimeCatalogService(async () => new Response(JSON.stringify(catalog({ schema_version: "future" })), { status: 200 })).list(audioProfile, revision, "runpod")).rejects.toThrow(/incompatible/);
    await expect(new RuntimeCatalogService(async () => new Response(JSON.stringify(catalog({ catalog_fingerprint: "not-a-fingerprint" })), { status: 200 })).list(audioProfile, revision, "runpod")).rejects.toThrow(/fingerprint/);
    await expect(new RuntimeCatalogService(async () => new Response(JSON.stringify(catalog({ deployments: [catalog().deployments[0], catalog().deployments[0]] })), { status: 200 })).list(audioProfile, revision, "runpod")).rejects.toThrow(/duplicate deployment/);
    await expect(new RuntimeCatalogService(async () => new Response(JSON.stringify(catalog()), { status: 200 })).resolve(audioProfile, revision, "runpod", "aws/g6e/qwen-audio")).rejects.toThrow(/not compatible/);
    await expect(new RuntimeCatalogService().list(audioProfile, "8e7430a", "runpod")).rejects.toThrow(/full 40-character commit SHA/);
  });
});
