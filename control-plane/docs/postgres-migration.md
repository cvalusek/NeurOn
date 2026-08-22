---
title: SQLite to PostgreSQL Migration
description: Fail-closed backup, dry-run, cutover, verification, and rollback procedure.
tags: [operations, storage, sqlite, postgres, migration]
---

# SQLite to PostgreSQL Migration

NeurOn supports one control-plane database owner at a time. Never run SQLite
and PostgreSQL application writers concurrently. HassleOff owns a separate
SQLite database; this procedure does not read, stop, migrate, or restart it.

PostgreSQL schema version 7 is managed by the transactional
`neuron_schema_migrations` ledger. The application uses one bounded shared pool
for all repositories. The explicit transfer command records a completed source
identity in `neuron_data_migrations`; an exact rerun verifies and exits as a
no-op, while a changed source or unexplained nonempty destination fails closed.
Version 2 adds the target-specific model-selection snapshot used by multi-target
reservations. Version 3 adds durable model capabilities, exact target-model
deployment measurements, and user model favorites. Version 4 adds the
independent singleton assistant configuration and transactionally moves any
legacy `profileAdvisor` value out of target JSON. Startup upgrades an
already-current version 1 through 5 database in order and in a transaction
before repositories begin serving requests. Version 5 adds optional trusted
operator guidance to the independent Assistant record. Version 6 adds durable
users, external identities, per-user local credentials, roles, nested teams,
membership automation, invitations, LiteLLM subject links, audit events, stable
ownership foreign keys, and target audiences. Legacy usernames are backfilled
without changing owned record IDs; every backfilled user receives Member and
is never implicitly promoted to Owner. Version 7 adds an optional team foreign
key to reservation profiles; all existing profiles remain personal.

The explicit SQLite transfer contract is source schema version 4. It includes
all identity entities and ownership links when present, accepts legacy
pre-identity databases for safe backfill, validates target-selection JSON, and
includes every transferred value in privacy-safe semantic fingerprints. The
startup validator permits only columns owned by known migrations, so an older
supported PostgreSQL deployment upgrades through version 7 automatically
without operator SQL.

## Durable scope

The command transfers:

1. reservations and reservation profiles, including stable owner IDs, optional
   team sharing, and target-specific selection snapshots;
2. hashed API keys and all local/GitHub/OIDC authentication methods;
3. provider definitions, target definitions and audiences, provisioning jobs,
   and target model-discovery records;
4. model capability records, exact target-model deployment records, and user
   model favorites;
5. singleton assistant configuration;
6. target activations and their reservation cost-allocation links; and
7. users, external identities, local credential hashes, global/team roles and
   assignments, teams and hierarchy closure, memberships, invitations,
   external LiteLLM links, and identity audit events.

Older local databases may also contain the predecessor tables `target_runs`
and `target_run_reservation_links`. When both tables have the exact recognized
schema, their rows are merged into the activation/cost family. Conflicting IDs,
orphaned links, duplicate links, partial legacy schema, or any other unexpected
table/column fails closed instead of discarding history.

Target status and startup estimates are observational in-memory state and are
not migration data. Provider, target, and auth JSON is treated as opaque and is
never printed. The command emits only schema versions, migration identity,
counts, safety blockers, backup path, and verification results.

## Prepare private PostgreSQL

From the repository root, create the ignored local credential file. The command
refuses to replace an existing file and never reads `.env`:

```powershell
node control-plane/scripts/create-postgres-local-config.js
```

Start PostgreSQL alone and wait for its health check:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.postgres.yml ps postgres
```

The database has a named persistent volume, is reachable only on the internal
Compose network, and publishes no host port. The committed example contains no
real credential; `.env.postgres.local` is ignored.

The real-PostgreSQL repository and migration suites use their own tmpfs server:

```powershell
docker compose --env-file .env.postgres.local -p neuron-postgres-test -f docker-compose.postgres-test.yml run --rm neuron-postgres-test
docker compose --env-file .env.postgres.local -p neuron-postgres-test -f docker-compose.postgres-test.yml down
```

Neither the test nor dry-run project shares the production PostgreSQL process,
network, or persistent volume.

## Safety gate and quiescence

Before stopping NeurOn, verify through its authenticated UI or read-only API
that there are no active reservations, in-flight provisioning jobs, discovery
operations, target lifecycle transitions, or protected/armed HassleOff leases
that make an outage unsafe. Stop and resolve ambiguity rather than forcing the
cutover. Do not use provider, inference, LiteLLM, PreFer, or model endpoints as
a database test.

Build the new image. Before the first normal version-6 start, stop only NeurOn
and create or verify an Owner recovery path as described in
[Identity and Access](identity-access.md). Do not stop HassleOff:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml build neuron neuron-migrate
docker compose stop neuron
docker compose ps
```

The application and migration command share `/app/data/neuron-storage.lock`.
The CLI also requires `--confirm-application-stopped`. If a process was killed
instead of shutting down cleanly, a stale lock may remain. Remove it only after
independently confirming that no NeurOn or migration process is running.

## Inspect and dry-run

Inspection validates SQLite `integrity_check`, foreign keys, required source
tables/columns, privacy-safe counts, semantic parsing, and lifecycle blockers:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm neuron-migrate inspect --sqlite /app/data/neuron.db --confirm-application-stopped
```

Run the first migration against a disposable PostgreSQL container backed only
by tmpfs. It has its own Compose project and internal network. The command makes
a WAL-aware SQLite backup first and imports that consistent copy:

```powershell
docker compose --env-file .env.postgres.local -p neuron-postgres-dry-run -f docker-compose.postgres-dry-run.yml run --rm neuron-migrate migrate --sqlite /app/data/neuron.db --backup-dir /app/data/backups --database-url-env POSTGRES_DRY_RUN_DATABASE_URL --confirm-application-stopped
docker compose --env-file .env.postgres.local -p neuron-postgres-dry-run -f docker-compose.postgres-dry-run.yml down
```

Require `semanticVerification: passed`, the expected per-entity counts, and no
safety blocker before continuing. `down` discards the tmpfs database. For a new
dry-run after the source changes, start this disposable project again; never
reset the production database or its volume.

## Production import and safe start

Import to the empty production database. This creates another timestamped
rollback backup and commits all rows plus verification metadata atomically:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm neuron-migrate migrate --sqlite /app/data/neuron.db --backup-dir /app/data/backups --confirm-application-stopped
```

Start NeurOn with PostgreSQL in maintenance mode. Maintenance mode disables the
reconciler, traffic poller, startup discovery/provider synchronization,
HassleOff status calls, and capacity-affecting HTTP/MCP routes. Identity
administration remains available for validating and repairing account links:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.maintenance.yml up -d neuron
```

`GET /healthz` must report `ok: true`, `storageDriver: postgres`, and
`maintenanceMode: true`. Compare read-only record counts with the migration
output, restart NeurOn once with the same three files, and verify the same
records again. This proves PostgreSQL persistence without contacting capacity.

Remove the maintenance overlay only during an explicitly approved return to
normal provider reconciliation. The normal PostgreSQL command is:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d neuron
```

## Rollback

Do not destroy successful PostgreSQL state to test rollback. To reverse the
application owner, stop NeurOn, select a retained backup under `/app/data`, and
start SQLite in maintenance mode. In PowerShell:

```powershell
docker compose -f docker-compose.yml -f docker-compose.postgres.yml stop neuron
$env:SQLITE_ROLLBACK_PATH="/app/data/backups/neuron-sqlite-rollback-<timestamp>.db"
docker compose -f docker-compose.yml -f docker-compose.maintenance.yml -f docker-compose.sqlite-rollback.yml up -d neuron
```

Verify `/healthz` reports `storageDriver: sqlite` and compare read-only counts.
Leave PostgreSQL and its named volume intact. Resume normal reconciliation only
after the same operational safety review. Never start the PostgreSQL and SQLite
application services as simultaneous production writers.

## Backup policy

The original SQLite file is never deleted, moved, or overwritten. Keep at least
one timestamped `data/backups/neuron-sqlite-rollback-*.db` outside Git until the
PostgreSQL retention and restore policy has been proven. Back up PostgreSQL with
the platform's standard consistent database backup tooling; copying its live
volume files is not a database backup.
