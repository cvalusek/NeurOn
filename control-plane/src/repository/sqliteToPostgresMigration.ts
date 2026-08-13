import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { migratePostgresSchema, POSTGRES_DATA_TABLES, POSTGRES_SCHEMA_VERSION, readPostgresSchemaState, validatePostgresSchema } from "./postgresSchema.js";
import { parseReservationTargetSelections } from "../domain/reservationSelections.js";

export const SQLITE_SOURCE_SCHEMA_VERSION = 1;

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
  "targetActivationReservations"
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

const sqliteIntegerColumns = new Set([
  "reservations.keepalive_minutes",
  "reservations.synthetic",
  "reservation_profiles.default_duration_minutes",
  "reservation_profiles.default_keepalive_minutes",
  "auth_methods.enabled",
  "capacity_providers.provisioning_enabled"
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
  "target_run_reservation_links.ended_at"
]);
const sqliteOptionalColumns: Record<string, string[]> = {
  reservations: ["target_selections"]
};

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
      const destination = await readPostgresDataset(client);
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

    const destination = await readPostgresDataset(client);
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
    const dataset: MigrationDataset = {
      reservations: rows(db, "select * from reservations order by id asc").map((row) => ({
        id: text(row.id), username: text(row.username), apiKeyName: nullableText(row.api_key_name), profileId: nullableText(row.profile_id), profileName: nullableText(row.profile_name),
        modelIds: json(row.model_ids), targetIds: json(row.target_ids), ...(row.target_selections === null || row.target_selections === undefined ? {} : { targetSelections: parseReservationTargetSelections(json(row.target_selections), "SQLite source reservations.target_selections") }), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), keepaliveMinutes: nullableNumber(row.keepalive_minutes),
        endedAt: nullableIso(row.ended_at), status: text(row.status), failureMessage: nullableText(row.failure_message), synthetic: boolean(row.synthetic)
      })),
      reservationProfiles: rows(db, "select * from reservation_profiles order by id asc").map((row) => ({
        id: text(row.id), username: text(row.username), name: text(row.name), description: nullableText(row.description), selections: json(row.selections),
        defaultDurationMinutes: nullableNumber(row.default_duration_minutes), defaultKeepaliveMinutes: nullableNumber(row.default_keepalive_minutes), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
      })),
      apiKeys: rows(db, "select * from api_keys order by id asc").map((row) => ({
        id: text(row.id), username: text(row.username), name: text(row.name), prefix: text(row.prefix), keyHash: text(row.key_hash), createdAt: iso(row.created_at), lastUsedAt: nullableIso(row.last_used_at)
      })),
      authMethods: rows(db, "select * from auth_methods order by id asc").map((row) => ({
        id: text(row.id), displayName: text(row.display_name), type: text(row.type), enabled: boolean(row.enabled), config: json(row.config_json)
      })),
      capacityProviders: rows(db, "select * from capacity_providers order by id asc").map((row) => ({
        id: text(row.id), displayName: text(row.display_name), type: text(row.type), provisioningEnabled: boolean(row.provisioning_enabled), config: nullableJson(row.config), credentialId: nullableText(row.credential_id)
      })),
      capacityTargets: rows(db, "select * from capacity_targets order by id asc").map((row) => ({ id: text(row.id), target: json(row.target_json) })),
      targetProvisioningJobs: rows(db, "select * from target_creation_jobs order by id asc").map((row) => ({ id: text(row.id), targetId: text(row.target_id), job: json(row.job_json) })),
      targetModelDiscoveries: rows(db, "select * from target_model_discoveries order by target_id asc").map((row) => ({ targetId: text(row.target_id), discovery: json(row.discovery_json), discoveredAt: iso(row.discovered_at) })),
      targetActivations,
      targetActivationReservations
    };
    validateDatasetSemantics(dataset);
    return dataset;
  } finally {
    db.close();
  }
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

function compareId(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftId = String(left.id);
  const rightId = String(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

async function readPostgresDataset(client: pg.PoolClient): Promise<MigrationDataset> {
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
  return {
    reservations: reservations.rows.map((row) => ({
      id: text(row.id), username: text(row.username), apiKeyName: nullableText(row.api_key_name), profileId: nullableText(row.profile_id), profileName: nullableText(row.profile_name),
      modelIds: jsonObject(row.model_ids), targetIds: jsonObject(row.target_ids), ...(row.target_selections === null || row.target_selections === undefined ? {} : { targetSelections: parseReservationTargetSelections(jsonObject(row.target_selections), "PostgreSQL destination reservations.target_selections") }), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), keepaliveMinutes: nullableNumber(row.keepalive_minutes),
      endedAt: nullableIso(row.ended_at), status: text(row.status), failureMessage: nullableText(row.failure_message), synthetic: boolean(row.synthetic)
    })),
    reservationProfiles: reservationProfiles.rows.map((row) => ({
      id: text(row.id), username: text(row.username), name: text(row.name), description: nullableText(row.description), selections: jsonObject(row.selections),
      defaultDurationMinutes: nullableNumber(row.default_duration_minutes), defaultKeepaliveMinutes: nullableNumber(row.default_keepalive_minutes), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
    })),
    apiKeys: apiKeys.rows.map((row) => ({
      id: text(row.id), username: text(row.username), name: text(row.name), prefix: text(row.prefix), keyHash: text(row.key_hash), createdAt: iso(row.created_at), lastUsedAt: nullableIso(row.last_used_at)
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
    }))
  };
}

async function importDataset(client: pg.PoolClient, dataset: MigrationDataset): Promise<void> {
  for (const row of dataset.reservations) {
    await client.query(
      `insert into reservations (id, username, api_key_name, profile_id, profile_name, model_ids, target_ids, target_selections, created_at, expires_at, keepalive_minutes, ended_at, status, failure_message, synthetic)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
      [row.id, row.username, row.apiKeyName, row.profileId, row.profileName, JSON.stringify(row.modelIds), JSON.stringify(row.targetIds), row.targetSelections == null ? null : JSON.stringify(row.targetSelections), row.createdAt, row.expiresAt, row.keepaliveMinutes, row.endedAt, row.status, row.failureMessage, row.synthetic]
    );
  }
  for (const row of dataset.reservationProfiles) {
    await client.query(
      `insert into reservation_profiles (id, username, name, description, selections, default_duration_minutes, default_keepalive_minutes, created_at, updated_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [row.id, row.username, row.name, row.description, JSON.stringify(row.selections), row.defaultDurationMinutes, row.defaultKeepaliveMinutes, row.createdAt, row.updatedAt]
    );
  }
  for (const row of dataset.apiKeys) {
    await client.query("insert into api_keys (id, username, name, prefix, key_hash, created_at, last_used_at) values ($1,$2,$3,$4,$5,$6,$7)", [row.id, row.username, row.name, row.prefix, row.keyHash, row.createdAt, row.lastUsedAt]);
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
}

async function countPostgresDataRows(client: pg.PoolClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of POSTGRES_DATA_TABLES) {
    const result = await client.query<{ count: string }>(`select count(*)::text as count from ${table}`);
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
  const allowedTables = new Set([...Object.keys(sqliteExpectedColumns), ...Object.keys(sqliteLegacyActivationColumns)]);
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
    const isPrimaryKey = column === "id" || (table === "target_model_discoveries" && column === "target_id");
    if (isPrimaryKey && actual.pk !== 1) problems.push(`${key} is not the primary key`);
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
  if (dataset.reservations.some((row) => !reservationStatuses.has(String(row.status)))) {
    throw new Error("SQLite source contains an unsupported reservation status");
  }
  for (const row of dataset.reservations) {
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

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`SQLite source contains invalid ${context}`);
  }
  return value as string[];
}
