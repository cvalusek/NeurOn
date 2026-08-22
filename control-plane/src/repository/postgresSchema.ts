import { createHash } from "node:crypto";
import type pg from "pg";

export const POSTGRES_SCHEMA_VERSION = 6;

export const POSTGRES_DATA_TABLES = [
  "reservations",
  "reservation_profiles",
  "api_keys",
  "auth_methods",
  "capacity_providers",
  "capacity_targets",
  "target_creation_jobs",
  "target_model_discoveries",
  "target_activations",
  "target_activation_reservations",
  "model_capability_metadata",
  "model_deployment_metadata",
  "model_favorites",
  "assistant_config",
  "users",
  "user_identities",
  "local_credentials",
  "roles",
  "user_role_assignments",
  "teams",
  "team_hierarchy",
  "team_memberships",
  "registration_invitations",
  "external_user_links",
  "identity_audit_events"
] as const;

const schemaVersionOneSql = `
  create table if not exists reservations (
    id text primary key,
    username text not null,
    api_key_name text,
    profile_id text,
    profile_name text,
    model_ids jsonb not null,
    target_ids jsonb not null,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    keepalive_minutes integer,
    ended_at timestamptz,
    status text not null check (status in ('active', 'done', 'expired', 'failed')),
    failure_message text,
    synthetic boolean not null default false
  );
  alter table reservations add column if not exists api_key_name text;
  alter table reservations add column if not exists profile_id text;
  alter table reservations add column if not exists profile_name text;
  create index if not exists idx_reservations_status_expires_at on reservations(status, expires_at);

  create table if not exists reservation_profiles (
    id text primary key,
    username text not null,
    name text not null,
    description text,
    selections jsonb not null,
    default_duration_minutes integer,
    default_keepalive_minutes integer,
    created_at timestamptz not null,
    updated_at timestamptz not null
  );
  create index if not exists idx_reservation_profiles_username_name on reservation_profiles(username, name);

  create table if not exists api_keys (
    id text primary key,
    username text not null,
    name text not null,
    prefix text not null,
    key_hash text not null,
    created_at timestamptz not null,
    last_used_at timestamptz
  );
  create index if not exists idx_api_keys_username_created_at on api_keys(username, created_at);

  create table if not exists auth_methods (
    id text primary key,
    display_name text not null,
    type text not null,
    enabled boolean not null,
    config_json jsonb not null
  );

  create table if not exists capacity_providers (
    id text primary key,
    display_name text not null,
    type text not null,
    provisioning_enabled boolean not null default false,
    config jsonb,
    credential_id text
  );
  alter table capacity_providers add column if not exists provisioning_enabled boolean not null default false;

  create table if not exists capacity_targets (
    id text primary key,
    target_json jsonb not null
  );

  create table if not exists target_creation_jobs (
    id text primary key,
    target_id text not null,
    job_json jsonb not null
  );
  create index if not exists idx_target_creation_jobs_target_id on target_creation_jobs(target_id);

  create table if not exists target_model_discoveries (
    target_id text primary key,
    discovery_json jsonb not null,
    discovered_at timestamptz not null
  );

  create table if not exists target_activations (
    id text primary key,
    target_id text not null,
    started_at timestamptz not null,
    ended_at timestamptz,
    status text not null check (status in ('open', 'closed')),
    estimated_hourly_cost_usd numeric,
    estimated_cost_usd numeric not null default 0,
    last_costed_at timestamptz not null
  );
  create index if not exists idx_target_activations_target_status on target_activations(target_id, status, started_at);

  create table if not exists target_activation_reservations (
    id text primary key,
    target_activation_id text not null references target_activations(id) on delete cascade,
    reservation_id text not null references reservations(id) on delete cascade,
    started_at timestamptz not null,
    ended_at timestamptz,
    estimated_cost_usd numeric not null default 0,
    unique(target_activation_id, reservation_id)
  );
  create index if not exists idx_target_activation_reservations_reservation on target_activation_reservations(reservation_id);
  create index if not exists idx_target_activation_reservations_activation on target_activation_reservations(target_activation_id);

  create table if not exists neuron_data_migrations (
    id text primary key,
    source_fingerprint text not null,
    counts jsonb not null,
    fingerprints jsonb not null,
    completed_at timestamptz not null
  );
`;

const schemaVersionTwoSql = `
  alter table reservations add column if not exists target_selections jsonb;
`;

const schemaVersionThreeSql = `
  create table if not exists model_capability_metadata (
    model_id text primary key,
    metadata_json jsonb not null,
    updated_at timestamptz not null
  );
  create table if not exists model_deployment_metadata (
    target_id text not null,
    model_id text not null,
    metadata_json jsonb not null,
    updated_at timestamptz not null,
    primary key(target_id, model_id)
  );
  create table if not exists model_favorites (
    username text not null,
    target_id text not null,
    model_id text not null,
    created_at timestamptz not null,
    primary key(username, target_id, model_id)
  );
  create index if not exists idx_model_favorites_username on model_favorites(username, created_at);
`;

const schemaVersionFourSql = `
  create table if not exists assistant_config (
    id text primary key check (id = 'default'),
    target_id text not null,
    model_id text not null,
    reservation_minutes integer not null check (reservation_minutes between 1 and 720),
    keepalive_minutes integer not null check (keepalive_minutes between 1 and 60),
    request_timeout_seconds integer not null check (request_timeout_seconds between 1 and 600),
    updated_at timestamptz not null
  );

  do $$
  declare
    legacy_count integer;
    legacy_target_id text;
    legacy_model_id text;
    legacy_reservation_minutes integer;
    legacy_request_timeout_seconds integer;
  begin
    select count(*)::integer into legacy_count
    from capacity_targets
    where target_json ? 'profileAdvisor';
    if legacy_count > 1 then
      raise exception 'More than one legacy target contains assistant configuration';
    end if;
    if legacy_count = 1 then
      select
        id,
        target_json #>> '{profileAdvisor,modelId}',
        coalesce((target_json #>> '{profileAdvisor,reservationMinutes}')::integer, 15),
        coalesce((target_json #>> '{profileAdvisor,requestTimeoutSeconds}')::integer, 120)
      into legacy_target_id, legacy_model_id, legacy_reservation_minutes, legacy_request_timeout_seconds
      from capacity_targets
      where target_json ? 'profileAdvisor';
      if legacy_model_id is null or btrim(legacy_model_id) = '' then
        raise exception 'Legacy assistant configuration has no model';
      end if;
      if exists (select 1 from assistant_config where id = 'default') then
        if not exists (
          select 1 from assistant_config
          where id = 'default' and target_id = legacy_target_id and model_id = legacy_model_id
        ) then
          raise exception 'Stored and legacy assistant configuration disagree';
        end if;
      else
        insert into assistant_config (
          id, target_id, model_id, reservation_minutes, keepalive_minutes,
          request_timeout_seconds, updated_at
        ) values (
          'default', legacy_target_id, legacy_model_id, legacy_reservation_minutes,
          least(60, legacy_reservation_minutes), legacy_request_timeout_seconds, now()
        );
      end if;
    end if;
  end $$;

  update capacity_targets
  set target_json = target_json - 'profileAdvisor'
  where target_json ? 'profileAdvisor';
`;

const schemaVersionFiveSql = `
  alter table assistant_config add column if not exists additional_instructions text;
`;

const schemaVersionSixSql = `
  create table users (
    id text primary key,
    username text not null,
    normalized_username text not null unique,
    display_name text,
    status text not null check (status in ('active', 'disabled')),
    session_version integer not null default 1,
    merged_into_user_id text references users(id),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    last_login_at timestamptz
  );

  with legacy_owners as (
    select username, created_at from reservations where not synthetic and username not in ('traffic', 'profile-advisor')
    union all select username, created_at from reservation_profiles
    union all select username, created_at from api_keys
    union all select username, created_at from model_favorites
  ), normalized as (
    select lower(btrim(username)) as username_key, min(username) as username, min(created_at) as created_at
    from legacy_owners where btrim(username) <> '' group by lower(btrim(username))
  )
  insert into users (id, username, normalized_username, status, created_at, updated_at)
  select 'usr_' || md5(username_key), username, username_key, 'active', created_at, now() from normalized;

  create table user_identities (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    provider_type text not null check (provider_type in ('local', 'github', 'oidc')),
    provider_id text not null,
    subject text not null,
    username text,
    email text,
    created_at timestamptz not null,
    last_seen_at timestamptz not null,
    unique(provider_type, provider_id, subject)
  );
  create index idx_user_identities_user on user_identities(user_id);

  create table local_credentials (
    user_id text primary key references users(id) on delete cascade,
    password_hash text not null,
    updated_at timestamptz not null
  );

  create table roles (
    id text primary key,
    name text not null unique,
    description text,
    scope text not null check (scope in ('global', 'team')),
    permissions jsonb not null,
    system_key text unique,
    created_at timestamptz not null,
    updated_at timestamptz not null
  );
  insert into roles (id, name, description, scope, permissions, system_key, created_at, updated_at) values
    ('role_owner', 'Owner', 'Protected installation owner and recovery administrator.', 'global', '["*"]', 'owner', now(), now()),
    ('role_admin', 'Administrator', 'Manages users, integrations, infrastructure, and reporting.', 'global', '["users.manage","users.merge","roles.manage","teams.manage","targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all","assistant.configure","auth.manage","system.manage"]', 'administrator', now(), now()),
    ('role_operator', 'Operator', 'Operates targets, reservations, discovery, and reports.', 'global', '["targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all"]', 'operator', now(), now()),
    ('role_member', 'Member', 'Uses visible targets and manages personal resources.', 'global', '["targets.read","targets.use","reservations.create","reservations.manage_own","profiles.manage_own","api_keys.manage_own","favorites.manage_own","reports.read_own"]', 'member', now(), now()),
    ('role_viewer', 'Viewer', 'Reads visible targets and personal reports.', 'global', '["targets.read","reports.read_own"]', 'viewer', now(), now()),
    ('role_team_owner', 'Team Owner', 'Manages a team and its shared resources.', 'team', '["team.manage","team.members.manage","team.profiles.manage","team.reports.read"]', 'team-owner', now(), now()),
    ('role_team_manager', 'Team Manager', 'Manages team members and shared profiles.', 'team', '["team.members.manage","team.profiles.manage","team.reports.read"]', 'team-manager', now(), now()),
    ('role_team_member', 'Team Member', 'Uses team targets and profiles.', 'team', '["team.profiles.use","team.reports.read"]', 'team-member', now(), now()),
    ('role_team_viewer', 'Team Viewer', 'Reads team resources and reports.', 'team', '["team.reports.read"]', 'team-viewer', now(), now());

  create table user_role_assignments (
    user_id text not null references users(id) on delete cascade,
    role_id text not null references roles(id) on delete restrict,
    created_at timestamptz not null,
    primary key(user_id, role_id)
  );
  insert into user_role_assignments (user_id, role_id, created_at)
  select id, 'role_member', now() from users;

  create table teams (
    id text primary key,
    name text not null unique,
    description text,
    parent_team_id text references teams(id) on delete restrict,
    created_at timestamptz not null,
    updated_at timestamptz not null
  );
  create table team_hierarchy (
    ancestor_team_id text not null references teams(id) on delete cascade,
    descendant_team_id text not null references teams(id) on delete cascade,
    depth integer not null check (depth >= 0),
    primary key(ancestor_team_id, descendant_team_id)
  );
  create index idx_team_hierarchy_descendant on team_hierarchy(descendant_team_id, ancestor_team_id);
  create table team_memberships (
    team_id text not null references teams(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    role_id text not null references roles(id) on delete restrict,
    source text not null check (source in ('manual', 'oidc')),
    source_reference text not null default '',
    created_at timestamptz not null,
    primary key(team_id, user_id, source, source_reference)
  );
  create index idx_team_memberships_user on team_memberships(user_id, team_id);

  create table registration_invitations (
    id text primary key,
    token_hash text not null unique,
    user_id text references users(id) on delete cascade,
    intended_username text,
    initial_role_id text references roles(id) on delete restrict,
    created_by_user_id text references users(id) on delete set null,
    expires_at timestamptz not null,
    max_uses integer not null check (max_uses > 0),
    use_count integer not null default 0 check (use_count >= 0),
    revoked_at timestamptz,
    created_at timestamptz not null
  );

  create table external_user_links (
    integration text not null,
    external_subject text not null,
    user_id text not null references users(id) on delete cascade,
    source text not null check (source in ('metadata', 'rule', 'admin')),
    created_at timestamptz not null,
    last_seen_at timestamptz not null,
    primary key(integration, external_subject)
  );

  create table identity_audit_events (
    id text primary key,
    actor_user_id text references users(id) on delete set null,
    action text not null,
    subject_type text not null,
    subject_id text not null,
    details jsonb not null default '{}',
    created_at timestamptz not null
  );
  create index idx_identity_audit_events_created on identity_audit_events(created_at, id);

  alter table reservations add column user_id text;
  alter table reservation_profiles add column user_id text;
  alter table api_keys add column user_id text;
  alter table model_favorites add column user_id text;

  update reservations r set user_id = u.id from users u
  where not r.synthetic and lower(btrim(r.username)) = u.normalized_username;
  update reservation_profiles p set user_id = u.id from users u where lower(btrim(p.username)) = u.normalized_username;
  update api_keys k set user_id = u.id from users u where lower(btrim(k.username)) = u.normalized_username;
  update model_favorites f set user_id = u.id from users u where lower(btrim(f.username)) = u.normalized_username;
  delete from model_favorites duplicate using model_favorites retained
  where duplicate.ctid > retained.ctid
    and duplicate.user_id = retained.user_id
    and duplicate.target_id = retained.target_id
    and duplicate.model_id = retained.model_id;

  alter table reservation_profiles alter column user_id set not null;
  alter table api_keys alter column user_id set not null;
  alter table model_favorites alter column user_id set not null;
  alter table reservations add constraint reservations_user_fk foreign key (user_id) references users(id) on delete restrict;
  alter table reservation_profiles add constraint reservation_profiles_user_fk foreign key (user_id) references users(id) on delete restrict;
  alter table api_keys add constraint api_keys_user_fk foreign key (user_id) references users(id) on delete cascade;
  alter table model_favorites add constraint model_favorites_user_fk foreign key (user_id) references users(id) on delete cascade;
  alter table reservations add constraint reservations_real_owner check (synthetic or user_id is not null);
  create index idx_reservations_user on reservations(user_id, created_at);
  create index idx_reservation_profiles_user on reservation_profiles(user_id, name);
  create index idx_api_keys_user on api_keys(user_id, created_at);
  create unique index idx_model_favorites_user_deployment on model_favorites(user_id, target_id, model_id);
`;

const migrations = [
  { version: 1, name: "initial-centralized-schema", sql: schemaVersionOneSql },
  { version: 2, name: "reservation-target-selections", sql: schemaVersionTwoSql },
  { version: 3, name: "model-selection-metadata-and-favorites", sql: schemaVersionThreeSql },
  { version: 4, name: "independent-assistant-configuration", sql: schemaVersionFourSql },
  { version: 5, name: "assistant-operator-instructions", sql: schemaVersionFiveSql },
  { version: 6, name: "durable-users-roles-and-teams", sql: schemaVersionSixSql }
] as const;

const expectedColumns: Record<string, Record<string, { type: string; nullable: boolean }>> = {
  reservations: {
    id: required("text"), user_id: optional("text"), username: required("text"), api_key_name: optional("text"), profile_id: optional("text"), profile_name: optional("text"),
    model_ids: required("jsonb"), target_ids: required("jsonb"), target_selections: optional("jsonb"), created_at: required("timestamptz"), expires_at: required("timestamptz"),
    keepalive_minutes: optional("int4"), ended_at: optional("timestamptz"), status: required("text"), failure_message: optional("text"), synthetic: required("bool")
  },
  reservation_profiles: {
    id: required("text"), user_id: required("text"), username: required("text"), name: required("text"), description: optional("text"), selections: required("jsonb"),
    default_duration_minutes: optional("int4"), default_keepalive_minutes: optional("int4"), created_at: required("timestamptz"), updated_at: required("timestamptz")
  },
  api_keys: {
    id: required("text"), user_id: required("text"), username: required("text"), name: required("text"), prefix: required("text"), key_hash: required("text"),
    created_at: required("timestamptz"), last_used_at: optional("timestamptz")
  },
  auth_methods: {
    id: required("text"), display_name: required("text"), type: required("text"), enabled: required("bool"), config_json: required("jsonb")
  },
  capacity_providers: {
    id: required("text"), display_name: required("text"), type: required("text"), provisioning_enabled: required("bool"), config: optional("jsonb"), credential_id: optional("text")
  },
  capacity_targets: { id: required("text"), target_json: required("jsonb") },
  target_creation_jobs: { id: required("text"), target_id: required("text"), job_json: required("jsonb") },
  target_model_discoveries: { target_id: required("text"), discovery_json: required("jsonb"), discovered_at: required("timestamptz") },
  target_activations: {
    id: required("text"), target_id: required("text"), started_at: required("timestamptz"), ended_at: optional("timestamptz"), status: required("text"),
    estimated_hourly_cost_usd: optional("numeric"), estimated_cost_usd: required("numeric"), last_costed_at: required("timestamptz")
  },
  target_activation_reservations: {
    id: required("text"), target_activation_id: required("text"), reservation_id: required("text"), started_at: required("timestamptz"),
    ended_at: optional("timestamptz"), estimated_cost_usd: required("numeric")
  },
  model_capability_metadata: { model_id: required("text"), metadata_json: required("jsonb"), updated_at: required("timestamptz") },
  model_deployment_metadata: { target_id: required("text"), model_id: required("text"), metadata_json: required("jsonb"), updated_at: required("timestamptz") },
  model_favorites: { user_id: required("text"), username: required("text"), target_id: required("text"), model_id: required("text"), created_at: required("timestamptz") },
  assistant_config: {
    id: required("text"), target_id: required("text"), model_id: required("text"), reservation_minutes: required("int4"),
    keepalive_minutes: required("int4"), request_timeout_seconds: required("int4"), additional_instructions: optional("text"), updated_at: required("timestamptz")
  },
  users: {
    id: required("text"), username: required("text"), normalized_username: required("text"), display_name: optional("text"), status: required("text"),
    session_version: required("int4"), merged_into_user_id: optional("text"), created_at: required("timestamptz"), updated_at: required("timestamptz"), last_login_at: optional("timestamptz")
  },
  user_identities: {
    id: required("text"), user_id: required("text"), provider_type: required("text"), provider_id: required("text"), subject: required("text"),
    username: optional("text"), email: optional("text"), created_at: required("timestamptz"), last_seen_at: required("timestamptz")
  },
  local_credentials: { user_id: required("text"), password_hash: required("text"), updated_at: required("timestamptz") },
  roles: {
    id: required("text"), name: required("text"), description: optional("text"), scope: required("text"), permissions: required("jsonb"),
    system_key: optional("text"), created_at: required("timestamptz"), updated_at: required("timestamptz")
  },
  user_role_assignments: { user_id: required("text"), role_id: required("text"), created_at: required("timestamptz") },
  teams: {
    id: required("text"), name: required("text"), description: optional("text"), parent_team_id: optional("text"), created_at: required("timestamptz"), updated_at: required("timestamptz")
  },
  team_hierarchy: { ancestor_team_id: required("text"), descendant_team_id: required("text"), depth: required("int4") },
  team_memberships: {
    team_id: required("text"), user_id: required("text"), role_id: required("text"), source: required("text"), source_reference: required("text"), created_at: required("timestamptz")
  },
  registration_invitations: {
    id: required("text"), token_hash: required("text"), user_id: optional("text"), intended_username: optional("text"), initial_role_id: optional("text"),
    created_by_user_id: optional("text"), expires_at: required("timestamptz"), max_uses: required("int4"), use_count: required("int4"), revoked_at: optional("timestamptz"), created_at: required("timestamptz")
  },
  external_user_links: {
    integration: required("text"), external_subject: required("text"), user_id: required("text"), source: required("text"), created_at: required("timestamptz"), last_seen_at: required("timestamptz")
  },
  identity_audit_events: {
    id: required("text"), actor_user_id: optional("text"), action: required("text"), subject_type: required("text"), subject_id: required("text"), details: required("jsonb"), created_at: required("timestamptz")
  },
  neuron_schema_migrations: {
    version: required("int4"), name: required("text"), checksum: required("text"), applied_at: required("timestamptz")
  },
  neuron_data_migrations: {
    id: required("text"), source_fingerprint: required("text"), counts: required("jsonb"), fingerprints: required("jsonb"), completed_at: required("timestamptz")
  }
};

export interface PostgresSchemaState {
  currentVersion: number;
  appliedVersions: number[];
}

export async function migratePostgresSchema(pool: pg.Pool): Promise<PostgresSchemaState> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [1_314_987_201]);
    await client.query(`
      create table if not exists neuron_schema_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    await validateExistingPostgresTablesForMigration(client);

    const applied = await client.query<{ version: number; name: string; checksum: string }>(
      "select version, name, checksum from neuron_schema_migrations order by version asc"
    );
    validateAppliedMigrations(applied.rows);

    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query(
        "insert into neuron_schema_migrations (version, name, checksum) values ($1, $2, $3)",
        [migration.version, migration.name, checksum(migration.sql)]
      );
      appliedVersions.add(migration.version);
    }

    await validatePostgresSchema(client);
    await client.query("commit");
    return { currentVersion: Math.max(0, ...appliedVersions), appliedVersions: Array.from(appliedVersions).sort((a, b) => a - b) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readPostgresSchemaState(queryable: pg.Pool | pg.PoolClient): Promise<PostgresSchemaState> {
  const exists = await queryable.query<{ exists: boolean }>("select to_regclass('neuron_schema_migrations') is not null as exists");
  if (!exists.rows[0]?.exists) return { currentVersion: 0, appliedVersions: [] };
  const result = await queryable.query<{ version: number }>("select version from neuron_schema_migrations order by version asc");
  const appliedVersions = result.rows.map((row) => row.version);
  return { currentVersion: Math.max(0, ...appliedVersions), appliedVersions };
}

export async function validatePostgresSchema(queryable: pg.Pool | pg.PoolClient): Promise<void> {
  const result = await queryable.query<{ table_name: string; column_name: string; udt_name: string; is_nullable: "YES" | "NO" }>(`
    select table_name, column_name, udt_name, is_nullable
    from information_schema.columns
    where table_schema = current_schema()
  `);
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(expectedColumns)) {
    for (const [column, expected] of Object.entries(columns)) {
      const row = actual.get(`${table}.${column}`);
      if (!row) {
        problems.push(`missing ${table}.${column}`);
        continue;
      }
      if (row.udt_name !== expected.type) problems.push(`${table}.${column} has type ${row.udt_name}, expected ${expected.type}`);
      if ((row.is_nullable === "YES") !== expected.nullable) problems.push(`${table}.${column} nullability is incompatible`);
    }
  }

  const constraints = await queryable.query<{ table_name: string; definition: string }>(`
    select t.relname as table_name,pg_get_constraintdef(c.oid) as definition
    from pg_constraint c join pg_class t on t.oid=c.conrelid
    where t.relnamespace=(select oid from pg_namespace where nspname=current_schema()) and t.relname=any($1::text[])
  `, [["target_activation_reservations","users","user_identities","user_role_assignments","team_hierarchy","team_memberships","reservations","reservation_profiles","api_keys","model_favorites"]]).catch(() => ({ rows: [] as Array<{ table_name: string; definition: string }> }));
  const definitionsFor = (table: string) => constraints.rows.filter((row) => row.table_name === table && row.definition).map((row) => row.definition.toLowerCase());
  const definitions = definitionsFor("target_activation_reservations");
  if (!definitions.some((definition) => definition.includes("foreign key (target_activation_id)") && definition.includes("target_activations") && definition.includes("on delete cascade"))) {
    problems.push("target_activation_reservations target activation foreign key is missing or incompatible");
  }
  if (!definitions.some((definition) => definition.includes("foreign key (reservation_id)") && definition.includes("reservations") && definition.includes("on delete cascade"))) {
    problems.push("target_activation_reservations reservation foreign key is missing or incompatible");
  }
  if (!definitions.some((definition) => definition.includes("unique (target_activation_id, reservation_id)"))) {
    problems.push("target_activation_reservations uniqueness constraint is missing");
  }
  const requireConstraint = (table: string, description: string, matches: (definition: string) => boolean) => {
    if (!definitionsFor(table).some(matches)) problems.push(`${table} ${description} is missing or incompatible`);
  };
  requireConstraint("users", "normalized username uniqueness", (value) => value.includes("unique (normalized_username)"));
  requireConstraint("user_identities", "provider identity uniqueness", (value) => value.includes("unique (provider_type, provider_id, subject)"));
  requireConstraint("user_role_assignments", "assignment primary key", (value) => value.includes("primary key (user_id, role_id)"));
  requireConstraint("team_hierarchy", "closure primary key", (value) => value.includes("primary key (ancestor_team_id, descendant_team_id)"));
  requireConstraint("team_memberships", "membership primary key", (value) => value.includes("primary key (team_id, user_id, source, source_reference)"));
  requireConstraint("reservations", "owner foreign key", (value) => value.includes("foreign key (user_id)") && value.includes("users") && value.includes("on delete restrict"));
  requireConstraint("reservations", "real reservation owner check", (value) => value.includes("check") && value.includes("synthetic") && value.includes("user_id"));
  requireConstraint("reservation_profiles", "owner foreign key", (value) => value.includes("foreign key (user_id)") && value.includes("users") && value.includes("on delete restrict"));
  requireConstraint("api_keys", "owner foreign key", (value) => value.includes("foreign key (user_id)") && value.includes("users") && value.includes("on delete cascade"));
  requireConstraint("model_favorites", "owner foreign key", (value) => value.includes("foreign key (user_id)") && value.includes("users") && value.includes("on delete cascade"));

  if (problems.length > 0) throw new Error(`PostgreSQL schema is incompatible: ${problems.join("; ")}`);
}

async function validateExistingPostgresTablesForMigration(queryable: pg.PoolClient): Promise<void> {
  const result = await queryable.query<{ table_name: string; column_name: string; udt_name: string; is_nullable: "YES" | "NO" }>(`
    select table_name, column_name, udt_name, is_nullable
    from information_schema.columns
    where table_schema = current_schema()
  `);
  const existingTables = new Set(result.rows.map((row) => row.table_name));
  const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  const knownLegacyAdditions = new Set([
    "reservations.api_key_name",
    "reservations.profile_id",
    "reservations.profile_name",
    "reservations.target_selections",
    "capacity_providers.provisioning_enabled",
    "assistant_config.additional_instructions",
    "reservations.user_id",
    "reservation_profiles.user_id",
    "api_keys.user_id",
    "model_favorites.user_id"
  ]);
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(expectedColumns)) {
    if (!existingTables.has(table)) continue;
    for (const [column, expected] of Object.entries(columns)) {
      const key = `${table}.${column}`;
      const row = actual.get(key);
      if (!row) {
        if (!knownLegacyAdditions.has(key)) problems.push(`existing table is missing ${key}`);
        continue;
      }
      if (row.udt_name !== expected.type) problems.push(`${key} has type ${row.udt_name}, expected ${expected.type}`);
      if ((row.is_nullable === "YES") !== expected.nullable) problems.push(`${key} nullability is incompatible`);
    }
  }
  if (problems.length > 0) throw new Error(`PostgreSQL schema is incompatible before migration: ${problems.join("; ")}`);
}

function validateAppliedMigrations(rows: Array<{ version: number; name: string; checksum: string }>): void {
  for (const row of rows) {
    const migration = migrations.find((candidate) => candidate.version === row.version);
    if (!migration) throw new Error(`PostgreSQL schema version ${row.version} is newer than this NeurOn build`);
    if (row.name !== migration.name || row.checksum !== checksum(migration.sql)) {
      throw new Error(`PostgreSQL schema migration ${row.version} does not match this NeurOn build`);
    }
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(type: string) {
  return { type, nullable: false };
}

function optional(type: string) {
  return { type, nullable: true };
}
