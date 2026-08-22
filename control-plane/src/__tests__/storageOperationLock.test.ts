import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageOperationLock } from "../repository/StorageOperationLock.js";
import { resolveStorageOperationLockPath } from "../config/loadConfig.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("StorageOperationLock", () => {
  it("derives the application and offline-tool lock beside a custom SQLite database", () => {
    const databasePath = path.resolve("custom-data", "control.db");
    expect(resolveStorageOperationLockPath({ driver: "sqlite", path: databasePath })).toBe(path.join(path.dirname(databasePath), "neuron-storage.lock"));
    expect(resolveStorageOperationLockPath({ driver: "sqlite", path: databasePath }, "explicit.lock")).toBe(path.resolve("explicit.lock"));
  });

  it("rejects a concurrent live owner and releases only its own lock", async () => {
    const lockPath = await temporaryLockPath();
    const first = await StorageOperationLock.acquire(lockPath, "first", { staleAfterMs: 2_000, heartbeatIntervalMs: 100 });
    await expect(StorageOperationLock.acquire(lockPath, "second", { staleAfterMs: 2_000, heartbeatIntervalMs: 100 })).rejects.toThrow("Refusing concurrent");
    await first.release();
    const second = await StorageOperationLock.acquire(lockPath, "second", { staleAfterMs: 2_000, heartbeatIntervalMs: 100 });
    await second.release();
  });

  it("recovers a stale crash marker without operator deletion", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, JSON.stringify({ owner: "crashed-app", token: "old", acquiredAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);

    const recovered = await StorageOperationLock.acquire(lockPath, "replacement", { staleAfterMs: 2_000, heartbeatIntervalMs: 100 });
    await recovered.release();
  });

  it("fails closed on a recent malformed marker", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, "incomplete", "utf8");
    await expect(StorageOperationLock.acquire(lockPath, "replacement", { staleAfterMs: 2_000, heartbeatIntervalMs: 100 })).rejects.toThrow("Refusing concurrent");
  });
});

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-storage-lock-"));
  directories.push(directory);
  return path.join(directory, "neuron-storage.lock");
}
