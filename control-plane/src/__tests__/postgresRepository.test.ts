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
      expect(await readPostgresSchemaState(database.pool)).toEqual({ currentVersion: POSTGRES_SCHEMA_VERSION, appliedVersions: [1, 2, 3, 4, 5, 6] });

      const first = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      const createdAt = new Date("2026-07-01T12:30:00-05:00");
      const endedAt = new Date("2026-07-01T13:00:00-05:00");
      await first.identities.createUser({ id: "usr-clint", username: "clint", status: "active", createdAt, updatedAt: createdAt });
      const profile = await first.reservationProfiles.create({
        id: "profile-1",
        userId: "usr-clint",
        username: "clint",
        name: "Production profile",
        selections: [{ targetId: "target-1", modelIds: ["model-1"] }],
        createdAt,
        updatedAt: endedAt
      });
      const reservation = await first.repository.create({
        id: "reservation-1",
        userId: "usr-clint",
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
        userId: "usr-clint",
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
      await first.modelFavorites.add({ userId: "usr-clint", username: "clint", targetId: "target-1", modelId: "model-1", createdAt });
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
      expect(await second.modelFavorites.listForUser("usr-clint")).toEqual([{ userId: "usr-clint", username: "clint", targetId: "target-1", modelId: "model-1", createdAt }]);
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

  it("persists nested teams and transactionally merges duplicate PostgreSQL users", async () => {
    const database = await createPostgresTestSchema();
    try {
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      const now = new Date("2026-08-21T12:00:00.000Z");
      const source = await handle.identities.createUser({ id: "usr-source", username: "source", status: "active", createdAt: now, updatedAt: now });
      const target = await handle.identities.createUser({ id: "usr-target", username: "target", status: "active", createdAt: now, updatedAt: now });
      await handle.identities.setLocalPasswordHash(source.id, "source-password-hash");
      await handle.identities.setLocalPasswordHash(target.id, "target-password-hash");
      await handle.identities.saveIdentity({ userId: source.id, providerType: "github", providerId: "work", subject: "github-42", username: "source", createdAt: now, lastSeenAt: now });
      const customRole = await handle.identities.createRole({ id: "role-custom", name: "Custom", scope: "global", permissions: ["reports.read_own"], createdAt: now, updatedAt: now });
      await handle.identities.assignGlobalRole(source.id, customRole.id);
      const parent = await handle.identities.createTeam({ id: "team-parent", name: "Engineering", createdAt: now, updatedAt: now });
      const child = await handle.identities.createTeam({ id: "team-child", name: "Platform", parentTeamId: parent.id, createdAt: now, updatedAt: now });
      await handle.identities.setTeamMembership({ teamId: child.id, userId: source.id, roleId: "role_team_member", source: "manual", createdAt: now });
      await handle.identities.createInvitation({ id: "claim-source", tokenHash: "opaque-claim-hash", userId: source.id, intendedUsername: source.username, expiresAt: new Date("2027-01-01T00:00:00Z"), maxUses: 1, createdAt: now });
      await handle.identities.saveExternalUserLink({ integration: "litellm", externalSubject: "external-source", userId: source.id, source: "admin", createdAt: now, lastSeenAt: now });
      await handle.capacityTargets.create({ id: "private", displayName: "Private", provider: "fake", modelIds: [], audience: { scope: "users", userIds: [source.id] } });
      await handle.reservationProfiles.create({ id: "source-profile", userId: source.id, username: source.username, name: "Profile", selections: [{ targetId: "private", modelIds: [] }], createdAt: now, updatedAt: now });
      await handle.modelFavorites.add({ userId: source.id, username: source.username, targetId: "private", modelId: "model", createdAt: now });
      await handle.modelFavorites.add({ userId: target.id, username: target.username, targetId: "private", modelId: "model", createdAt: now });

      await handle.identities.mergeUsers(source.id, target.id, new Date("2026-08-21T13:00:00.000Z"));

      expect(await handle.identities.getUser(source.id)).toMatchObject({ status: "disabled", mergedIntoUserId: target.id, sessionVersion: 2 });
      expect(await handle.identities.getUser(target.id)).toMatchObject({ status: "active", sessionVersion: 2 });
      expect(await handle.identities.getLocalPasswordHash(source.id)).toBeUndefined();
      expect(await handle.identities.getLocalPasswordHash(target.id)).toBe("target-password-hash");
      expect(await handle.identities.findIdentity("github", "work", "github-42")).toMatchObject({ userId: target.id });
      expect(await handle.identities.listGlobalRolesForUser(target.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: customRole.id })]));
      expect(await handle.identities.isUserInAnyTeam(target.id, [parent.id])).toBe(true);
      expect(await handle.identities.getExternalUserLink("litellm", "external-source")).toMatchObject({ userId: target.id });
      expect((await handle.identities.listInvitations())[0]).toMatchObject({ userId: target.id });
      expect(await handle.capacityTargets.get("private")).toMatchObject({ audience: { scope: "users", userIds: [target.id] } });
      expect(await handle.reservationProfiles.get("source-profile")).toMatchObject({ userId: target.id, username: target.username });
      expect(await handle.modelFavorites.listForUser(target.id)).toHaveLength(1);
      await expect(handle.identities.updateTeam(parent.id, { name: "Engineering", parentTeamId: child.id })).rejects.toThrow("cycle");
      await handle.close();
    } finally {
      await database.cleanup();
    }
  });

  it("serializes concurrent attempts to remove the final PostgreSQL Owner", async () => {
    const database = await createPostgresTestSchema();
    try {
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 4 });
      const first = await handle.identities.createUser({ id: "owner-first", username: "owner-first", status: "active" });
      const second = await handle.identities.createUser({ id: "owner-second", username: "owner-second", status: "active" });
      await handle.identities.assignGlobalRole(first.id, "role_owner");
      await handle.identities.assignGlobalRole(second.id, "role_owner");

      const disables = await Promise.allSettled([handle.identities.updateUser(first.id, { status: "disabled" }), handle.identities.updateUser(second.id, { status: "disabled" })]);
      expect(disables.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(disables.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await handle.identities.countEnabledUsersWithPermission("*")).toBe(1);

      await handle.identities.updateUser(first.id, { status: "active" });
      await handle.identities.updateUser(second.id, { status: "active" });
      const revocations = await Promise.allSettled([handle.identities.revokeGlobalRole(first.id, "role_owner"), handle.identities.revokeGlobalRole(second.id, "role_owner")]);
      expect(revocations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(revocations.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await handle.identities.countEnabledUsersWithPermission("*")).toBe(1);
      await handle.close();
    } finally { await database.cleanup(); }
  });

  it("upgrades schema v5 ownership in place without losing legacy profiles, keys, favorites, or reservations", async () => {
    const database = await createPostgresTestSchema();
    try {
      await migratePostgresSchema(database.pool);
      await database.pool.query(`
        alter table reservations drop constraint if exists reservations_user_fk;
        alter table reservations drop constraint if exists reservations_real_owner;
        alter table reservation_profiles drop constraint if exists reservation_profiles_user_fk;
        alter table api_keys drop constraint if exists api_keys_user_fk;
        alter table model_favorites drop constraint if exists model_favorites_user_fk;
        alter table reservations drop column user_id;
        alter table reservation_profiles drop column user_id;
        alter table api_keys drop column user_id;
        alter table model_favorites drop column user_id;
        drop table identity_audit_events, external_user_links, registration_invitations, team_memberships,
          team_hierarchy, teams, user_role_assignments, roles, local_credentials, user_identities, users cascade;
        delete from neuron_schema_migrations where version = 6;

        insert into reservation_profiles (id,username,name,selections,created_at,updated_at)
          values ('legacy-profile','Clint','Legacy','[{"targetId":"target-1","modelIds":["model-1"]}]','2026-08-01T12:00:00Z','2026-08-01T12:00:00Z');
        insert into reservations (id,username,profile_id,profile_name,model_ids,target_ids,target_selections,created_at,expires_at,status,synthetic)
          values ('legacy-reservation','clint','legacy-profile','Legacy','["model-1"]','["target-1"]','[{"targetId":"target-1","modelIds":["model-1"]}]','2026-08-01T12:00:00Z','2026-08-01T13:00:00Z','done',false);
        insert into api_keys (id,username,name,prefix,key_hash,created_at)
          values ('legacy-key','CLINT','Plugin','sk-neuron-old','opaque-hash','2026-08-01T12:00:00Z');
        insert into model_favorites (username,target_id,model_id,created_at)
          values ('Clint','target-1','model-1','2026-08-01T12:00:00Z');
      `);

      expect(await migratePostgresSchema(database.pool)).toMatchObject({ currentVersion: POSTGRES_SCHEMA_VERSION });
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 3 });
      const users = await handle.identities.listUsers();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ normalizedUsername: "clint", status: "active" });
      expect(await handle.repository.get("legacy-reservation")).toMatchObject({ userId: users[0].id, username: "clint", profileId: "legacy-profile" });
      expect(await handle.reservationProfiles.get("legacy-profile")).toMatchObject({ userId: users[0].id, username: "Clint", name: "Legacy" });
      expect(await handle.apiKeys.get("legacy-key")).toMatchObject({ userId: users[0].id, username: "CLINT", keyHash: "opaque-hash" });
      expect(await handle.modelFavorites.listForUser(users[0].id)).toMatchObject([{ username: "Clint", targetId: "target-1", modelId: "model-1" }]);
      await handle.close();
    } finally {
      await database.cleanup();
    }
  });

  it("moves an embedded legacy assistant selection through the current schema without losing the model", async () => {
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
      expect(state.currentVersion).toBe(POSTGRES_SCHEMA_VERSION);
      const handle = await createReservationRepository({ driver: "postgres", connectionString: database.connectionString, maxConnections: 2 });
      expect(await handle.assistantConfig.get()).toMatchObject({ targetId: "advisor-target", modelId: "advisor-model", reservationMinutes: 12, keepaliveMinutes: 12, requestTimeoutSeconds: 90 });
      expect(await handle.capacityTargets.get("advisor-target")).not.toHaveProperty("profileAdvisor");
      await handle.close();
    } finally {
      await database.cleanup();
    }
  });

  it("upgrades a schema v4 assistant record through the current schema without manual SQL", async () => {
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

      expect(state).toEqual({ currentVersion: POSTGRES_SCHEMA_VERSION, appliedVersions: [1, 2, 3, 4, 5, 6] });
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
      await handle.identities.createUser({ id: "usr-clint", username: "clint", status: "active" });
      const reservation = await handle.repository.create({
        id: "invalid-selections", userId: "usr-clint", username: "clint", modelIds: ["model-1"], targetIds: ["target-1"],
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
