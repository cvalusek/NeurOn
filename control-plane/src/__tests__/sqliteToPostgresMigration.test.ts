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
      expect(first.counts).toMatchObject({ roles: 9 });
      expect(Object.entries(first.counts).filter(([name]) => name !== "roles").every(([, count]) => count === 0)).toBe(true);
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
        targetActivationReservations: 1,
        modelCapabilities: 1,
        modelDeployments: 1,
        modelFavorites: 1,
        assistantConfig: 1,
        users: 1,
        userIdentities: 1,
        localCredentials: 1,
        roles: 10,
        userRoleAssignments: 2,
        teams: 2,
        teamHierarchy: 3,
        teamMemberships: 1,
        registrationInvitations: 1,
        externalUserLinks: 1,
        identityAuditEvents: 1
      });
      const migrated = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      expect(await migrated.repository.get(fixture.reservationId)).toMatchObject({
        status: "failed", synthetic: true, keepaliveMinutes: undefined, failureMessage: "terminal failure",
        targetSelections: [{ targetId: "target-migrate", modelIds: ["model-migrate"] }]
      });
      expect(await migrated.reservationProfiles.get("profile-migrate")).toMatchObject({ teamId: "team-child", description: undefined, defaultDurationMinutes: undefined });
      expect(await migrated.apiKeys.get("key-migrate")).toMatchObject({ keyHash: "opaque-hash-value", lastUsedAt: undefined });
      expect(await migrated.authMethods.get("github-migrate")).toMatchObject({ config: { github: { clientSecret: "auth-secret-value" } } });
      expect(await migrated.capacityProviders.get("provider-migrate")).toMatchObject({ config: { privatePayload: { token: "provider-secret-value" } } });
      expect(await migrated.capacityTargets.get("target-migrate")).toMatchObject({ runpod: { podId: "opaque-pod-id", create: { custom: [1, null, true] } } });
      expect(await migrated.targetProvisioningJobs.get("job-migrate")).toMatchObject({ status: "failed", errorMessage: "terminal provisioning record" });
      expect(await migrated.targetModelDiscoveries.get("target-migrate")).toMatchObject({ models: [{ id: "model-migrate", meta: { n_ctx: 202_752 } }] });
      expect(await migrated.targetActivations.listReservationAllocations(fixture.reservationId)).toMatchObject([
        { targetActivationId: "activation-migrate", estimatedCostUsd: 0.123456, endedAt: fixture.endedAt }
      ]);
      expect(await migrated.modelMetadata.listCapabilities()).toMatchObject([{ modelId: "model-migrate", intelligence: 89, domains: { coding: 94 }, quantization: { format: "Q6", qualityRetentionPercent: 98.4 } }]);
      expect(await migrated.modelMetadata.listDeployments()).toMatchObject([{ targetId: "target-migrate", modelId: "model-migrate", performance: { decodeTokensPerSecond: 33 } }]);
      expect(await migrated.modelFavorites.listForUser("usr-clint")).toMatchObject([{ targetId: "target-migrate", modelId: "model-migrate" }]);
      expect(await migrated.assistantConfig.get()).toMatchObject({ targetId: "target-migrate", modelId: "model-migrate", reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90, additionalInstructions: "Use migration fixture terminology." });
      expect(await migrated.identities.getUser("usr-clint")).toMatchObject({ username: "clint", status: "active" });
      expect(await migrated.identities.getLocalPasswordHash("usr-clint")).toBe("scrypt$fixture-password-hash");
      expect(await migrated.identities.findIdentity("oidc", "work", "oidc-clint")).toMatchObject({ userId: "usr-clint", email: "clint@example.test" });
      expect(await migrated.identities.listGlobalRolesForUser("usr-clint")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "role_member" }), expect.objectContaining({ id: "role_fixture" })]));
      expect(await migrated.identities.getRole("role_admin")).toMatchObject({ permissions: expect.arrayContaining(["fixture.custom_permission"]) });
      expect(await migrated.identities.isUserInAnyTeam("usr-clint", ["team-parent"])).toBe(true);
      expect(await migrated.identities.getExternalUserLink("litellm", "litellm-clint")).toMatchObject({ userId: "usr-clint", source: "rule" });
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

  it("refuses malformed target-specific reservation selections", async () => {
    const fixture = await createPopulatedSqlite();
    const sqlite = new Database(fixture.sqlitePath);
    sqlite.prepare("update reservations set target_selections = ? where id = ?").run(JSON.stringify({ targetId: "target-migrate", modelIds: ["model-migrate"] }), fixture.reservationId);
    sqlite.close();
    expect(() => inspectSqliteForMigration(fixture.sqlitePath)).toThrow("SQLite source reservations.target_selections must be an array");
  });

  it("refuses a nonempty destination and a changed source after completion", async () => {
    const fixture = await createPopulatedSqlite();
    const nonempty = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(nonempty.pool);
      await nonempty.pool.query("insert into users (id, username, normalized_username, status, created_at, updated_at) values ('existing-user', 'user', 'user', 'active', now(), now())");
      await expect(migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: nonempty.pool })).rejects.toThrow("destination is nonempty");
    } finally {
      await nonempty.cleanup();
    }

    const completed = await createPostgresTestSchema();
    try {
      await migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: completed.pool });
      const sqliteHandle = await createReservationRepository({ driver: "sqlite", path: fixture.sqlitePath });
      const owner = await sqliteHandle.identities.getUserByUsername("clint");
      await sqliteHandle.apiKeys.create({ id: "key-added", userId: owner!.id, username: "clint", name: "added", prefix: "prefix", keyHash: "hash-added", createdAt: fixture.endedAt });
      await sqliteHandle.close();
      await expect(migrateSqliteToPostgres({ sqlitePath: fixture.sqlitePath, pool: completed.pool })).rejects.toThrow("different completed data migration");
    } finally {
      await completed.cleanup();
    }
  });

  it("refuses any different completed data migration even when both datasets are otherwise empty", async () => {
    const sqlitePath = await createEmptySqlite();
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await database.pool.query("insert into neuron_data_migrations (id,source_fingerprint,counts,fingerprints,completed_at) values ('different-migration','different','{}','{}',now())");
      await expect(migrateSqliteToPostgres({ sqlitePath, pool: database.pool })).rejects.toThrow("different completed data migration");
      expect((await database.pool.query<{ count: string }>("select count(*)::text as count from neuron_data_migrations")).rows[0].count).toBe("1");
    } finally { await database.cleanup(); }
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
        expect(count.rows[0].count, table).toBe(table === "roles" ? "9" : "0");
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
    await handle.identities.createUser({ id: "usr-clint", username: "clint", status: "active", createdAt: now, updatedAt: now });
    await handle.repository.create({ id: "active", userId: "usr-clint", username: "clint", modelIds: [], targetIds: ["target"], createdAt: now, expiresAt: new Date("2027-01-01T00:00:00Z"), status: "active" });
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
  await handle.identities.createUser({ id: "usr-clint", username: "clint", status: "active", createdAt, updatedAt: createdAt });
  await handle.identities.setLocalPasswordHash("usr-clint", "scrypt$fixture-password-hash");
  await handle.identities.saveIdentity({ id: "identity-oidc", userId: "usr-clint", providerType: "oidc", providerId: "work", subject: "oidc-clint", username: "clint", email: "clint@example.test", createdAt, lastSeenAt: endedAt });
  await handle.identities.createRole({ id: "role_fixture", name: "Fixture role", description: "Migration fixture", scope: "global", permissions: ["reports.read_own"], createdAt, updatedAt: endedAt });
  await handle.identities.assignGlobalRole("usr-clint", "role_fixture");
  await handle.identities.createTeam({ id: "team-parent", name: "Engineering", createdAt, updatedAt: createdAt });
  await handle.identities.createTeam({ id: "team-child", name: "Platform", parentTeamId: "team-parent", createdAt, updatedAt: endedAt });
  await handle.identities.setTeamMembership({ teamId: "team-child", userId: "usr-clint", roleId: "role_team_member", source: "oidc", sourceReference: "work:platform", createdAt });
  await handle.identities.createInvitation({ id: "invite-fixture", tokenHash: "opaque-invitation-hash", userId: "usr-clint", intendedUsername: "clint", initialRoleId: "role_member", expiresAt: new Date("2027-01-01T00:00:00Z"), maxUses: 1, createdAt });
  await handle.identities.saveExternalUserLink({ integration: "litellm", externalSubject: "litellm-clint", userId: "usr-clint", source: "rule", createdAt, lastSeenAt: endedAt });
  await handle.reservationProfiles.create({
    id: "profile-migrate", userId: "usr-clint", username: "clint", teamId: "team-child", name: "Migration profile", selections: [{ targetId: "target-migrate", modelIds: ["model-migrate"] }], createdAt, updatedAt: endedAt
  });
  const reservation = await handle.repository.create({
    id: "reservation-migrate", userId: "usr-clint", username: "clint", apiKeyName: "migration-key", profileId: "profile-migrate", profileName: "Migration profile",
    modelIds: ["model-migrate"], targetIds: ["target-migrate"], targetSelections: [{ targetId: "target-migrate", modelIds: ["model-migrate"] }],
    createdAt, expiresAt: endedAt, endedAt, status: "failed", failureMessage: "terminal failure", synthetic: true
  });
  await handle.apiKeys.create({ id: "key-migrate", userId: "usr-clint", username: "clint", name: "migration-key", prefix: "sk-neuron-redacted", keyHash: "opaque-hash-value", createdAt });
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
    audience: { scope: "users", userIds: ["usr-clint"] },
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
  await handle.modelMetadata.upsertCapability({ modelId: "model-migrate", intelligence: 89, domains: { coding: 94 }, quantization: { format: "Q6", qualityRetentionPercent: 98.4 }, provenance: { source: "manual", version: "fixture-v1" } }, createdAt);
  await handle.modelMetadata.upsertDeployment({ targetId: "target-migrate", modelId: "model-migrate", performance: { decodeTokensPerSecond: 33, prefillTokensPerSecond: 700, sampleCount: 3 }, provenance: { source: "NeurOn direct benchmark", version: "neuron-speed-v2-50k" } }, endedAt);
  await handle.modelFavorites.add({ userId: "usr-clint", username: "clint", targetId: "target-migrate", modelId: "model-migrate", createdAt });
  await handle.assistantConfig.save({ targetId: "target-migrate", modelId: "model-migrate", reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90, additionalInstructions: "Use migration fixture terminology.", updatedAt: endedAt });
  await handle.close();
  const sqlite = new Database(sqlitePath);
  const adminPermissions = JSON.parse((sqlite.prepare("select permissions from roles where id='role_admin'").get() as { permissions: string }).permissions) as string[];
  sqlite.prepare("update roles set permissions=? where id='role_admin'").run(JSON.stringify([...adminPermissions, "fixture.custom_permission"]));
  sqlite.prepare("insert into identity_audit_events (id,actor_user_id,action,subject_type,subject_id,details,created_at) values (?,?,?,?,?,?,?)")
    .run("audit-fixture", "usr-clint", "fixture.created", "user", "usr-clint", JSON.stringify({ private: false }), createdAt.toISOString());
  sqlite.close();
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
