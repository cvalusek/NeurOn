import { describe, expect, it } from "vitest";
import type { CapacityTarget, ModelDefinition } from "../domain/types.js";
import { InMemoryModelMetadataRepository } from "../repository/InMemoryModelMetadataRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelSelectionService } from "../services/ModelSelectionService.js";

describe("model selection startup metadata", () => {
  it("ignores persisted metadata for stale runtime IDs without deleting it", async () => {
    const target: CapacityTarget = { id: "small", displayName: "Small", provider: "docker", modelIds: ["fast"] };
    const model: ModelDefinition = { id: "fast", displayName: "Fast", aliases: ["fast"], targetIds: [target.id] };
    const repository = new InMemoryModelMetadataRepository();
    await repository.upsertCapability({ modelId: "fast", intelligence: 62 });
    await repository.upsertCapability({ modelId: "runtime-id-from-an-old-discovery", intelligence: 70 });
    await repository.upsertDeployment({ targetId: "missing-target", modelId: "runtime-id-from-an-old-discovery" });
    const service = new ModelSelectionService(
      new ModelCatalog([model], [target]),
      { schemaVersion: 1, models: [], deployments: [] },
      repository
    );

    await expect(service.initialize()).resolves.toBeUndefined();

    expect(service.catalogConfig().models).toEqual([expect.objectContaining({ modelId: "fast", intelligence: 62 })]);
    expect(service.catalogConfig().deployments).toEqual([]);
    expect((await repository.listCapabilities()).map((value) => value.modelId)).toEqual([
      "fast",
      "runtime-id-from-an-old-discovery"
    ]);
  });
});
