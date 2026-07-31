import { describe, expect, it } from "vitest";
import { createReservationRepository } from "../repository/createReservationRepository.js";
import { migratePostgresSchema, POSTGRES_SCHEMA_VERSION, readPostgresSchemaState } from "../repository/postgresSchema.js";
import { createPostgresTestSchema, postgresTestUrl } from "./postgresTestUtils.js";

const describePostgres = postgresTestUrl ? describe : describe.skip;

describePostgres("PostgreSQL schema and repositories", () => {
  it("initializes the versioned schema idempotently and persists all nine repository families", async () => {
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await migratePostgresSchema(database.pool);
      expect(await readPostgresSchemaState(database.pool)).toEqual({ currentVersion: POSTGRES_SCHEMA_VERSION, appliedVersions: [POSTGRES_SCHEMA_VERSION] });

      const first = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      const createdAt = new Date("2026-07-01T12:30:00-05:00");
      const endedAt = new Date("2026-07-01T13:00:00-05:00");
      const profile = await first.reservationProfiles.create({
        id: "profile-1",
        username: "clint",
        name: "Production profile",
        selections: [{ targetId: "target-1", modelIds: ["model-1"] }],
        createdAt,
        updatedAt: endedAt
      });
      const reservation = await first.repository.create({
        id: "reservation-1",
        username: "clint",
        apiKeyName: "operator-key",
        profileId: profile.id,
        profileName: profile.name,
        modelIds: ["model-1"],
        targetIds: ["target-1"],
        createdAt,
        expiresAt: endedAt,
        endedAt,
        status: "done",
        synthetic: true
      });
      await first.apiKeys.create({
        id: "key-1",
        username: "clint",
        name: "operator-key",
        prefix: "sk-neuron-example",
        keyHash: "sha256-test-hash",
        createdAt,
        lastUsedAt: endedAt
      });
      await first.authMethods.create({
        id: "github-1",
        displayName: "GitHub",
        type: "github",
        enabled: true,
        config: { github: { clientId: "client-id", clientSecret: "opaque-secret", allowedUsers: ["clint"] } }
      });
      await first.capacityProviders.create({
        id: "provider-1",
        displayName: "RunPod",
        type: "runpod",
        provisioning: { enabled: true },
        config: { runpod: { apiKeyEnv: "RUNPOD_TEST_KEY" }, nested: { nullable: null } },
        credentialId: "credential-1"
      });
      await first.capacityTargets.create({
        id: "target-1",
        displayName: "Test target",
        provider: "runpod",
        providerId: "provider-1",
        modelIds: ["model-1"],
        runpod: { podId: "pod-1", runtimePort: 8080 }
      });
      await first.targetProvisioningJobs.create({
        id: "job-1",
        status: "completed",
        providerId: "provider-1",
        providerType: "runpod",
        runtimeProfileId: "prefer",
        targetId: "target-1",
        targetDraft: { id: "target-1", displayName: "Test target", provider: "runpod", providerId: "provider-1", modelIds: ["model-1"] },
        createdResources: [{ providerType: "runpod", resourceType: "pod", resourceId: "pod-1", cleanupState: "pending" }],
        createdAt,
        updatedAt: endedAt
      });
      await first.targetModelDiscoveries.record({
        targetId: "target-1",
        discoveredAt: createdAt,
        models: [{ id: "model-1", aliases: ["alias-1"], meta: { n_ctx: 131_072 } }]
      });
      const activation = await first.targetActivations.createActivation({
        id: "activation-1",
        targetId: "target-1",
        startedAt: createdAt,
        endedAt,
        status: "closed",
        estimatedHourlyCostUsd: 1.2345,
        estimatedCostUsd: 0.61725,
        lastCostedAt: endedAt
      });
      await first.targetActivations.addReservationCost({
        targetActivationId: activation.id,
        reservationId: reservation.id,
        at: createdAt,
        estimatedCostUsd: 0.61725
      });
      await first.targetActivations.closeReservationsForActivation(activation.id, endedAt);
      await first.close();

      const second = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      expect(await second.repository.get(reservation.id)).toMatchObject({ id: reservation.id, status: "done", synthetic: true, profileId: profile.id });
      expect(await second.reservationProfiles.get(profile.id)).toMatchObject({ id: profile.id, description: undefined });
      expect(await second.apiKeys.get("key-1")).toMatchObject({ keyHash: "sha256-test-hash", lastUsedAt: endedAt });
      expect(await second.authMethods.get("github-1")).toMatchObject({ config: { github: { clientSecret: "opaque-secret" } } });
      expect(await second.capacityProviders.get("provider-1")).toMatchObject({ credentialId: "credential-1", provisioning: { enabled: true } });
      expect(await second.capacityTargets.get("target-1")).toMatchObject({ runpod: { podId: "pod-1" } });
      expect(await second.targetProvisioningJobs.get("job-1")).toMatchObject({ status: "completed", createdAt, updatedAt: endedAt });
      expect(await second.targetModelDiscoveries.get("target-1")).toMatchObject({ discoveredAt: createdAt, models: [{ id: "model-1" }] });
      expect(await second.targetActivations.listReservationAllocations(reservation.id)).toMatchObject([
        { targetActivationId: activation.id, reservationId: reservation.id, endedAt, estimatedCostUsd: 0.61725 }
      ]);
      await second.close();
    } finally {
      await database.cleanup();
    }
  });

  it("adopts the repository's legacy current schema through the centralized ledger", async () => {
    const database = await createPostgresTestSchema();
    try {
      await database.pool.query(`
        create table reservations (
          id text primary key, username text not null, model_ids jsonb not null, target_ids jsonb not null,
          created_at timestamptz not null, expires_at timestamptz not null, keepalive_minutes integer,
          ended_at timestamptz, status text not null, failure_message text, synthetic boolean not null default false
        );
        create table capacity_providers (
          id text primary key, display_name text not null, type text not null, config jsonb, credential_id text
        );
      `);
      const state = await migratePostgresSchema(database.pool);
      expect(state.currentVersion).toBe(POSTGRES_SCHEMA_VERSION);
      const columns = await database.pool.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'reservations'
      `);
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(["api_key_name", "profile_id", "profile_name"]));
      const providerColumns = await database.pool.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'capacity_providers'
      `);
      expect(providerColumns.rows.map((row) => row.column_name)).toContain("provisioning_enabled");
    } finally {
      await database.cleanup();
    }
  });

  it("rejects an unknown or modified schema migration ledger", async () => {
    const database = await createPostgresTestSchema();
    try {
      await database.pool.query(`
        create table neuron_schema_migrations (
          version integer primary key, name text not null, checksum text not null, applied_at timestamptz not null default now()
        )
      `);
      await database.pool.query("insert into neuron_schema_migrations (version, name, checksum) values (99, 'future', 'unknown')");
      await expect(migratePostgresSchema(database.pool)).rejects.toThrow("newer than this NeurOn build");
    } finally {
      await database.cleanup();
    }
  });
});
