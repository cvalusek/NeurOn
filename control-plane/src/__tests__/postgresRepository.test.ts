import { describe, expect, it } from "vitest";
import { createReservationRepository } from "../repository/createReservationRepository.js";
import { migratePostgresSchema, POSTGRES_SCHEMA_VERSION, readPostgresSchemaState } from "../repository/postgresSchema.js";
import { createPostgresTestSchema, postgresTestUrl } from "./postgresTestUtils.js";

const describePostgres = postgresTestUrl ? describe : describe.skip;

describePostgres("PostgreSQL schema and repositories", () => {
  it("initializes the versioned schema idempotently and persists every repository family", async () => {
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await migratePostgresSchema(database.pool);
      expect(await readPostgresSchemaState(database.pool)).toEqual({ currentVersion: POSTGRES_SCHEMA_VERSION, appliedVersions: [1, 2, 3, 4, 5] });

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
        targetSelections: [{ targetId: "target-1", modelIds: ["model-1"] }],
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
      await first.modelMetadata.upsertCapability({ modelId: "model-1", intelligence: 88, domains: { coding: 93 }, quantization: { format: "Q6", qualityRetentionPercent: 98 }, provenance: { source: "manual", version: "2026-08" } }, createdAt);
      await first.modelMetadata.upsertDeployment({ targetId: "target-1", modelId: "model-1", performance: { decodeTokensPerSecond: 40, prefillTokensPerSecond: 900, sampleCount: 3 } }, endedAt);
      await first.modelFavorites.add({ username: "clint", targetId: "target-1", modelId: "model-1", createdAt });
      await first.assistantConfig.save({ targetId: "target-1", modelId: "model-1", reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90, additionalInstructions: "Use local pool names.", updatedAt: endedAt });
      await first.close();

      const second = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      expect(await second.repository.get(reservation.id)).toMatchObject({ id: reservation.id, status: "done", synthetic: true, profileId: profile.id, targetSelections: [{ targetId: "target-1", modelIds: ["model-1"] }] });
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
      expect(await second.modelMetadata.listCapabilities()).toMatchObject([{ modelId: "model-1", intelligence: 88, domains: { coding: 93 }, quantization: { format: "Q6", qualityRetentionPercent: 98 }, updatedAt: createdAt }]);
      expect(await second.modelMetadata.listDeployments()).toMatchObject([{ targetId: "target-1", modelId: "model-1", performance: { decodeTokensPerSecond: 40 }, updatedAt: endedAt }]);
      expect(await second.modelFavorites.listForUser("clint")).toEqual([{ username: "clint", targetId: "target-1", modelId: "model-1", createdAt }]);
      expect(await second.assistantConfig.get()).toEqual({ id: "default", targetId: "target-1", modelId: "model-1", reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90, additionalInstructions: "Use local pool names.", updatedAt: endedAt });
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
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(["api_key_name", "profile_id", "profile_name", "target_selections"]));
      const providerColumns = await database.pool.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'capacity_providers'
      `);
      expect(providerColumns.rows.map((row) => row.column_name)).toContain("provisioning_enabled");
    } finally {
      await database.cleanup();
    }
  });

  it("moves an embedded legacy assistant selection through schema v5 without losing the model", async () => {
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await database.pool.query("delete from neuron_schema_migrations where version in (4, 5)");
      await database.pool.query("drop table assistant_config");
      await database.pool.query(
        "insert into capacity_targets (id, target_json) values ($1, $2::jsonb)",
        ["advisor-target", JSON.stringify({ id: "advisor-target", displayName: "Advisor", provider: "docker", modelIds: ["advisor-model"], profileAdvisor: { modelId: "advisor-model", reservationMinutes: 12, startupTimeoutSeconds: 300, requestTimeoutSeconds: 90 } })]
      );
      const state = await migratePostgresSchema(database.pool);
      expect(state.currentVersion).toBe(5);
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 2 });
      expect(await handle.assistantConfig.get()).toMatchObject({ targetId: "advisor-target", modelId: "advisor-model", reservationMinutes: 12, keepaliveMinutes: 12, requestTimeoutSeconds: 90 });
      expect(await handle.capacityTargets.get("advisor-target")).not.toHaveProperty("profileAdvisor");
      await handle.close();
    } finally {
      await database.cleanup();
    }
  });

  it("upgrades a schema v4 assistant record through schema v5 without manual SQL", async () => {
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await database.pool.query(`
        insert into assistant_config (
          id, target_id, model_id, reservation_minutes, keepalive_minutes,
          request_timeout_seconds, updated_at
        ) values ('default', 'advisor-target', 'advisor-model', 12, 5, 90, '2026-08-15T12:00:00Z')
      `);
      await database.pool.query("delete from neuron_schema_migrations where version = 5");
      await database.pool.query("alter table assistant_config drop column additional_instructions");

      const state = await migratePostgresSchema(database.pool);

      expect(state).toEqual({ currentVersion: 5, appliedVersions: [1, 2, 3, 4, 5] });
      const assistant = await database.pool.query<{ target_id: string; model_id: string; additional_instructions: string | null }>(`
        select target_id, model_id, additional_instructions
        from assistant_config
        where id = 'default'
      `);
      expect(assistant.rows).toEqual([{ target_id: "advisor-target", model_id: "advisor-model", additional_instructions: null }]);
    } finally {
      await database.cleanup();
    }
  });

  it("fails closed when persisted target selections have an invalid shape", async () => {
    const database = await createPostgresTestSchema();
    try {
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      const reservation = await handle.repository.create({
        id: "invalid-selections", username: "clint", modelIds: ["model-1"], targetIds: ["target-1"],
        createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: "active"
      });
      await database.pool.query("update reservations set target_selections = $1::jsonb where id = $2", [JSON.stringify({ targetId: "target-1", modelIds: ["model-1"] }), reservation.id]);
      await expect(handle.repository.get(reservation.id)).rejects.toThrow("PostgreSQL reservation target_selections must be an array");
      await handle.close();
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
