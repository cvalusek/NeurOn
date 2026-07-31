import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createReservationRepository } from "../repository/createReservationRepository.js";
import { migratePostgresSchema, POSTGRES_DATA_TABLES } from "../repository/postgresSchema.js";
import {
  createConsistentSqliteBackup,
  inspectSqliteForMigration,
  migrateSqliteToPostgres
} from "../repository/sqliteToPostgresMigration.js";
import { safeMigrationErrorMessage } from "../scripts/migrateSqliteToPostgres.js";
import { createPostgresTestSchema, postgresTestUrl } from "./postgresTestUtils.js";

const describePostgres = postgresTestUrl ? describe : describe.skip;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describePostgres("SQLite to PostgreSQL migration", () => {
  it("migrates an empty initialized source and verifies an exact rerun", async () => {
    const sqlitePath = await createEmptySqlite();
    const database = await createPostgresTestSchema();
    try {
      const first = await migrateSqliteToPostgres({ sqlitePath, pool: database.pool });
      expect(first.outcome).toBe("imported");
      expect(Object.values(first.counts).every((count) => count === 0)).toBe(true);
      const second = await migrateSqliteToPostgres({ sqlitePath, pool: database.pool });
      expect(second).toEqual({ ...first, outcome: "verified-noop" });
    } finally {
      await database.cleanup();
    }
  });

  it("preserves all durable families, terminal history, nulls, JSON, timestamps, hashes, costs, and links", async () => {
    const fixture = await createPopulatedSqlite();
    const database = await createPostgresTestSchema();
    try {
      const result = await migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: database.pool });
      expect(result.outcome).toBe("imported");
      expect(result.counts).toEqual({
        reservations: 1,
        reservationProfiles: 1,
        apiKeys: 1,
        authMethods: 1,
        capacityProviders: 1,
        capacityTargets: 1,
        targetProvisioningJobs: 1,
        targetModelDiscoveries: 1,
        targetActivations: 1,
        targetActivationReservations: 1
      });
      const migrated = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      expect(await migrated.repository.get(fixture.reservationId)).toMatchObject({ status: "failed", synthetic: true, keepaliveMinutes: undefined, failureMessage: "terminal failure" });
      expect(await migrated.reservationProfiles.get("profile-migrate")).toMatchObject({ description: undefined, defaultDurationMinutes: undefined });
      expect(await migrated.apiKeys.get("key-migrate")).toMatchObject({ keyHash: "opaque-hash-value", lastUsedAt: undefined });
      expect(await migrated.authMethods.get("github-migrate")).toMatchObject({ config: { github: { clientSecret: "auth-secret-value" } } });
      expect(await migrated.capacityProviders.get("provider-migrate")).toMatchObject({ config: { privatePayload: { token: "provider-secret-value" } } });
      expect(await migrated.capacityTargets.get("target-migrate")).toMatchObject({ runpod: { podId: "opaque-pod-id", create: { custom: [1, null, true] } } });
      expect(await migrated.targetProvisioningJobs.get("job-migrate")).toMatchObject({ status: "failed", errorMessage: "terminal provisioning record" });
      expect(await migrated.targetModelDiscoveries.get("target-migrate")).toMatchObject({ models: [{ id: "model-migrate", meta: { n_ctx: 202_752 } }] });
      expect(await migrated.targetActivations.listReservationAllocations(fixture.reservationId)).toMatchObject([
        { targetActivationId: "activation-migrate", estimatedCostUsd: 0.123456, endedAt: fixture.endedAt }
      ]);
      await migrated.close();

      const rerun = await migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: database.pool });
      expect(rerun.outcome).toBe("verified-noop");
      expect(rerun.migrationId).toBe(result.migrationId);
    } finally {
      await database.cleanup();
    }
  });

  it("merges recognized legacy target run history into the activation family", async () => {
    const fixture = await createPopulatedSqlite();
    addLegacyTargetRun(fixture.sqlitePath, fixture.reservationId, fixture.endedAt);
    const database = await createPostgresTestSchema();
    try {
      const result = await migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: database.pool });
      expect(result.counts.targetActivations).toBe(2);
      expect(result.counts.targetActivationReservations).toBe(2);
      const migrated = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      expect(await migrated.targetActivations.listActivationsForTarget("target-migrate")).toHaveLength(2);
      expect(await migrated.targetActivations.listReservationAllocations(fixture.reservationId)).toMatchObject([
        { targetActivationId: "Z-legacy-activation", estimatedCostUsd: 0.5 },
        { targetActivationId: "activation-migrate", estimatedCostUsd: 0.123456 }
      ]);
      await migrated.close();
    } finally {
      await database.cleanup();
    }
  });

  it("refuses incompatible source and destination schemas", async () => {
    const directory = await makeTemporaryDirectory();
    const incompatibleSqlite = path.join(directory, "incompatible.db");
    const sqlite = new Database(incompatibleSqlite);
    sqlite.exec("create table reservations (id text primary key)");
    sqlite.close();
    expect(() => inspectSqliteForMigration(incompatibleSqlite)).toThrow("SQLite source schema is incompatible");

    const futureSqlite = await createEmptySqlite();
    const future = new Database(futureSqlite);
    future.exec("alter table reservations add column future_field text; create table future_entity (id text primary key)");
    future.close();
    expect(() => inspectSqliteForMigration(futureSqlite)).toThrow("unexpected reservations.future_field");

    const validSource = await createEmptySqlite();
    const database = await createPostgresTestSchema();
    try {
      await database.pool.query("create table reservations (id integer primary key)");
      await expect(migrateSqliteToPostgres({ sqlitePath: validSource, pool: database.pool })).rejects.toThrow("PostgreSQL schema is incompatible");
    } finally {
      await database.cleanup();
    }
  });

  it("refuses a nonempty destination and a changed source after completion", async () => {
    const fixture = await createPopulatedSqlite();
    const nonempty = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(nonempty.pool);
      await nonempty.pool.query(
        "insert into api_keys (id, username, name, prefix, key_hash, created_at) values ('existing', 'user', 'name', 'prefix', 'hash', now())"
      );
      await expect(migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: nonempty.pool })).rejects.toThrow("destination is nonempty");
    } finally {
      await nonempty.cleanup();
    }

    const completed = await createPostgresTestSchema();
    try {
      await migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: completed.pool });
      const sqliteHandle = await createReservationRepository({ driver: "sqlite", path: fixture.sqlitePath });
      await sqliteHandle.apiKeys.create({ id: "key-added", username: "clint", name: "added", prefix: "prefix", keyHash: "hash-added", createdAt: fixture.endedAt });
      await sqliteHandle.close();
      await expect(migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: completed.pool })).rejects.toThrow("destination is nonempty");
    } finally {
      await completed.cleanup();
    }
  });

  it("rolls the entire destination back when interrupted before commit", async () => {
    const fixture = await createPopulatedSqlite();
    const database = await createPostgresTestSchema();
    try {
      await expect(migrateSqliteToPostgres({
        sqlitePath: fixture.sqlitePath,
        pool: database.pool,
        beforeCommit: () => { throw new Error("simulated interruption"); }
      })).rejects.toThrow("simulated interruption");
      for (const table of POSTGRES_DATA_TABLES) {
        const count = await database.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
        expect(count.rows[0].count, table).toBe("0");
      }
      const migrations = await database.pool.query<{ count: string }>("select count(*)::text as count from neuron_data_migrations");
      expect(migrations.rows[0].count).toBe("0");
    } finally {
      await database.cleanup();
    }
  });

  it("detects unsafe lifecycle state before importing", async () => {
    const directory = await makeTemporaryDirectory();
    const sqlitePath = path.join(directory, "unsafe.db");
    const handle = await createReservationRepository({ driver: "sqlite", path: sqlitePath });
    const now = new Date("2026-07-01T12:00:00Z");
    await handle.repository.create({ id: "active", username: "clint", modelIds: [], targetIds: ["target"], createdAt: now, expiresAt: new Date("2027-01-01T00:00:00Z"), status: "active" });
    await handle.targetProvisioningJobs.create({
      id: "running", status: "running", providerId: "provider", providerType: "runpod", targetId: "target",
      targetDraft: { id: "target", displayName: "Target", provider: "runpod", providerId: "provider", modelIds: [] }, createdResources: [], createdAt: now, updatedAt: now
    });
    await handle.targetActivations.createActivation({ id: "open", targetId: "target", startedAt: now, status: "open", estimatedCostUsd: 0, lastCostedAt: now });
    await handle.close();
    expect(inspectSqliteForMigration(sqlitePath)).toMatchObject({
      operationalSafety: "blocked",
      blockers: { activeReservations: 1, inFlightProvisioningJobs: 1, openTargetActivations: 1 }
    });
    const database = await createPostgresTestSchema();
    try {
      await expect(migrateSqliteToPostgres({ sqlitePath, pool: database.pool })).rejects.toThrow("unsafe live lifecycle state");
    } finally {
      await database.cleanup();
    }
  });

  it("creates and validates a WAL-aware consistent rollback backup", async () => {
    const fixture = await createPopulatedSqlite();
    const backupDirectory = path.join(await makeTemporaryDirectory(), "backups");
    const backup = await createConsistentSqliteBackup(fixture.sqlitePath, backupDirectory, new Date("2026-07-31T12:34:56Z"));
    expect(path.basename(backup)).toBe("neuron-sqlite-rollback-20260731T123456Z.db");
    expect(inspectSqliteForMigration(backup)).toEqual(inspectSqliteForMigration(fixture.sqlitePath));
  });

  it("redacts unexpected errors and never returns a secret-bearing database message", () => {
    const message = safeMigrationErrorMessage(new Error("duplicate payload auth-secret-value provider-secret-value opaque-hash-value"));
    expect(message).toBe("Migration failed; PostgreSQL changes were rolled back. No row values were logged.");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("hash-value");
  });
});

async function createEmptySqlite(): Promise<string> {
  const directory = await makeTemporaryDirectory();
  const sqlitePath = path.join(directory, "empty.db");
  const handle = await createReservationRepository({ driver: "sqlite", path: sqlitePath });
  await handle.close();
  return sqlitePath;
}

async function createPopulatedSqlite(): Promise<{ sqlitePath: string; reservationId: string; endedAt: Date }> {
  const directory = await makeTemporaryDirectory();
  const sqlitePath = path.join(directory, "populated.db");
  const handle = await createReservationRepository({ driver: "sqlite", path: sqlitePath });
  const createdAt = new Date("2026-07-01T12:30:00-05:00");
  const endedAt = new Date("2026-07-01T13:15:30-05:00");
  await handle.reservationProfiles.create({
    id: "profile-migrate", username: "clint", name: "Migration profile", selections: [{ targetId: "target-migrate", modelIds: ["model-migrate"] }], createdAt, updatedAt: endedAt
  });
  const reservation = await handle.repository.create({
    id: "reservation-migrate", username: "clint", apiKeyName: "migration-key", profileId: "profile-migrate", profileName: "Migration profile",
    modelIds: ["model-migrate"], targetIds: ["target-migrate"], createdAt, expiresAt: endedAt, endedAt, status: "failed", failureMessage: "terminal failure", synthetic: true
  });
  await handle.apiKeys.create({ id: "key-migrate", username: "clint", name: "migration-key", prefix: "sk-neuron-redacted", keyHash: "opaque-hash-value", createdAt });
  await handle.authMethods.create({
    id: "github-migrate", displayName: "GitHub", type: "github", enabled: true,
    config: { github: { clientId: "client-id", clientSecret: "auth-secret-value", allowedOrganizations: ["example"] } }
  });
  await handle.capacityProviders.create({
    id: "provider-migrate", displayName: "Provider", type: "runpod", provisioning: { enabled: false },
    config: { privatePayload: { token: "provider-secret-value" }, runpod: { apiKeyEnv: "RUNPOD_PRIVATE" } }
  });
  await handle.capacityTargets.create({
    id: "target-migrate", displayName: "Target", provider: "runpod", providerId: "provider-migrate", modelIds: ["model-migrate"],
    runpod: { podId: "opaque-pod-id", runtimePort: 8080, create: { custom: [1, null, true] } }
  });
  await handle.targetProvisioningJobs.create({
    id: "job-migrate", status: "failed", providerId: "provider-migrate", providerType: "runpod", runtimeProfileId: "prefer", targetId: "target-migrate",
    targetDraft: { id: "target-migrate", displayName: "Target", provider: "runpod", providerId: "provider-migrate", modelIds: ["model-migrate"] },
    createdResources: [{ providerType: "runpod", resourceType: "pod", resourceId: "opaque-pod-id", cleanupState: "unknown" }],
    errorMessage: "terminal provisioning record", createdAt, updatedAt: endedAt
  });
  await handle.targetModelDiscoveries.record({ targetId: "target-migrate", discoveredAt: createdAt, models: [{ id: "model-migrate", aliases: ["alias"], meta: { n_ctx: 202_752 } }] });
  await handle.targetActivations.createActivation({
    id: "activation-migrate", targetId: "target-migrate", startedAt: createdAt, endedAt, status: "closed", estimatedCostUsd: 0.123456, lastCostedAt: endedAt
  });
  await handle.targetActivations.addReservationCost({ targetActivationId: "activation-migrate", reservationId: reservation.id, at: createdAt, estimatedCostUsd: 0.123456 });
  await handle.targetActivations.closeReservationsForActivation("activation-migrate", endedAt);
  await handle.close();
  return { sqlitePath, reservationId: reservation.id, endedAt };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function addLegacyTargetRun(sqlitePath: string, reservationId: string, endedAt: Date): void {
  const db = new Database(sqlitePath);
  db.exec(`
    create table target_runs (
      id text primary key,
      target_id text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      estimated_hourly_cost_usd real,
      estimated_cost_usd real not null default 0,
      last_costed_at text not null
    );
    create table target_run_reservation_links (
      id text primary key,
      target_run_id text not null,
      reservation_id text not null,
      started_at text not null,
      ended_at text,
      estimated_cost_usd real not null default 0,
      unique(target_run_id, reservation_id)
    );
  `);
  db.prepare(`
    insert into target_runs (id, target_id, started_at, ended_at, status, estimated_hourly_cost_usd, estimated_cost_usd, last_costed_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("Z-legacy-activation", "target-migrate", "2026-06-30T12:00:00.000Z", endedAt.toISOString(), "closed", null, 0.5, endedAt.toISOString());
  db.prepare(`
    insert into target_run_reservation_links (id, target_run_id, reservation_id, started_at, ended_at, estimated_cost_usd)
    values (?, ?, ?, ?, ?, ?)
  `).run("Z-legacy-link", "Z-legacy-activation", reservationId, "2026-06-30T12:00:00.000Z", endedAt.toISOString(), 0.5);
  db.close();
}
