import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateApiKey, ApiKeyService } from "../services/ApiKeyService.js";
import type { AuthenticatedUser } from "../domain/types.js";
import { SqliteApiKeyRepository } from "../repository/SqliteApiKeyRepository.js";
import { SqliteCapacityProviderRepository } from "../repository/SqliteCapacityProviderRepository.js";
import { SqliteCapacityTargetRepository } from "../repository/SqliteCapacityTargetRepository.js";
import { SqliteReservationRepository } from "../repository/SqliteReservationRepository.js";
import { SqliteTargetModelDiscoveryRepository } from "../repository/SqliteTargetModelDiscoveryRepository.js";
import { SqliteTargetProvisioningJobRepository } from "../repository/SqliteTargetProvisioningJobRepository.js";

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
      status: "active"
    });
    expect(await second.listActive(new Date("2026-06-27T12:30:00.000Z"))).toHaveLength(1);
    second.close();
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
