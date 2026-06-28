import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateApiKey, ApiKeyService } from "../services/ApiKeyService.js";
import type { AuthenticatedUser } from "../domain/types.js";
import { SqliteApiKeyRepository } from "../repository/SqliteApiKeyRepository.js";
import { SqliteReservationRepository } from "../repository/SqliteReservationRepository.js";

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
