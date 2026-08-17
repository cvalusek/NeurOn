import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelWarmupService } from "../services/ModelWarmupService.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelWarmupService", () => {
  it("warms the runtime model ID once per target lifecycle", async () => {
    const target: CapacityTarget = {
      id: "gpu-1", displayName: "GPU 1", provider: "docker", modelIds: ["catalog-model"], apiUrl: "https://runtime.example.test/v1"
    };
    const model: ModelDefinition = {
      id: "catalog-model", displayName: "Catalog model", aliases: [], targetIds: [target.id], runtimeModelIds: ["runtime/model"]
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      new Response("{}", { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const warmup = new ModelWarmupService(new ModelCatalog([model], [target]));

    await warmup.warmupTargetModels(target, [model.id]);
    await warmup.warmupTargetModels(target, [model.id]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: "runtime/model" });

    warmup.forgetTarget(target.id);
    await warmup.warmupTargetModels(target, [model.id]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
