import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateApiKey, ApiKeyService } from "../services/ApiKeyService.js";
import type { AuthenticatedUser } from "../domain/types.js";
import { SqliteApiKeyRepository } from "../repository/SqliteApiKeyRepository.js";
import { SqliteCapacityProviderRepository } from "../repository/SqliteCapacityProviderRepository.js";
import { SqliteCapacityTargetRepository } from "../repository/SqliteCapacityTargetRepository.js";
import { SqliteReservationRepository } from "../repository/SqliteReservationRepository.js";
import { SqliteTargetModelDiscoveryRepository } from "../repository/SqliteTargetModelDiscoveryRepository.js";
import { SqliteTargetProvisioningJobRepository } from "../repository/SqliteTargetProvisioningJobRepository.js";
import { SqliteTargetActivationRepository } from "../repository/SqliteTargetActivationRepository.js";
import { SqliteModelMetadataRepository } from "../repository/SqliteModelMetadataRepository.js";
import { SqliteModelFavoriteRepository } from "../repository/SqliteModelFavoriteRepository.js";
import { SqliteAssistantConfigRepository } from "../repository/SqliteAssistantConfigRepository.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("SqliteReservationRepository", () => {
  it("persists active reservations across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const first = new SqliteReservationRepository(databasePath);
    const reservation = await first.create({
      username: "clint",
      apiKeyName: "OpenCode",
      modelIds: ["m1"],
      targetIds: ["t1"],
      targetSelections: [{ targetId: "t1", modelIds: ["m1"] }],
      createdAt: new Date("2026-06-27T12:00:00.000Z"),
      expiresAt: new Date("2026-06-27T13:00:00.000Z"),
      keepaliveMinutes: 2,
      status: "active"
    });
    first.close();

    const second = new SqliteReservationRepository(databasePath);
    expect(await second.get(reservation.id)).toMatchObject({
      id: reservation.id,
      username: "clint",
      apiKeyName: "OpenCode",
      modelIds: ["m1"],
      targetIds: ["t1"],
      targetSelections: [{ targetId: "t1", modelIds: ["m1"] }],
      status: "active"
    });
    expect(await second.listActive(new Date("2026-06-27T12:30:00.000Z"))).toHaveLength(1);
    second.close();
  });

  it("fails closed when persisted target selections have an invalid shape", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const repository = new SqliteReservationRepository(databasePath);
    const reservation = await repository.create({
      username: "clint", modelIds: ["m1"], targetIds: ["t1"], createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: "active"
    });
    repository.close();
    const database = new Database(databasePath);
    database.prepare("update reservations set target_selections = ? where id = ?").run(JSON.stringify({ targetId: "t1", modelIds: ["m1"] }), reservation.id);
    database.close();

    const reopened = new SqliteReservationRepository(databasePath);
    await expect(reopened.get(reservation.id)).rejects.toThrow("SQLite reservation target_selections must be an array");
    reopened.close();
  });
});

describe("SqliteApiKeyRepository", () => {
  it("persists API keys across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const user: AuthenticatedUser = { username: "clint", isAdmin: true };

    const first = new SqliteApiKeyRepository(databasePath);
    const created = await new ApiKeyService(first).createForUser(user, { name: "Plugin key" });
    first.close();

    const second = new SqliteApiKeyRepository(databasePath);
    const authenticated = await authenticateApiKey(second, created.token, () => true);
    const keys = await second.listForUser("clint");
    second.close();

    expect(authenticated).toEqual({ ...user, apiKeyName: "Plugin key" });
    expect(keys).toMatchObject([{ id: created.key.id, name: "Plugin key", prefix: created.key.prefix }]);
  });
});

describe("SqliteCapacityProviderRepository", () => {
  it("persists provider definitions across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");

    const first = new SqliteCapacityProviderRepository(databasePath);
    await first.create({
      id: "runpod-main",
      displayName: "RunPod Main",
      type: "runpod",
      config: { runpod: { apiKeyEnv: "RUNPOD_MAIN_KEY" } }
    });
    first.close();

    const second = new SqliteCapacityProviderRepository(databasePath);
    const providers = await second.list();
    second.close();

    expect(providers).toMatchObject([
      {
        id: "runpod-main",
        displayName: "RunPod Main",
        type: "runpod",
        config: { runpod: { apiKeyEnv: "RUNPOD_MAIN_KEY" } }
      }
    ]);
  });
});

describe("SqliteCapacityTargetRepository", () => {
  it("persists target definitions across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");

    const first = new SqliteCapacityTargetRepository(databasePath);
    await first.create({
      id: "runpod-qwen",
      displayName: "RunPod Qwen",
      provider: "runpod",
      providerId: "runpod-main",
      modelIds: ["qwen"],
      runpod: { podId: "pod-qwen", runtimePort: 8080 }
    });
    first.close();

    const second = new SqliteCapacityTargetRepository(databasePath);
    const targets = await second.list();
    second.close();

    expect(targets).toMatchObject([
      {
        id: "runpod-qwen",
        displayName: "RunPod Qwen",
        provider: "runpod",
        providerId: "runpod-main",
        modelIds: ["qwen"],
        runpod: { podId: "pod-qwen", runtimePort: 8080 }
      }
    ]);
  });
});

describe("SqliteTargetProvisioningJobRepository", () => {
  it("persists target provisioning jobs across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const createdAt = new Date("2026-06-28T12:00:00.000Z");

    const first = new SqliteTargetProvisioningJobRepository(databasePath);
    await first.create({
      id: "job-1",
      status: "draft",
      providerId: "runpod-main",
      providerType: "runpod",
      runtimeProfileId: "prefer",
      targetId: "runpod-prefer",
      targetDraft: { id: "runpod-prefer", displayName: "RunPod PreFer", provider: "runpod", providerId: "runpod-main", modelIds: [], runpod: { runtimePort: 8080 } },
      createdResources: [],
      createdAt,
      updatedAt: createdAt
    });
    first.close();

    const second = new SqliteTargetProvisioningJobRepository(databasePath);
    const job = await second.getForTarget("runpod-prefer");
    second.close();

    expect(job).toMatchObject({
      id: "job-1",
      status: "draft",
      providerId: "runpod-main",
      providerType: "runpod",
      runtimeProfileId: "prefer",
      targetId: "runpod-prefer"
    });
    expect(job?.createdAt).toEqual(createdAt);
  });
});

describe("SqliteTargetActivationRepository", () => {
  it("persists target activations and reservation cost links across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const reservationRepository = new SqliteReservationRepository(databasePath);
    const reservation = await reservationRepository.create({
      username: "clint",
      modelIds: ["m1"],
      targetIds: ["t1"],
      createdAt: new Date("2026-06-27T12:00:00.000Z"),
      expiresAt: new Date("2026-06-27T13:00:00.000Z"),
      status: "active"
    });
    reservationRepository.close();

    const first = new SqliteTargetActivationRepository(databasePath);
    const activation = await first.createActivation({
      targetId: "t1",
      startedAt: new Date("2026-06-27T12:00:00.000Z"),
      status: "open",
      estimatedHourlyCostUsd: 4,
      estimatedCostUsd: 0,
      lastCostedAt: new Date("2026-06-27T12:00:00.000Z")
    });
    await first.addReservationCost({
      targetActivationId: activation.id,
      reservationId: reservation.id,
      at: new Date("2026-06-27T12:00:00.000Z"),
      estimatedCostUsd: 2
    });
    await first.updateActivation(activation.id, { status: "closed", endedAt: new Date("2026-06-27T12:30:00.000Z"), estimatedCostUsd: 2 });
    first.close();

    const second = new SqliteTargetActivationRepository(databasePath);
    expect(await second.getOpenActivationForTarget("t1")).toBeUndefined();
    expect(await second.listActivationsForTarget("t1")).toMatchObject([{ id: activation.id, status: "closed", estimatedCostUsd: 2 }]);
    expect(await second.listReservationAllocations(reservation.id)).toMatchObject([{ targetActivationId: activation.id, reservationId: reservation.id, estimatedCostUsd: 2 }]);
    second.close();
  });
});

describe("SqliteTargetModelDiscoveryRepository", () => {
  it("persists discovered target models across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const discoveredAt = new Date("2026-06-29T12:00:00.000Z");

    const first = new SqliteTargetModelDiscoveryRepository(databasePath);
    await first.record({
      targetId: "prefer-local",
      discoveredAt,
      models: [
        {
          id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
          aliases: ["qwen-3.6"],
          meta: { n_ctx: 202_752 }
        }
      ]
    });
    first.close();

    const second = new SqliteTargetModelDiscoveryRepository(databasePath);
    const record = await second.get("prefer-local");
    second.close();

    expect(record).toMatchObject({
      targetId: "prefer-local",
      discoveredAt,
      models: [
        {
          id: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q6_K_XL",
          aliases: ["qwen-3.6"],
          meta: { n_ctx: 202_752 }
        }
      ]
    });
  });
});

describe("SqliteAssistantConfigRepository", () => {
  it("persists one independent assistant deployment", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const targets = new SqliteCapacityTargetRepository(databasePath);
    await targets.create({ id: "advisor-target", displayName: "Advisor", provider: "docker", modelIds: ["advisor-model"] });
    targets.close();
    const updatedAt = new Date("2026-08-15T12:00:00.000Z");
    const first = new SqliteAssistantConfigRepository(databasePath);
    await first.save({ targetId: "advisor-target", modelId: "advisor-model", reservationMinutes: 15, keepaliveMinutes: 5, requestTimeoutSeconds: 120, updatedAt });
    first.close();
    const second = new SqliteAssistantConfigRepository(databasePath);
    expect(await second.get()).toEqual({ id: "default", targetId: "advisor-target", modelId: "advisor-model", reservationMinutes: 15, keepaliveMinutes: 5, requestTimeoutSeconds: 120, updatedAt });
    second.close();
  });

  it("moves legacy target JSON into the independent record and strips the embedded copy", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const targets = new SqliteCapacityTargetRepository(databasePath);
    await targets.create({ id: "legacy-target", displayName: "Legacy", provider: "docker", modelIds: ["legacy-model"] });
    targets.close();
    const db = new Database(databasePath);
    const row = db.prepare("select target_json from capacity_targets where id = ?").get("legacy-target") as { target_json: string };
    const target = { ...(JSON.parse(row.target_json) as Record<string, unknown>), profileAdvisor: { modelId: "legacy-model", reservationMinutes: 12, startupTimeoutSeconds: 300, requestTimeoutSeconds: 90 } };
    db.prepare("update capacity_targets set target_json = ? where id = ?").run(JSON.stringify(target), "legacy-target");
    db.close();

    const assistant = new SqliteAssistantConfigRepository(databasePath);
    expect(await assistant.get()).toMatchObject({ targetId: "legacy-target", modelId: "legacy-model", reservationMinutes: 12, keepaliveMinutes: 12, requestTimeoutSeconds: 90 });
    assistant.close();
    const reopenedTargets = new SqliteCapacityTargetRepository(databasePath);
    expect(await reopenedTargets.get("legacy-target")).not.toHaveProperty("profileAdvisor");
    reopenedTargets.close();
  });
});

describe("SQLite model-selection repositories", () => {
  it("persists model facts and user favorites across repository restarts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "neuron-sqlite-"));
    const databasePath = path.join(tempDir, "neuron.db");
    const updatedAt = new Date("2026-08-10T14:30:00.000Z");
    const metadata = new SqliteModelMetadataRepository(databasePath);
    const favorites = new SqliteModelFavoriteRepository(databasePath);
    await metadata.upsertCapability({ modelId: "model-1", intelligence: 87, domains: { coding: 92 }, quantization: { format: "Q6", qualityRetentionPercent: 98.5 }, provenance: { source: "manual", version: "2026-08" } }, updatedAt);
    await metadata.upsertDeployment({ targetId: "target-1", modelId: "model-1", performance: { decodeTokensPerSecond: 42, prefillTokensPerSecond: 800, sampleCount: 3 } }, updatedAt);
    await favorites.add({ username: "clint", targetId: "target-1", modelId: "model-1", createdAt: updatedAt });
    metadata.close(); favorites.close();

    const reopenedMetadata = new SqliteModelMetadataRepository(databasePath);
    const reopenedFavorites = new SqliteModelFavoriteRepository(databasePath);
    expect(await reopenedMetadata.listCapabilities()).toMatchObject([{ modelId: "model-1", intelligence: 87, domains: { coding: 92 }, quantization: { format: "Q6", qualityRetentionPercent: 98.5 }, updatedAt }]);
    expect(await reopenedMetadata.listDeployments()).toMatchObject([{ targetId: "target-1", modelId: "model-1", performance: { decodeTokensPerSecond: 42 }, updatedAt }]);
    expect(await reopenedFavorites.listForUser("clint")).toEqual([{ username: "clint", targetId: "target-1", modelId: "model-1", createdAt: updatedAt }]);
    reopenedMetadata.close(); reopenedFavorites.close();
  });
});
