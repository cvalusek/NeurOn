import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { migratePostgresSchema, POSTGRES_DATA_TABLES, POSTGRES_SCHEMA_VERSION, readPostgresSchemaState, validatePostgresSchema } from "./postgresSchema.js";
import { parseReservationTargetSelections } from "../domain/reservationSelections.js";
import { parseModelSelectionCatalog } from "../config/modelSelectionConfig.js";
import { parseAssistantAudioConfig } from "../services/assistantAudioConfig.js";
import { assistantConfigFromLegacyTarget, withoutLegacyAssistant } from "./assistantConfigUtils.js";

export const SQLITE_SOURCE_SCHEMA_VERSION = 4;

export const MIGRATION_ENTITY_NAMES = [
  "reservations",
  "reservationProfiles",
  "apiKeys",
  "authMethods",
  "capacityProviders",
  "capacityTargets",
  "targetProvisioningJobs",
  "targetModelDiscoveries",
  "targetActivations",
  "targetActivationReservations",
  "modelCapabilities",
  "modelDeployments",
  "modelFavorites",
  "assistantConfig",
  "users",
  "userIdentities",
  "localCredentials",
  "roles",
  "userRoleAssignments",
  "teams",
  "teamHierarchy",
  "teamMemberships",
  "registrationInvitations",
  "externalUserLinks",
  "identityAuditEvents"
] as const;

export type MigrationEntityName = typeof MIGRATION_ENTITY_NAMES[number];
export type MigrationCounts = Record<MigrationEntityName, number>;
type MigrationFingerprints = Record<MigrationEntityName, string>;
type MigrationDataset = Record<MigrationEntityName, Array<Record<string, unknown>>>;

export interface SqliteToPostgresMigrationResult {
  outcome: "imported" | "verified-noop";
  migrationId: string;
  sourceSchemaVersion: number;
  destinationSchemaVersion: number;
  counts: MigrationCounts;
  semanticVerification: "passed";
}

export interface SqliteToPostgresMigrationOptions {
  sqlitePath: string;
  pool: pg.Pool;
  beforeCommit?: () => void | Promise<void>;
  allowUnsafeSourceState?: boolean;
}

export interface SqliteMigrationInspection {
  schemaVersion: number;
  counts: MigrationCounts;
  semanticVerification: "passed";
  operationalSafety: "passed" | "blocked";
  blockers: {
    activeReservations: number;
    inFlightProvisioningJobs: number;
    openTargetActivations: number;
  };
}

const sqliteExpectedColumns: Record<string, string[]> = {
  reservations: ["id", "username", "api_key_name", "profile_id", "profile_name", "model_ids", "target_ids", "created_at", "expires_at", "keepalive_minutes", "ended_at", "status", "failure_message", "synthetic"],
  reservation_profiles: ["id", "username", "name", "description", "selections", "default_duration_minutes", "default_keepalive_minutes", "created_at", "updated_at"],
  api_keys: ["id", "username", "name", "prefix", "key_hash", "created_at", "last_used_at"],
  auth_methods: ["id", "display_name", "type", "enabled", "config_json"],
  capacity_providers: ["id", "display_name", "type", "provisioning_enabled", "config", "credential_id"],
  capacity_targets: ["id", "target_json"],
  target_creation_jobs: ["id", "target_id", "job_json"],
  target_model_discoveries: ["target_id", "discovery_json", "discovered_at"],
  target_activations: ["id", "target_id", "started_at", "ended_at", "status", "estimated_hourly_cost_usd", "estimated_cost_usd", "last_costed_at"],
  target_activation_reservations: ["id", "target_activation_id", "reservation_id", "started_at", "ended_at", "estimated_cost_usd"]
};

const sqliteLegacyActivationColumns: Record<string, string[]> = {
  target_runs: ["id", "target_id", "started_at", "ended_at", "status", "estimated_hourly_cost_usd", "estimated_cost_usd", "last_costed_at"],
  target_run_reservation_links: ["id", "target_run_id", "reservation_id", "started_at", "ended_at", "estimated_cost_usd"]
};
const sqliteAdditiveExpectedColumns: Record<string, string[]> = {
  model_capability_metadata: ["model_id", "metadata_json", "updated_at"],
  model_deployment_metadata: ["target_id", "model_id", "metadata_json", "updated_at"],
  model_favorites: ["username", "target_id", "model_id", "created_at"],
  assistant_config: ["id", "target_id", "model_id", "reservation_minutes", "keepalive_minutes", "request_timeout_seconds", "updated_at"],
  users: ["id", "username", "normalized_username", "display_name", "status", "session_version", "merged_into_user_id", "created_at", "updated_at", "last_login_at"],
  user_identities: ["id", "user_id", "provider_type", "provider_id", "subject", "username", "email", "created_at", "last_seen_at"],
  local_credentials: ["user_id", "password_hash", "updated_at"],
  roles: ["id", "name", "description", "scope", "permissions", "system_key", "created_at", "updated_at"],
  user_role_assignments: ["user_id", "role_id", "created_at"],
  teams: ["id", "name", "description", "parent_team_id", "created_at", "updated_at"],
  team_hierarchy: ["ancestor_team_id", "descendant_team_id", "depth"],
  team_memberships: ["team_id", "user_id", "role_id", "source", "source_reference", "created_at"],
  registration_invitations: ["id", "token_hash", "user_id", "intended_username", "initial_role_id", "created_by_user_id", "expires_at", "max_uses", "use_count", "revoked_at", "created_at"],
  external_user_links: ["integration", "external_subject", "user_id", "source", "created_at", "last_seen_at"],
  identity_audit_events: ["id", "actor_user_id", "action", "subject_type", "subject_id", "details", "created_at"]
};
const sqliteAdditiveOptionalColumns: Record<string, string[]> = {
  assistant_config: ["additional_instructions", "audio_config"],
  model_favorites: ["user_id"]
};

const sqliteIntegerColumns = new Set([
  "reservations.keepalive_minutes",
  "reservations.synthetic",
  "reservation_profiles.default_duration_minutes",
  "reservation_profiles.default_keepalive_minutes",
  "auth_methods.enabled",
  "capacity_providers.provisioning_enabled",
  "assistant_config.reservation_minutes",
  "assistant_config.keepalive_minutes",
  "assistant_config.request_timeout_seconds",
  "users.session_version",
  "team_hierarchy.depth",
  "registration_invitations.max_uses",
  "registration_invitations.use_count"
]);
const sqliteRealColumns = new Set([
  "target_activations.estimated_hourly_cost_usd",
  "target_activations.estimated_cost_usd",
  "target_activation_reservations.estimated_cost_usd",
  "target_runs.estimated_hourly_cost_usd",
  "target_runs.estimated_cost_usd",
  "target_run_reservation_links.estimated_cost_usd"
]);
const sqliteNullableColumns = new Set([
  "reservations.api_key_name",
  "reservations.profile_id",
  "reservations.profile_name",
  "reservations.keepalive_minutes",
  "reservations.ended_at",
  "reservations.failure_message",
  "reservation_profiles.description",
  "reservation_profiles.default_duration_minutes",
  "reservation_profiles.default_keepalive_minutes",
  "api_keys.last_used_at",
  "capacity_providers.config",
  "capacity_providers.credential_id",
  "target_activations.ended_at",
  "target_activations.estimated_hourly_cost_usd",
  "target_activation_reservations.ended_at",
  "target_runs.ended_at",
  "target_runs.estimated_hourly_cost_usd",
  "target_run_reservation_links.ended_at",
  "users.display_name",
  "users.merged_into_user_id",
  "users.last_login_at",
  "user_identities.username",
  "user_identities.email",
  "roles.description",
  "roles.system_key",
  "teams.description",
  "teams.parent_team_id",
  "registration_invitations.user_id",
  "registration_invitations.intended_username",
  "registration_invitations.initial_role_id",
  "registration_invitations.created_by_user_id",
  "registration_invitations.revoked_at",
  "identity_audit_events.actor_user_id",
  "assistant_config.audio_config"
]);
const sqliteOptionalColumns: Record<string, string[]> = {
  reservations: ["target_selections", "user_id"],
  reservation_profiles: ["user_id", "team_id", "sharing_scope"],
  api_keys: ["user_id"]
};
const sqlitePrimaryKeyColumns = new Set([
  "reservations.id", "reservation_profiles.id", "api_keys.id", "auth_methods.id", "capacity_providers.id", "capacity_targets.id",
  "target_creation_jobs.id", "target_model_discoveries.target_id", "target_activations.id", "target_activation_reservations.id",
  "target_runs.id", "target_run_reservation_links.id", "model_capability_metadata.model_id",
  "model_deployment_metadata.target_id", "model_deployment_metadata.model_id",
  "model_favorites.username", "model_favorites.target_id", "model_favorites.model_id",
  "assistant_config.id",
  "users.id",
  "user_identities.id",
  "local_credentials.user_id",
  "roles.id",
  "user_role_assignments.user_id", "user_role_assignments.role_id",
  "teams.id",
  "team_hierarchy.ancestor_team_id", "team_hierarchy.descendant_team_id",
  "team_memberships.team_id", "team_memberships.user_id", "team_memberships.source", "team_memberships.source_reference",
  "registration_invitations.id",
  "external_user_links.integration", "external_user_links.external_subject",
  "identity_audit_events.id"
]);

export async function createConsistentSqliteBackup(
  sqlitePath: string,
  backupDirectory: string,
  now = new Date()
): Promise<string> {
  const source = path.resolve(sqlitePath);
  await assertRegularFile(source);
  await mkdir(path.resolve(backupDirectory), { recursive: true });
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const destination = path.resolve(backupDirectory, `neuron-sqlite-rollback-${timestamp}.db`);
  try {
    await stat(destination);
    throw new Error(`Backup destination already exists: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const db = openSqliteReadOnly(source);
  try {
    validateSqliteIntegrity(db);
    validateSqliteSchema(db);
    await db.backup(destination);
  } finally {
    db.close();
  }

  const backup = openSqliteReadOnly(destination);
  try {
    validateSqliteIntegrity(backup);
    validateSqliteSchema(backup);
  } finally {
    backup.close();
  }
  return destination;
}

export async function migrateSqliteToPostgres(options: SqliteToPostgresMigrationOptions): Promise<SqliteToPostgresMigrationResult> {
  await assertRegularFile(path.resolve(options.sqlitePath));
  const source = readSqliteDataset(options.sqlitePath);
  assertOperationallySafeSource(source, options.allowUnsafeSourceState ?? false);
  const counts = datasetCounts(source);
  const fingerprints = datasetFingerprints(source);
  const sourceFingerprint = fingerprint({ schemaVersion: SQLITE_SOURCE_SCHEMA_VERSION, counts, fingerprints });
  const migrationId = `sqlite-to-postgres-v${SQLITE_SOURCE_SCHEMA_VERSION}-${sourceFingerprint.slice(0, 24)}`;

  await preflightPostgresDestination(options.pool, migrationId);
  await migratePostgresSchema(options.pool);
  const schemaState = await readPostgresSchemaState(options.pool);
  if (schemaState.currentVersion !== POSTGRES_SCHEMA_VERSION) {
    throw new Error(`PostgreSQL schema version ${schemaState.currentVersion} is not supported; expected ${POSTGRES_SCHEMA_VERSION}`);
  }
  await validatePostgresSchema(options.pool);

  const client = await options.pool.connect();
  try {
    await client.query("begin isolation level serializable");
    await client.query("select pg_advisory_xact_lock($1)", [1_314_987_202]);

    const existingMigration = await client.query<{
      id: string;
      source_fingerprint: string;
      counts: MigrationCounts | string;
      fingerprints: MigrationFingerprints | string;
    }>("select id, source_fingerprint, counts, fingerprints from neuron_data_migrations where id = $1", [migrationId]);

    if (existingMigration.rows[0]) {
      const record = existingMigration.rows[0];
      const recordedCounts = jsonObject<MigrationCounts>(record.counts);
      const recordedFingerprints = jsonObject<MigrationFingerprints>(record.fingerprints);
      if (
        record.source_fingerprint !== sourceFingerprint ||
        canonicalJson(recordedCounts) !== canonicalJson(counts) ||
        canonicalJson(recordedFingerprints) !== canonicalJson(fingerprints)
      ) {
        throw new Error(`Migration identity ${migrationId} exists with incompatible verification metadata`);
      }
      const destination = await readPostgresDataset(client, source.roles.some((row) => row.systemKey != null));
      verifyDatasets(source, destination);
      await client.query("commit");
      return migrationResult("verified-noop", migrationId, counts);
    }

    const destinationCounts = await countPostgresDataRows(client);
    const nonempty = Object.entries(destinationCounts).filter(([, count]) => count > 0);
    if (nonempty.length > 0) {
      throw new Error(`PostgreSQL destination is nonempty without the exact completed migration record; refusing import (${nonempty.map(([name, count]) => `${name}=${count}`).join(", ")})`);
    }

    await importDataset(client, source);
    await client.query(
      `insert into neuron_data_migrations (id, source_fingerprint, counts, fingerprints, completed_at)
       values ($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [migrationId, sourceFingerprint, JSON.stringify(counts), JSON.stringify(fingerprints), new Date()]
    );

    const destination = await readPostgresDataset(client, source.roles.some((row) => row.systemKey != null));
    verifyDatasets(source, destination);
    await options.beforeCommit?.();
    await client.query("commit");
    return migrationResult("imported", migrationId, counts);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function inspectSqliteForMigration(sqlitePath: string): SqliteMigrationInspection {
  const dataset = readSqliteDataset(sqlitePath);
  datasetFingerprints(dataset);
  const blockers = sourceBlockers(dataset);
  return {
    schemaVersion: SQLITE_SOURCE_SCHEMA_VERSION,
    counts: datasetCounts(dataset),
    semanticVerification: "passed",
    operationalSafety: Object.values(blockers).some((count) => count > 0) ? "blocked" : "passed",
    blockers
  };
}

function readSqliteDataset(sqlitePath: string): MigrationDataset {
  const db = openSqliteReadOnly(path.resolve(sqlitePath));
  try {
    validateSqliteIntegrity(db);
    validateSqliteSchema(db);
    const targetActivations = [
      ...rows(db, "select * from target_activations order by id asc").map(sqliteActivationRow),
      ...(sqliteTableExists(db, "target_runs") ? rows(db, "select * from target_runs order by id asc").map(sqliteActivationRow) : [])
    ].sort(compareId);
    const targetActivationReservations = [
      ...rows(db, "select * from target_activation_reservations order by id asc").map((row) => sqliteActivationReservationRow(row, "target_activation_id")),
      ...(sqliteTableExists(db, "target_run_reservation_links")
        ? rows(db, "select * from target_run_reservation_links order by id asc").map((row) => sqliteActivationReservationRow(row, "target_run_id"))
        : [])
    ].sort(compareId);
    const capacityTargetRows = rows(db, "select * from capacity_targets order by id asc").map((row) => ({ id: text(row.id), target: json(row.target_json) }));
    const legacyAssistantConfigs = capacityTargetRows.flatMap((row) => {
      const config = assistantConfigFromLegacyTarget(row.target, row.id, new Date(0));
      return config ? [config] : [];
    });
    if (legacyAssistantConfigs.length > 1) throw new Error("SQLite source contains more than one legacy assistant configuration");
    const storedAssistantConfigs = optionalRows(db, "assistant_config", "select * from assistant_config order by id asc").map(sqliteAssistantConfigRow);
    if (storedAssistantConfigs.length > 1) throw new Error("SQLite source contains more than one assistant configuration");
    if (storedAssistantConfigs[0] && legacyAssistantConfigs[0] && !sameAssistantSelection(storedAssistantConfigs[0], legacyAssistantConfigs[0])) {
      throw new Error("SQLite stored and legacy assistant configuration disagree");
    }
    const assistantConfig = storedAssistantConfigs.length ? storedAssistantConfigs : legacyAssistantConfigs.map(assistantConfigDatasetRow);
    const rawReservations = rows(db, "select * from reservations order by id asc");
    const rawProfiles = rows(db, "select * from reservation_profiles order by id asc");
    const rawApiKeys = rows(db, "select * from api_keys order by id asc");
    const rawFavorites = optionalRows(db, "model_favorites", "select * from model_favorites order by username asc, target_id asc, model_id asc");
    const hasIdentitySchema = sqliteTableExists(db, "users");
    const users = hasIdentitySchema
      ? rows(db, "select * from users order by id asc").map(sqliteUserRow)
      : synthesizeLegacyUsers(rawReservations, rawProfiles, rawApiKeys, rawFavorites);
    const userIdByUsername = new Map(users.map((row) => [normalizeUsername(text(row.username)), text(row.id)]));
    const ownerId = (row: Record<string, unknown>, synthetic = false): string | null => {
      if (synthetic) return null;
      return row.user_id == null ? userIdByUsername.get(normalizeUsername(text(row.username))) ?? null : text(row.user_id);
    };
    const dataset: MigrationDataset = {
      reservations: rawReservations.map((row) => ({
        id: text(row.id), userId: ownerId(row, boolean(row.synthetic)), username: text(row.username), apiKeyName: nullableText(row.api_key_name), profileId: nullableText(row.profile_id), profileName: nullableText(row.profile_name),
        modelIds: json(row.model_ids), targetIds: json(row.target_ids), ...(row.target_selections === null || row.target_selections === undefined ? {} : { targetSelections: parseReservationTargetSelections(json(row.target_selections), "SQLite source reservations.target_selections") }), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), keepaliveMinutes: nullableNumber(row.keepalive_minutes),
        endedAt: nullableIso(row.ended_at), status: text(row.status), failureMessage: nullableText(row.failure_message), synthetic: boolean(row.synthetic)
      })),
      reservationProfiles: rawProfiles.map((row) => ({
        id: text(row.id), userId: ownerId(row), username: text(row.username), sharingScope: row.sharing_scope == null ? (nullableText(row.team_id) ? "team" : "personal") : text(row.sharing_scope), ...(nullableText(row.team_id) ? { teamId: nullableText(row.team_id) } : {}), name: text(row.name), description: nullableText(row.description), selections: json(row.selections),
        defaultDurationMinutes: nullableNumber(row.default_duration_minutes), defaultKeepaliveMinutes: nullableNumber(row.default_keepalive_minutes), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
      })),
      apiKeys: rawApiKeys.map((row) => ({
        id: text(row.id), userId: ownerId(row), username: text(row.username), name: text(row.name), prefix: text(row.prefix), keyHash: text(row.key_hash), createdAt: iso(row.created_at), lastUsedAt: nullableIso(row.last_used_at)
      })),
      authMethods: rows(db, "select * from auth_methods order by id asc").map((row) => ({
        id: text(row.id), displayName: text(row.display_name), type: text(row.type), enabled: boolean(row.enabled), config: json(row.config_json)
      })),
      capacityProviders: rows(db, "select * from capacity_providers order by id asc").map((row) => ({
        id: text(row.id), displayName: text(row.display_name), type: text(row.type), provisioningEnabled: boolean(row.provisioning_enabled), config: nullableJson(row.config), credentialId: nullableText(row.credential_id)
      })),
      capacityTargets: capacityTargetRows.map((row) => ({ ...row, target: withoutLegacyAssistant(row.target) })),
      targetProvisioningJobs: rows(db, "select * from target_creation_jobs order by id asc").map((row) => ({ id: text(row.id), targetId: text(row.target_id), job: json(row.job_json) })),
      targetModelDiscoveries: rows(db, "select * from target_model_discoveries order by target_id asc").map((row) => ({ targetId: text(row.target_id), discovery: json(row.discovery_json), discoveredAt: iso(row.discovered_at) })),
      targetActivations,
      targetActivationReservations,
      modelCapabilities: optionalRows(db, "model_capability_metadata", "select * from model_capability_metadata order by model_id asc").map((row) => ({ modelId: text(row.model_id), metadata: json(row.metadata_json), updatedAt: iso(row.updated_at) })),
      modelDeployments: optionalRows(db, "model_deployment_metadata", "select * from model_deployment_metadata order by target_id asc, model_id asc").map((row) => ({ targetId: text(row.target_id), modelId: text(row.model_id), metadata: json(row.metadata_json), updatedAt: iso(row.updated_at) })),
      modelFavorites: rawFavorites.map((row) => ({ userId: ownerId(row), username: text(row.username), targetId: text(row.target_id), modelId: text(row.model_id), createdAt: iso(row.created_at) })),
      assistantConfig,
      users,
      userIdentities: optionalRows(db, "user_identities", "select * from user_identities order by id asc").map((row) => ({
        id: text(row.id), userId: text(row.user_id), providerType: text(row.provider_type), providerId: text(row.provider_id), subject: text(row.subject),
        username: nullableText(row.username), email: nullableText(row.email), createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at)
      })),
      localCredentials: optionalRows(db, "local_credentials", "select * from local_credentials order by user_id asc").map((row) => ({ userId: text(row.user_id), passwordHash: text(row.password_hash), updatedAt: iso(row.updated_at) })),
      roles: optionalRows(db, "roles", "select * from roles order by id asc").map((row) => ({
        id: text(row.id), name: text(row.name), description: nullableText(row.description), scope: text(row.scope), permissions: json(row.permissions), systemKey: nullableText(row.system_key), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
      })),
      userRoleAssignments: hasIdentitySchema
        ? rows(db, "select * from user_role_assignments order by user_id asc, role_id asc").map((row) => ({ userId: text(row.user_id), roleId: text(row.role_id), createdAt: iso(row.created_at) }))
        : users.map((row) => ({ userId: row.id, roleId: "role_member", createdAt: row.createdAt })),
      teams: optionalRows(db, "teams", "select * from teams order by id asc").map((row) => ({ id: text(row.id), name: text(row.name), description: nullableText(row.description), parentTeamId: nullableText(row.parent_team_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
      teamHierarchy: optionalRows(db, "team_hierarchy", "select * from team_hierarchy order by ancestor_team_id asc, descendant_team_id asc").map((row) => ({ ancestorTeamId: text(row.ancestor_team_id), descendantTeamId: text(row.descendant_team_id), depth: number(row.depth) })),
      teamMemberships: optionalRows(db, "team_memberships", "select * from team_memberships order by team_id asc, user_id asc, source asc, source_reference asc").map((row) => ({ teamId: text(row.team_id), userId: text(row.user_id), roleId: text(row.role_id), source: text(row.source), sourceReference: text(row.source_reference), createdAt: iso(row.created_at) })),
      registrationInvitations: optionalRows(db, "registration_invitations", "select * from registration_invitations order by id asc").map((row) => ({
        id: text(row.id), tokenHash: text(row.token_hash), userId: nullableText(row.user_id), intendedUsername: nullableText(row.intended_username), initialRoleId: nullableText(row.initial_role_id),
        createdByUserId: nullableText(row.created_by_user_id), expiresAt: iso(row.expires_at), maxUses: number(row.max_uses), useCount: number(row.use_count), revokedAt: nullableIso(row.revoked_at), createdAt: iso(row.created_at)
      })),
      externalUserLinks: optionalRows(db, "external_user_links", "select * from external_user_links order by integration asc, external_subject asc").map((row) => ({ integration: text(row.integration), externalSubject: text(row.external_subject), userId: text(row.user_id), source: text(row.source), createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at) })),
      identityAuditEvents: optionalRows(db, "identity_audit_events", "select * from identity_audit_events order by id asc").map((row) => ({ id: text(row.id), actorUserId: nullableText(row.actor_user_id), action: text(row.action), subjectType: text(row.subject_type), subjectId: text(row.subject_id), details: json(row.details), createdAt: iso(row.created_at) }))
    };
    validateDatasetSemantics(dataset);
    return dataset;
  } finally {
    db.close();
  }
}

function sqliteUserRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: text(row.id), username: text(row.username), normalizedUsername: text(row.normalized_username), displayName: nullableText(row.display_name), status: text(row.status),
    sessionVersion: number(row.session_version), mergedIntoUserId: nullableText(row.merged_into_user_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), lastLoginAt: nullableIso(row.last_login_at)
  };
}

function synthesizeLegacyUsers(...families: Array<Array<Record<string, unknown>>>): Array<Record<string, unknown>> {
  const byUsername = new Map<string, { username: string; createdAt: string }>();
  for (const row of families.flat()) {
    if (row.synthetic != null && boolean(row.synthetic)) continue;
    const username = text(row.username).trim();
    const normalized = normalizeUsername(username);
    if (!normalized || ["traffic", "profile-advisor"].includes(normalized)) continue;
    const createdAt = iso(row.created_at);
    const existing = byUsername.get(normalized);
    if (!existing || createdAt < existing.createdAt) byUsername.set(normalized, { username, createdAt });
  }
  return Array.from(byUsername.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([normalizedUsername, value]) => ({
    id: legacyUserId(normalizedUsername), username: value.username, normalizedUsername, displayName: null, status: "active", sessionVersion: 1,
    mergedIntoUserId: null, createdAt: value.createdAt, updatedAt: value.createdAt, lastLoginAt: null
  }));
}

function sqliteAssistantConfigRow(row: Record<string, unknown>): Record<string, unknown> {
  const additionalInstructions = nullableText(row.additional_instructions);
  const rawAudio = nullableJsonObject(row.audio_config);
  let audio: ReturnType<typeof parseAssistantAudioConfig>;
  try { audio = parseAssistantAudioConfig(rawAudio ?? undefined); }
  catch { throw new Error("SQLite source contains incompatible Assistant audio configuration"); }
  return {
    id: text(row.id), targetId: text(row.target_id), modelId: text(row.model_id),
    reservationMinutes: number(row.reservation_minutes), keepaliveMinutes: number(row.keepalive_minutes),
    requestTimeoutSeconds: number(row.request_timeout_seconds), ...(additionalInstructions === null ? {} : { additionalInstructions }),
    ...(audio ? { audio } : {}), updatedAt: iso(row.updated_at)
  };
}

function assistantConfigDatasetRow(config: NonNullable<ReturnType<typeof assistantConfigFromLegacyTarget>>): Record<string, unknown> {
  return {
    id: config.id, targetId: config.targetId, modelId: config.modelId,
    reservationMinutes: config.reservationMinutes, keepaliveMinutes: config.keepaliveMinutes,
    requestTimeoutSeconds: config.requestTimeoutSeconds, ...(config.additionalInstructions ? { additionalInstructions: config.additionalInstructions } : {}), updatedAt: config.updatedAt.toISOString()
  };
}

function sameAssistantSelection(left: Record<string, unknown>, right: NonNullable<ReturnType<typeof assistantConfigFromLegacyTarget>>): boolean {
  return left.targetId === right.targetId && left.modelId === right.modelId;
}

function sqliteActivationRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: text(row.id), targetId: text(row.target_id), startedAt: iso(row.started_at), endedAt: nullableIso(row.ended_at), status: text(row.status),
    estimatedHourlyCostUsd: nullableNumber(row.estimated_hourly_cost_usd), estimatedCostUsd: number(row.estimated_cost_usd), lastCostedAt: iso(row.last_costed_at)
  };
}

function sqliteActivationReservationRow(row: Record<string, unknown>, activationIdColumn: string): Record<string, unknown> {
  return {
    id: text(row.id), targetActivationId: text(row[activationIdColumn]), reservationId: text(row.reservation_id), startedAt: iso(row.started_at),
    endedAt: nullableIso(row.ended_at), estimatedCostUsd: number(row.estimated_cost_usd)
  };
}

function sqliteTableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

function optionalRows(db: Database.Database, table: string, sql: string): Array<Record<string, unknown>> {
  return sqliteTableExists(db, table) ? rows(db, sql) : [];
}

function compareId(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftId = String(left.id);
  const rightId = String(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

async function readPostgresDataset(client: pg.PoolClient, includeSystemRoles: boolean): Promise<MigrationDataset> {
  const reservations = await client.query("select * from reservations order by id asc");
  const reservationProfiles = await client.query("select * from reservation_profiles order by id asc");
  const apiKeys = await client.query("select * from api_keys order by id asc");
  const authMethods = await client.query("select * from auth_methods order by id asc");
  const capacityProviders = await client.query("select * from capacity_providers order by id asc");
  const capacityTargets = await client.query("select * from capacity_targets order by id asc");
  const targetProvisioningJobs = await client.query("select * from target_creation_jobs order by id asc");
  const targetModelDiscoveries = await client.query("select * from target_model_discoveries order by target_id asc");
  const targetActivations = await client.query("select * from target_activations order by id asc");
  const targetActivationReservations = await client.query("select * from target_activation_reservations order by id asc");
  const modelCapabilities = await client.query("select * from model_capability_metadata order by model_id asc");
  const modelDeployments = await client.query("select * from model_deployment_metadata order by target_id asc, model_id asc");
  const modelFavorites = await client.query("select * from model_favorites order by username asc, target_id asc, model_id asc");
  const assistantConfig = await client.query("select * from assistant_config order by id asc");
  const users = await client.query("select * from users order by id asc");
  const userIdentities = await client.query("select * from user_identities order by id asc");
  const localCredentials = await client.query("select * from local_credentials order by user_id asc");
  const roles = await client.query(includeSystemRoles ? "select * from roles order by id asc" : "select * from roles where system_key is null order by id asc");
  const userRoleAssignments = await client.query("select * from user_role_assignments order by user_id asc,role_id asc");
  const teams = await client.query("select * from teams order by id asc");
  const teamHierarchy = await client.query("select * from team_hierarchy order by ancestor_team_id asc,descendant_team_id asc");
  const teamMemberships = await client.query("select * from team_memberships order by team_id asc,user_id asc,source asc,source_reference asc");
  const registrationInvitations = await client.query("select * from registration_invitations order by id asc");
  const externalUserLinks = await client.query("select * from external_user_links order by integration asc,external_subject asc");
  const identityAuditEvents = await client.query("select * from identity_audit_events order by id asc");
  return {
    reservations: reservations.rows.map((row) => ({
      id: text(row.id), userId: nullableText(row.user_id), username: text(row.username), apiKeyName: nullableText(row.api_key_name), profileId: nullableText(row.profile_id), profileName: nullableText(row.profile_name),
      modelIds: jsonObject(row.model_ids), targetIds: jsonObject(row.target_ids), ...(row.target_selections === null || row.target_selections === undefined ? {} : { targetSelections: parseReservationTargetSelections(jsonObject(row.target_selections), "PostgreSQL destination reservations.target_selections") }), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), keepaliveMinutes: nullableNumber(row.keepalive_minutes),
      endedAt: nullableIso(row.ended_at), status: text(row.status), failureMessage: nullableText(row.failure_message), synthetic: boolean(row.synthetic)
    })),
    reservationProfiles: reservationProfiles.rows.map((row) => ({
      id: text(row.id), userId: text(row.user_id), username: text(row.username), sharingScope: text(row.sharing_scope), ...(nullableText(row.team_id) ? { teamId: nullableText(row.team_id) } : {}), name: text(row.name), description: nullableText(row.description), selections: jsonObject(row.selections),
      defaultDurationMinutes: nullableNumber(row.default_duration_minutes), defaultKeepaliveMinutes: nullableNumber(row.default_keepalive_minutes), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
    })),
    apiKeys: apiKeys.rows.map((row) => ({
      id: text(row.id), userId: text(row.user_id), username: text(row.username), name: text(row.name), prefix: text(row.prefix), keyHash: text(row.key_hash), createdAt: iso(row.created_at), lastUsedAt: nullableIso(row.last_used_at)
    })),
    authMethods: authMethods.rows.map((row) => ({ id: text(row.id), displayName: text(row.display_name), type: text(row.type), enabled: boolean(row.enabled), config: jsonObject(row.config_json) })),
    capacityProviders: capacityProviders.rows.map((row) => ({
      id: text(row.id), displayName: text(row.display_name), type: text(row.type), provisioningEnabled: boolean(row.provisioning_enabled), config: nullableJsonObject(row.config), credentialId: nullableText(row.credential_id)
    })),
    capacityTargets: capacityTargets.rows.map((row) => ({ id: text(row.id), target: jsonObject(row.target_json) })),
    targetProvisioningJobs: targetProvisioningJobs.rows.map((row) => ({ id: text(row.id), targetId: text(row.target_id), job: jsonObject(row.job_json) })),
    targetModelDiscoveries: targetModelDiscoveries.rows.map((row) => ({ targetId: text(row.target_id), discovery: jsonObject(row.discovery_json), discoveredAt: iso(row.discovered_at) })),
    targetActivations: targetActivations.rows.map((row) => ({
      id: text(row.id), targetId: text(row.target_id), startedAt: iso(row.started_at), endedAt: nullableIso(row.ended_at), status: text(row.status),
      estimatedHourlyCostUsd: nullableNumber(row.estimated_hourly_cost_usd), estimatedCostUsd: number(row.estimated_cost_usd), lastCostedAt: iso(row.last_costed_at)
    })),
    targetActivationReservations: targetActivationReservations.rows.map((row) => ({
      id: text(row.id), targetActivationId: text(row.target_activation_id), reservationId: text(row.reservation_id), startedAt: iso(row.started_at),
      endedAt: nullableIso(row.ended_at), estimatedCostUsd: number(row.estimated_cost_usd)
    })),
    modelCapabilities: modelCapabilities.rows.map((row) => ({ modelId: text(row.model_id), metadata: jsonObject(row.metadata_json), updatedAt: iso(row.updated_at) })),
    modelDeployments: modelDeployments.rows.map((row) => ({ targetId: text(row.target_id), modelId: text(row.model_id), metadata: jsonObject(row.metadata_json), updatedAt: iso(row.updated_at) })),
    modelFavorites: modelFavorites.rows.map((row) => ({ userId: text(row.user_id), username: text(row.username), targetId: text(row.target_id), modelId: text(row.model_id), createdAt: iso(row.created_at) })),
    assistantConfig: assistantConfig.rows.map(sqliteAssistantConfigRow),
    users: users.rows.map((row) => ({ id: text(row.id), username: text(row.username), normalizedUsername: text(row.normalized_username), displayName: nullableText(row.display_name), status: text(row.status), sessionVersion: number(row.session_version), mergedIntoUserId: nullableText(row.merged_into_user_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), lastLoginAt: nullableIso(row.last_login_at) })),
    userIdentities: userIdentities.rows.map((row) => ({ id: text(row.id), userId: text(row.user_id), providerType: text(row.provider_type), providerId: text(row.provider_id), subject: text(row.subject), username: nullableText(row.username), email: nullableText(row.email), createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at) })),
    localCredentials: localCredentials.rows.map((row) => ({ userId: text(row.user_id), passwordHash: text(row.password_hash), updatedAt: iso(row.updated_at) })),
    roles: roles.rows.map((row) => ({ id: text(row.id), name: text(row.name), description: nullableText(row.description), scope: text(row.scope), permissions: jsonObject(row.permissions), systemKey: nullableText(row.system_key), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    userRoleAssignments: userRoleAssignments.rows.map((row) => ({ userId: text(row.user_id), roleId: text(row.role_id), createdAt: iso(row.created_at) })),
    teams: teams.rows.map((row) => ({ id: text(row.id), name: text(row.name), description: nullableText(row.description), parentTeamId: nullableText(row.parent_team_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    teamHierarchy: teamHierarchy.rows.map((row) => ({ ancestorTeamId: text(row.ancestor_team_id), descendantTeamId: text(row.descendant_team_id), depth: number(row.depth) })),
    teamMemberships: teamMemberships.rows.map((row) => ({ teamId: text(row.team_id), userId: text(row.user_id), roleId: text(row.role_id), source: text(row.source), sourceReference: text(row.source_reference), createdAt: iso(row.created_at) })),
    registrationInvitations: registrationInvitations.rows.map((row) => ({ id: text(row.id), tokenHash: text(row.token_hash), userId: nullableText(row.user_id), intendedUsername: nullableText(row.intended_username), initialRoleId: nullableText(row.initial_role_id), createdByUserId: nullableText(row.created_by_user_id), expiresAt: iso(row.expires_at), maxUses: number(row.max_uses), useCount: number(row.use_count), revokedAt: nullableIso(row.revoked_at), createdAt: iso(row.created_at) })),
    externalUserLinks: externalUserLinks.rows.map((row) => ({ integration: text(row.integration), externalSubject: text(row.external_subject), userId: text(row.user_id), source: text(row.source), createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at) })),
    identityAuditEvents: identityAuditEvents.rows.map((row) => ({ id: text(row.id), actorUserId: nullableText(row.actor_user_id), action: text(row.action), subjectType: text(row.subject_type), subjectId: text(row.subject_id), details: jsonObject(row.details), createdAt: iso(row.created_at) }))
  };
}

async function importDataset(client: pg.PoolClient, dataset: MigrationDataset): Promise<void> {
  for (const row of dataset.users) {
    await client.query(
      `insert into users (id,username,normalized_username,display_name,status,session_version,merged_into_user_id,created_at,updated_at,last_login_at)
       values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9)`,
      [row.id, row.username, row.normalizedUsername, row.displayName, row.status, row.sessionVersion, row.createdAt, row.updatedAt, row.lastLoginAt]
    );
  }
  for (const row of dataset.users.filter((candidate) => candidate.mergedIntoUserId != null)) {
    await client.query("update users set merged_into_user_id=$2 where id=$1", [row.id, row.mergedIntoUserId]);
  }
  for (const row of dataset.roles) {
    if (row.systemKey == null) await client.query(
      "insert into roles (id,name,description,scope,permissions,created_at,updated_at) values ($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [row.id, row.name, row.description, row.scope, JSON.stringify(row.permissions), row.createdAt, row.updatedAt]
    );
    else await client.query(
      "update roles set name=$2,description=$3,scope=$4,permissions=$5::jsonb,system_key=$6,created_at=$7,updated_at=$8 where id=$1",
      [row.id, row.name, row.description, row.scope, JSON.stringify(row.permissions), row.systemKey, row.createdAt, row.updatedAt]
    );
  }
  for (const row of dataset.userRoleAssignments) {
    await client.query("insert into user_role_assignments (user_id,role_id,created_at) values ($1,$2,$3)", [row.userId, row.roleId, row.createdAt]);
  }
  for (const row of dataset.userIdentities) {
    await client.query(
      `insert into user_identities (id,user_id,provider_type,provider_id,subject,username,email,created_at,last_seen_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.userId, row.providerType, row.providerId, row.subject, row.username, row.email, row.createdAt, row.lastSeenAt]
    );
  }
  for (const row of dataset.localCredentials) {
    await client.query("insert into local_credentials (user_id,password_hash,updated_at) values ($1,$2,$3)", [row.userId, row.passwordHash, row.updatedAt]);
  }
  for (const row of dataset.teams) {
    await client.query(
      "insert into teams (id,name,description,parent_team_id,created_at,updated_at) values ($1,$2,$3,null,$4,$5)",
      [row.id, row.name, row.description, row.createdAt, row.updatedAt]
    );
  }
  for (const row of dataset.teams.filter((candidate) => candidate.parentTeamId != null)) {
    await client.query("update teams set parent_team_id=$2 where id=$1", [row.id, row.parentTeamId]);
  }
  for (const row of dataset.teamHierarchy) {
    await client.query("insert into team_hierarchy (ancestor_team_id,descendant_team_id,depth) values ($1,$2,$3)", [row.ancestorTeamId, row.descendantTeamId, row.depth]);
  }
  for (const row of dataset.teamMemberships) {
    await client.query(
      "insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) values ($1,$2,$3,$4,$5,$6)",
      [row.teamId, row.userId, row.roleId, row.source, row.sourceReference, row.createdAt]
    );
  }
  for (const row of dataset.registrationInvitations) {
    await client.query(
      `insert into registration_invitations (id,token_hash,user_id,intended_username,initial_role_id,created_by_user_id,expires_at,max_uses,use_count,revoked_at,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.id, row.tokenHash, row.userId, row.intendedUsername, row.initialRoleId, row.createdByUserId, row.expiresAt, row.maxUses, row.useCount, row.revokedAt, row.createdAt]
    );
  }
  for (const row of dataset.externalUserLinks) {
    await client.query(
      "insert into external_user_links (integration,external_subject,user_id,source,created_at,last_seen_at) values ($1,$2,$3,$4,$5,$6)",
      [row.integration, row.externalSubject, row.userId, row.source, row.createdAt, row.lastSeenAt]
    );
  }
  for (const row of dataset.identityAuditEvents) {
    await client.query(
      "insert into identity_audit_events (id,actor_user_id,action,subject_type,subject_id,details,created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [row.id, row.actorUserId, row.action, row.subjectType, row.subjectId, JSON.stringify(row.details), row.createdAt]
    );
  }
  for (const row of dataset.reservations) {
    await client.query(
      `insert into reservations (id, user_id, username, api_key_name, profile_id, profile_name, model_ids, target_ids, target_selections, created_at, expires_at, keepalive_minutes, ended_at, status, failure_message, synthetic)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)`,
      [row.id, row.userId, row.username, row.apiKeyName, row.profileId, row.profileName, JSON.stringify(row.modelIds), JSON.stringify(row.targetIds), row.targetSelections == null ? null : JSON.stringify(row.targetSelections), row.createdAt, row.expiresAt, row.keepaliveMinutes, row.endedAt, row.status, row.failureMessage, row.synthetic]
    );
  }
  for (const row of dataset.reservationProfiles) {
    await client.query(
      `insert into reservation_profiles (id, user_id, username, sharing_scope, team_id, name, description, selections, default_duration_minutes, default_keepalive_minutes, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [row.id, row.userId, row.username, row.sharingScope, row.teamId ?? null, row.name, row.description, JSON.stringify(row.selections), row.defaultDurationMinutes, row.defaultKeepaliveMinutes, row.createdAt, row.updatedAt]
    );
  }
  for (const row of dataset.apiKeys) {
    await client.query("insert into api_keys (id, user_id, username, name, prefix, key_hash, created_at, last_used_at) values ($1,$2,$3,$4,$5,$6,$7,$8)", [row.id, row.userId, row.username, row.name, row.prefix, row.keyHash, row.createdAt, row.lastUsedAt]);
  }
  for (const row of dataset.authMethods) {
    await client.query("insert into auth_methods (id, display_name, type, enabled, config_json) values ($1,$2,$3,$4,$5::jsonb)", [row.id, row.displayName, row.type, row.enabled, JSON.stringify(row.config)]);
  }
  for (const row of dataset.capacityProviders) {
    await client.query("insert into capacity_providers (id, display_name, type, provisioning_enabled, config, credential_id) values ($1,$2,$3,$4,$5::jsonb,$6)", [row.id, row.displayName, row.type, row.provisioningEnabled, row.config === null ? null : JSON.stringify(row.config), row.credentialId]);
  }
  for (const row of dataset.capacityTargets) {
    await client.query("insert into capacity_targets (id, target_json) values ($1,$2::jsonb)", [row.id, JSON.stringify(row.target)]);
  }
  for (const row of dataset.targetProvisioningJobs) {
    await client.query("insert into target_creation_jobs (id, target_id, job_json) values ($1,$2,$3::jsonb)", [row.id, row.targetId, JSON.stringify(row.job)]);
  }
  for (const row of dataset.targetModelDiscoveries) {
    await client.query("insert into target_model_discoveries (target_id, discovery_json, discovered_at) values ($1,$2::jsonb,$3)", [row.targetId, JSON.stringify(row.discovery), row.discoveredAt]);
  }
  for (const row of dataset.targetActivations) {
    await client.query(
      `insert into target_activations (id, target_id, started_at, ended_at, status, estimated_hourly_cost_usd, estimated_cost_usd, last_costed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id, row.targetId, row.startedAt, row.endedAt, row.status, row.estimatedHourlyCostUsd, row.estimatedCostUsd, row.lastCostedAt]
    );
  }
  for (const row of dataset.targetActivationReservations) {
    await client.query(
      `insert into target_activation_reservations (id, target_activation_id, reservation_id, started_at, ended_at, estimated_cost_usd)
       values ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.targetActivationId, row.reservationId, row.startedAt, row.endedAt, row.estimatedCostUsd]
    );
  }
  for (const row of dataset.modelCapabilities) {
    await client.query("insert into model_capability_metadata (model_id, metadata_json, updated_at) values ($1,$2::jsonb,$3)", [row.modelId, JSON.stringify(row.metadata), row.updatedAt]);
  }
  for (const row of dataset.modelDeployments) {
    await client.query("insert into model_deployment_metadata (target_id, model_id, metadata_json, updated_at) values ($1,$2,$3::jsonb,$4)", [row.targetId, row.modelId, JSON.stringify(row.metadata), row.updatedAt]);
  }
  for (const row of dataset.modelFavorites) {
    await client.query("insert into model_favorites (user_id, username, target_id, model_id, created_at) values ($1,$2,$3,$4,$5)", [row.userId, row.username, row.targetId, row.modelId, row.createdAt]);
  }
  for (const row of dataset.assistantConfig) {
    await client.query(
      "insert into assistant_config (id, target_id, model_id, reservation_minutes, keepalive_minutes, request_timeout_seconds, additional_instructions, audio_config, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
      [row.id, row.targetId, row.modelId, row.reservationMinutes, row.keepaliveMinutes, row.requestTimeoutSeconds, row.additionalInstructions ?? null, row.audio ? JSON.stringify(row.audio) : null, row.updatedAt]
    );
  }
}

async function preflightPostgresDestination(pool: pg.Pool, migrationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const schemaState = await readPostgresSchemaState(client);
    if (schemaState.currentVersion > POSTGRES_SCHEMA_VERSION) throw new Error(`PostgreSQL schema version ${schemaState.currentVersion} is newer than supported version ${POSTGRES_SCHEMA_VERSION}`);

    const ledgerExists = await client.query<{ exists: boolean }>("select to_regclass('neuron_data_migrations') is not null as exists");
    const completedIds = ledgerExists.rows[0]?.exists
      ? (await client.query<{ id: string }>("select id from neuron_data_migrations order by id")).rows.map((row) => row.id)
      : [];
    const incompatibleIds = completedIds.filter((id) => id !== migrationId);
    if (incompatibleIds.length) throw new Error(`PostgreSQL destination contains a different completed data migration; refusing import (${incompatibleIds.length} record(s))`);
    if (completedIds.includes(migrationId)) {
      await client.query("commit");
      return;
    }

    const nonempty: string[] = [];
    for (const table of POSTGRES_DATA_TABLES) {
      const exists = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [table]);
      if (!exists.rows[0]?.exists) continue;
      const result = await client.query<{ count: string }>(table === "roles"
        ? "select count(*)::text as count from roles where system_key is null"
        : `select count(*)::text as count from ${table}`);
      const count = Number(result.rows[0]?.count ?? 0);
      if (count > 0) nonempty.push(`${table}=${count}`);
    }
    if (nonempty.length) throw new Error(`PostgreSQL destination is nonempty without the exact completed migration record; refusing import (${nonempty.join(", ")})`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function countPostgresDataRows(client: pg.PoolClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of POSTGRES_DATA_TABLES) {
    const result = await client.query<{ count: string }>(
      table === "roles"
        ? "select count(*)::text as count from roles where system_key is null"
        : `select count(*)::text as count from ${table}`
    );
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

function validateSqliteIntegrity(db: Database.Database): void {
  const integrity = db.pragma("integrity_check") as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new Error("SQLite integrity_check failed");
  const foreignKeyProblems = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (foreignKeyProblems.length > 0) throw new Error(`SQLite foreign_key_check failed with ${foreignKeyProblems.length} problem(s)`);
}

function validateSqliteSchema(db: Database.Database): void {
  const tables = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  const problems: string[] = [];
  const allowedTables = new Set([...Object.keys(sqliteExpectedColumns), ...Object.keys(sqliteLegacyActivationColumns), ...Object.keys(sqliteAdditiveExpectedColumns)]);
  for (const table of tables) {
    if (!allowedTables.has(table) && !table.startsWith("sqlite_")) problems.push(`unexpected table ${table}`);
  }
  for (const [table, expected] of Object.entries(sqliteExpectedColumns)) {
    if (!tables.has(table)) {
      problems.push(`missing table ${table}`);
      continue;
    }
    validateSqliteTable(db, table, expected, problems, sqliteOptionalColumns[table] ?? []);
  }
  for (const [table, expected] of Object.entries(sqliteAdditiveExpectedColumns)) {
    if (tables.has(table)) validateSqliteTable(db, table, expected, problems, sqliteAdditiveOptionalColumns[table] ?? []);
  }
  const identityTables = ["users", "user_identities", "local_credentials", "roles", "user_role_assignments", "teams", "team_hierarchy", "team_memberships", "registration_invitations", "external_user_links", "identity_audit_events"];
  const presentIdentityTables = identityTables.filter((table) => tables.has(table));
  if (presentIdentityTables.length !== 0 && presentIdentityTables.length !== identityTables.length) {
    problems.push("identity tables must either all be present or all be absent");
  }
  const legacyTables = Object.keys(sqliteLegacyActivationColumns);
  const presentLegacyTables = legacyTables.filter((table) => tables.has(table));
  if (presentLegacyTables.length !== 0 && presentLegacyTables.length !== legacyTables.length) {
    problems.push("legacy target run tables must either both be present or both be absent");
  }
  if (presentLegacyTables.length === legacyTables.length) {
    for (const table of legacyTables) validateSqliteTable(db, table, sqliteLegacyActivationColumns[table], problems);
  }
  if (problems.length > 0) throw new Error(`SQLite source schema is incompatible with version ${SQLITE_SOURCE_SCHEMA_VERSION}: ${problems.join("; ")}`);
}

function validateSqliteTable(db: Database.Database, table: string, expected: string[], problems: string[], optional: string[] = []): void {
  const tableInfo = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const columns = new Map(tableInfo.map((row) => [row.name, row]));
  for (const column of expected) {
    const actual = columns.get(column);
    const key = `${table}.${column}`;
    if (!actual) {
      problems.push(`missing ${key}`);
      continue;
    }
    const expectedType = sqliteIntegerColumns.has(key) ? "INTEGER" : sqliteRealColumns.has(key) ? "REAL" : "TEXT";
    if (actual.type.toUpperCase() !== expectedType) problems.push(`${key} has type ${actual.type || "untyped"}, expected ${expectedType}`);
    const isPrimaryKey = sqlitePrimaryKeyColumns.has(key);
    if (isPrimaryKey && actual.pk < 1) problems.push(`${key} is not part of the primary key`);
    if (!isPrimaryKey && !sqliteNullableColumns.has(key) && actual.notnull !== 1) problems.push(`${key} nullability is incompatible`);
  }
  for (const column of optional) {
    const actual = columns.get(column);
    if (actual && actual.type.toUpperCase() !== "TEXT") problems.push(`${table}.${column} has type ${actual.type || "untyped"}, expected TEXT`);
  }
  for (const column of columns.keys()) {
    if (!expected.includes(column) && !optional.includes(column)) problems.push(`unexpected ${table}.${column}`);
  }
}

function validateDatasetSemantics(dataset: MigrationDataset): void {
  const reservationStatuses = new Set(["active", "done", "expired", "failed"]);
  const activationStatuses = new Set(["open", "closed"]);
  const provisioningStatuses = new Set(["draft", "running", "completed", "failed", "aborting", "aborted"]);
  const capabilities = dataset.modelCapabilities.map((row) => {
    if (!row.metadata || typeof row.metadata !== "object" || String((row.metadata as Record<string, unknown>).modelId) !== String(row.modelId)) throw new Error("SQLite source contains incompatible model capability metadata");
    return row.metadata;
  });
  const deployments = dataset.modelDeployments.map((row) => {
    if (!row.metadata || typeof row.metadata !== "object" || String((row.metadata as Record<string, unknown>).targetId) !== String(row.targetId) || String((row.metadata as Record<string, unknown>).modelId) !== String(row.modelId)) throw new Error("SQLite source contains incompatible model deployment metadata");
    return row.metadata;
  });
  parseModelSelectionCatalog({ schemaVersion: 1, models: capabilities, deployments });
  const users = new Map(dataset.users.map((row) => [String(row.id), row]));
  const normalizedUsernames = new Set<string>();
  for (const user of users.values()) {
    const normalized = normalizeUsername(String(user.username));
    if (!normalized || normalized !== user.normalizedUsername || normalizedUsernames.has(normalized)) throw new Error("SQLite source contains incompatible users");
    if (!new Set(["active", "disabled"]).has(String(user.status)) || !boundedInteger(user.sessionVersion, 1, Number.MAX_SAFE_INTEGER)) throw new Error("SQLite source contains incompatible user state");
    if (user.mergedIntoUserId != null && (!users.has(String(user.mergedIntoUserId)) || user.mergedIntoUserId === user.id)) throw new Error("SQLite source contains an incompatible user merge link");
    normalizedUsernames.add(normalized);
  }
  const roleIds = new Set([...BUILTIN_ROLE_IDS, ...dataset.roles.map((row) => String(row.id))]);
  for (const role of dataset.roles) {
    if (!new Set(["global", "team"]).has(String(role.scope)) || !Array.isArray(role.permissions) || role.permissions.some((permission) => typeof permission !== "string" || !permission)) throw new Error("SQLite source contains an incompatible custom role");
  }
  for (const assignment of dataset.userRoleAssignments) if (!users.has(String(assignment.userId)) || !roleIds.has(String(assignment.roleId))) throw new Error("SQLite source contains an orphaned user role assignment");
  for (const identity of dataset.userIdentities) if (!users.has(String(identity.userId)) || !new Set(["local", "github", "oidc"]).has(String(identity.providerType))) throw new Error("SQLite source contains an incompatible user identity");
  for (const credential of dataset.localCredentials) if (!users.has(String(credential.userId)) || typeof credential.passwordHash !== "string" || !credential.passwordHash) throw new Error("SQLite source contains an incompatible local credential");
  const teams = new Map(dataset.teams.map((row) => [String(row.id), row]));
  for (const team of teams.values()) if (team.parentTeamId != null && (!teams.has(String(team.parentTeamId)) || team.parentTeamId === team.id)) throw new Error("SQLite source contains an incompatible team parent");
  for (const link of dataset.teamHierarchy) if (!teams.has(String(link.ancestorTeamId)) || !teams.has(String(link.descendantTeamId)) || !boundedInteger(link.depth, 0, Number.MAX_SAFE_INTEGER)) throw new Error("SQLite source contains an incompatible team hierarchy");
  for (const membership of dataset.teamMemberships) if (!teams.has(String(membership.teamId)) || !users.has(String(membership.userId)) || !roleIds.has(String(membership.roleId)) || !new Set(["manual", "oidc"]).has(String(membership.source))) throw new Error("SQLite source contains an incompatible team membership");
  for (const invitation of dataset.registrationInvitations) {
    if ((invitation.userId != null && !users.has(String(invitation.userId))) || (invitation.createdByUserId != null && !users.has(String(invitation.createdByUserId))) || (invitation.initialRoleId != null && !roleIds.has(String(invitation.initialRoleId))) || !boundedInteger(invitation.maxUses, 1, Number.MAX_SAFE_INTEGER) || !boundedInteger(invitation.useCount, 0, Number.MAX_SAFE_INTEGER)) throw new Error("SQLite source contains an incompatible registration invitation");
  }
  for (const link of dataset.externalUserLinks) if (!users.has(String(link.userId)) || !new Set(["metadata", "rule", "admin"]).has(String(link.source))) throw new Error("SQLite source contains an incompatible external user link");
  for (const event of dataset.identityAuditEvents) if (event.actorUserId != null && !users.has(String(event.actorUserId))) throw new Error("SQLite source contains an incompatible identity audit event");
  if (dataset.assistantConfig.length > 1) throw new Error("SQLite source contains more than one assistant configuration");
  const targetIds = new Set(dataset.capacityTargets.map((row) => String(row.id)));
  for (const row of dataset.assistantConfig) {
    if (row.id !== "default" || !targetIds.has(String(row.targetId)) || typeof row.modelId !== "string" || !row.modelId) {
      throw new Error("SQLite source contains incompatible assistant configuration");
    }
    if (!boundedInteger(row.reservationMinutes, 1, 720) || !boundedInteger(row.keepaliveMinutes, 1, 60) || !boundedInteger(row.requestTimeoutSeconds, 1, 600)) {
      throw new Error("SQLite source contains out-of-range assistant configuration");
    }
    if (row.additionalInstructions != null && (typeof row.additionalInstructions !== "string" || row.additionalInstructions.length > 8_000)) {
      throw new Error("SQLite source contains incompatible Assistant instructions");
    }
    if (row.audio != null && (!row.audio || typeof row.audio !== "object" || Array.isArray(row.audio))) {
      throw new Error("SQLite source contains incompatible Assistant audio configuration");
    }
  }
  if (dataset.reservations.some((row) => !reservationStatuses.has(String(row.status)))) {
    throw new Error("SQLite source contains an unsupported reservation status");
  }
  for (const row of dataset.reservations) {
    if (!row.synthetic && (!row.userId || !users.has(String(row.userId)))) throw new Error("SQLite source contains a reservation without a durable owner");
    const targetIds = stringArray(row.targetIds, "reservation target IDs");
    const modelIds = new Set(stringArray(row.modelIds, "reservation model IDs"));
    const selections = row.targetSelections === undefined ? undefined : parseReservationTargetSelections(row.targetSelections, "reservation target selections");
    if (selections) {
      if (selections.length !== targetIds.length || selections.some((selection) => !targetIds.includes(selection.targetId))) {
        throw new Error("SQLite source reservation target selections do not match target IDs");
      }
      if (selections.some((selection) => selection.modelIds.some((modelId) => !modelIds.has(modelId)))) {
        throw new Error("SQLite source reservation target selections do not match model IDs");
      }
    }
  }
  for (const family of [dataset.reservationProfiles, dataset.apiKeys, dataset.modelFavorites]) {
    if (family.some((row) => !row.userId || !users.has(String(row.userId)))) throw new Error("SQLite source contains durable user data without an owner");
  }
  for (const profile of dataset.reservationProfiles) {
    if (!(["personal", "everyone", "team"] as unknown[]).includes(profile.sharingScope)) throw new Error("SQLite source contains an invalid profile sharing scope");
    if (profile.teamId != null && !teams.has(String(profile.teamId))) throw new Error("SQLite source contains a profile assigned to an unknown team");
    if ((profile.sharingScope === "team") !== (profile.teamId != null)) throw new Error("SQLite source contains an inconsistent profile sharing scope");
  }
  if (dataset.targetActivations.some((row) => !activationStatuses.has(String(row.status)))) {
    throw new Error("SQLite source contains an unsupported target activation status");
  }
  if (dataset.targetProvisioningJobs.some((row) => {
    const job = row.job;
    return !job || typeof job !== "object" || !provisioningStatuses.has(String((job as Record<string, unknown>).status));
  })) {
    throw new Error("SQLite source contains an unsupported target provisioning job status");
  }
  const reservationIds = new Set(dataset.reservations.map((row) => String(row.id)));
  const activationIds = new Set(dataset.targetActivations.map((row) => String(row.id)));
  if (activationIds.size !== dataset.targetActivations.length) {
    throw new Error("SQLite source contains duplicate target activation IDs across current and legacy tables");
  }
  const linkIds = new Set(dataset.targetActivationReservations.map((row) => String(row.id)));
  if (linkIds.size !== dataset.targetActivationReservations.length) {
    throw new Error("SQLite source contains duplicate target activation reservation IDs across current and legacy tables");
  }
  const linkKeys = new Set<string>();
  for (const row of dataset.targetActivationReservations) {
    if (!reservationIds.has(String(row.reservationId)) || !activationIds.has(String(row.targetActivationId))) {
      throw new Error("SQLite source contains an orphaned target activation reservation link");
    }
    const key = `${String(row.targetActivationId)}\u0000${String(row.reservationId)}`;
    if (linkKeys.has(key)) throw new Error("SQLite source contains duplicate target activation reservation links");
    linkKeys.add(key);
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function verifyDatasets(source: MigrationDataset, destination: MigrationDataset): void {
  const sourceCounts = datasetCounts(source);
  const destinationCounts = datasetCounts(destination);
  if (canonicalJson(sourceCounts) !== canonicalJson(destinationCounts)) throw new Error("Source and destination entity counts differ");
  const sourceFingerprints = datasetFingerprints(source);
  const destinationFingerprints = datasetFingerprints(destination);
  if (canonicalJson(sourceFingerprints) !== canonicalJson(destinationFingerprints)) throw new Error("Source and destination semantic fingerprints differ");
}

function assertOperationallySafeSource(dataset: MigrationDataset, allowUnsafeSourceState: boolean): void {
  if (allowUnsafeSourceState) return;
  const blockers = sourceBlockers(dataset);
  if (Object.values(blockers).some((count) => count > 0)) {
    throw new Error(
      `SQLite source has unsafe live lifecycle state; refusing cutover (activeReservations=${blockers.activeReservations}, inFlightProvisioningJobs=${blockers.inFlightProvisioningJobs}, openTargetActivations=${blockers.openTargetActivations})`
    );
  }
}

function sourceBlockers(dataset: MigrationDataset): SqliteMigrationInspection["blockers"] {
  const inFlightStatuses = new Set(["running", "aborting"]);
  return {
    activeReservations: dataset.reservations.filter((row) => row.status === "active").length,
    inFlightProvisioningJobs: dataset.targetProvisioningJobs.filter((row) => {
      const job = row.job;
      return Boolean(job && typeof job === "object" && inFlightStatuses.has(String((job as Record<string, unknown>).status)));
    }).length,
    openTargetActivations: dataset.targetActivations.filter((row) => row.status === "open").length
  };
}

function datasetCounts(dataset: MigrationDataset): MigrationCounts {
  return Object.fromEntries(MIGRATION_ENTITY_NAMES.map((name) => [name, dataset[name].length])) as MigrationCounts;
}

function datasetFingerprints(dataset: MigrationDataset): MigrationFingerprints {
  return Object.fromEntries(MIGRATION_ENTITY_NAMES.map((name) => [name, fingerprint(dataset[name])])) as MigrationFingerprints;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

function openSqliteReadOnly(sqlitePath: string): Database.Database {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  db.pragma("foreign_keys = ON");
  return db;
}

function rows(db: Database.Database, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}

async function assertRegularFile(filePath: string): Promise<void> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`SQLite source does not exist or is not a regular file: ${filePath}`);
}

function migrationResult(outcome: SqliteToPostgresMigrationResult["outcome"], migrationId: string, counts: MigrationCounts): SqliteToPostgresMigrationResult {
  return {
    outcome,
    migrationId,
    sourceSchemaVersion: SQLITE_SOURCE_SCHEMA_VERSION,
    destinationSchemaVersion: POSTGRES_SCHEMA_VERSION,
    counts,
    semanticVerification: "passed"
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Migration source contains an invalid text value");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Migration source contains an invalid numeric value");
  return parsed;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : number(value);
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error("Migration source contains an invalid boolean value");
}

function iso(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) throw new Error("Migration source contains an invalid timestamp value");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Migration source contains an invalid timestamp value");
  return date.toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function json(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Migration source contains invalid JSON storage");
  return JSON.parse(value) as unknown;
}

function nullableJson(value: unknown): unknown | null {
  return value === null || value === undefined ? null : json(value);
}

function jsonObject<T = unknown>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function nullableJsonObject(value: unknown): unknown | null {
  return value === null || value === undefined ? null : jsonObject(value);
}

const BUILTIN_ROLE_IDS = new Set([
  "role_owner", "role_admin", "role_operator", "role_member", "role_viewer",
  "role_team_owner", "role_team_manager", "role_team_member", "role_team_viewer"
]);

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function legacyUserId(normalizedUsername: string): string {
  return `usr_${createHash("sha256").update(normalizedUsername).digest("hex").slice(0, 24)}`;
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`SQLite source contains invalid ${context}`);
  }
  return value as string[];
}
