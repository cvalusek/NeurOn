---
type: Playbook
title: Operations
description: Deployment, runtime behavior, polling, failure handling, and local development notes.
tags: [operations, deployment, iam, polling]
timestamp: 2026-06-25T00:00:00Z
---

# Operations

## Deployment Shape

Run NeurOn separately from the LLM host capacity it controls. ECS/Fargate is a
good fit for the control plane itself. The app must not run on the EC2 capacity
that it scales down.

Run HassleOff as a separate service that also does not depend on the rented
inference host. Its SQLite file and narrowly scoped provider stop credential
must survive NeurOn restarts. See [HassleOff](hassleoff.md).

## Networking

NeurOn is designed for internal/Tailscale-style access. Interactive
authentication supports individual local passwords and configured GitHub or
OIDC providers, including Okta, using a signed HTTP-only NeurOn session cookie.
Sessions expire after twelve hours and re-resolve current account status,
roles, and team membership on every request. Local sign-in may be disabled only
after an external Owner path is verified; the offline one-time Owner-link
command is the recovery path.
The navigation's **Sign out** action posts to `/logout`, clears only the local
NeurOn session, and does not sign the user out of GitHub or the upstream OIDC
provider.
Users can also create personal `sk-neuron-...` API keys for Bearer-auth REST,
OpenAPI, and MCP integrations. API keys should be treated as secrets and
rotated by revoking old keys from `/api-keys`.

## Persistence

Control-plane storage is configurable:

- `STORAGE_DRIVER=memory` keeps all repository families in process memory
- `STORAGE_DRIVER=sqlite` stores them in `SQLITE_PATH`
- `STORAGE_DRIVER=postgres` stores them in `DATABASE_URL` through one bounded
  shared pool and the versioned schema ledger

SQLite is the local Compose default and uses `/app/data/neuron.db`, mounted from
the repository `./data` directory. Durable reservations allow NeurOn to restart
without forgetting active demand, so the reconciler continues to desire matching
targets on after the process comes back. Durable API keys allow plugin and MCP
clients to survive control-plane restarts. The selected driver also owns
reservation profiles, auth methods, provider and target definitions,
provisioning jobs, runtime model-discovery records, durable model capability and
deployment measurements, user model favorites, the singleton assistant
configuration, target activation/cost history, and the full identity graph:
users, credentials, external identities, roles, nested teams, memberships,
invitations, external traffic links, and audit events.

Schema version 6 introduces this durable identity graph and backfills stable
owners from legacy usernames without changing profile, reservation, API-key,
favorite, or activation IDs. It assigns Member—not Owner—to backfilled users.
Create or recover the first Owner while NeurOn is stopped, then confirm that
login before normal reconciliation. See [Identity and Access](identity-access.md).
Schema version 7 adds the optional profile team assignment. Schema version 8
adds an explicit `personal`, `everyone`, or `team` sharing scope and backfills
profiles with a team assignment to `team`; every other existing profile remains
personal. The upgrade does not change profile IDs, owners, selections, or
timing defaults.

Target startup estimates and target status remain in memory. They are
observational state and are rebuilt by reconciliation; they are not used for
scheduling decisions. HassleOff's SQLite database is independent and is never
part of a NeurOn control-plane database migration.

## Safe Update Restarts

Published NeurOn images expose their source revision, and the admin UI reports
when a newer successfully built `main` image is available. It compares Git
ancestry as well as hash equality: a running revision that is newer than the
latest successful build is reported as **CI catching up**, not as an update;
diverged revisions are called out for review. NeurOn does not
replace its own container. **Admin > Updates** safely exits the current process;
an external supervisor must then start a replacement task that pulls the newer
image.

When an update is available, NeurOn compares the running revision with that
successful build. **What changes in this update** prefers curated Markdown
fragments added under `control-plane/changes/`; if none exist in the comparison,
it falls back to commit titles and links the full GitHub comparison. Patch-note
fetch failures are shown separately and never affect reconciliation or restart
safety. Private repositories can supply the same read-only GitHub token used by
the update checker.

For ECS, run NeurOn as an ECS service with desired count at least one. A stopped
essential container causes the service scheduler to launch a replacement task.
When using the mutable `latest` tag on ECS EC2 capacity, set the ECS agent image
pull behavior to `always` if a cached image is unacceptable. Immutable
`sha-<commit>` task definitions remain the more deterministic deployment model,
but require an external task-definition update rather than self-restart alone.

**Restart when safe** enters drain mode before checking capacity:

1. New reservations and extensions are rejected.
2. LiteLLM keepalive polling and direct traffic keepalives stop.
3. New provisioning and model-discovery starts are rejected.
4. Existing reservations and already-running discovery operations may finish.
5. The reconciler continues issuing normal stop operations after demand ends.
6. NeurOn exits only after every configured target freshly reports
   `desired=off` and `observed=stopped`.

Admins may cancel a pending drain before shutdown begins.

**Force restart** requires typing `RESTART` and an explicit target choice:

- **Stop targets first** fails active reservations, stops every target that is
  not already known stopped, verifies every provider reports stopped, and only
  then exits. If any stop or status check fails, NeurOn remains running in a
  failed/draining state so the operator can retry or cancel.
- **Restart without stopping targets** exits immediately and requires a
  separate acknowledgement. If the replacement task fails and HassleOff is not
  armed for every affected target, running capacity may remain unmanaged and
  continue accruing cost.

The drain request is intentionally process-local. If NeurOn crashes before the
safe conditions are met, the replacement process resumes normal persisted
reservation reconciliation rather than inheriting an ambiguous shutdown order.

## Administrator maintenance transitions

**Admin > Updates** uses the same shutdown coordinator for application mode
changes:

- **Enter maintenance when safe** blocks new demand, waits for reservations and
  discovery work to finish, stops and verifies targets through the normal
  reconciler, persists maintenance mode, and then exits.
- **Resume normal operation** persists normal mode and immediately exits so the
  replacement process constructs provider, traffic, discovery, and reconciler
  services consistently from startup.

The local Compose service uses `restart: unless-stopped`, so these graceful
application exits restart the container. An explicit `docker compose stop`
still keeps it stopped. ECS and other deployments continue to rely on their own
service supervisor.

The administrator choice is stored in the ignored application data directory.
`CONTROL_PLANE_MAINTENANCE_MODE` supplies a default only when no choice exists.
For database migration, recovery, or another operation that must not be
dismissible from the application, use
`CONTROL_PLANE_FORCE_MAINTENANCE_MODE=true`; the Updates screen will explain
that the deployment setting must be removed before normal operation can resume.

Use the [SQLite to PostgreSQL migration](postgres-migration.md) procedure for a
backup, disposable dry-run, one-writer cutover, verification, and rollback. Do
not change `STORAGE_DRIVER` on a live application or run SQLite and PostgreSQL
application writers concurrently.

Forced maintenance is the safe cutover boundary:
capacity-affecting mutations, reconciliation, traffic polling, startup
discovery/provider sync, and HassleOff status calls are disabled while
read-only verification remains available. Identity administration and
reservation-profile editing remain available because neither invokes a
provider or creates demand. `/healthz` reports the active storage driver and
maintenance state. The repository's storage procedures use
`docker-compose.maintenance-forced.yml` so a prior administrator choice cannot
silently bypass that boundary.

## Polling Defaults

Production defaults are intentionally moderate:

- Reconciler: 10 seconds
- Reservation status page: 5 seconds
- Main/admin status: 5 seconds
- LiteLLM request logs: 60 seconds when LiteLLM API config is present

Set `LITELLM_TRAFFIC_POLL_SECONDS=0` to disable request-log polling.

Explicit admin discovery can run the versioned `neuron-speed-v2-50k` benchmark
after a target is activated. It discards one 50K-class warm-up, measures three
50K-class cache-disabled requests, verifies that the runtime reports processing
at least 40K prompt tokens, and stores median prefill/decode throughput with
provenance. **Rediscover all** processes targets sequentially. Startup cache
hydration does not benchmark or contact a model. Run explicit benchmarking only
during an approved capacity window.

Ordinary LiteLLM traffic is not a performance benchmark and contributes only
demand, attribution, popularity, and keepalive signals. Controlled deployment
benchmarks are authoritative for speed rankings; other observational speed
sources are considered only when no controlled measurement exists. The profile
assistant reuses the selected target's existing runtime credential reference;
there is no separate advisor secret. Its target/model and timing controls live
in the independent **Admin > Assistant** screen and `assistant_config` record.
Reservation duration bounds a cold-start wait; the separate response timeout
applies only after the target is healthy. Optional administrator guidance is
stored in that same independent record and cannot override authorization,
confirmation, or lifecycle safety. Browser requests use short asynchronous
polls so an ALB connection does not need to remain open for the whole cold
start.
Never commit runtime credentials or private/licensed model facts.

## Control-Plane Shutdown

On `SIGINT` or `SIGTERM`, NeurOn stops and unreferences the reconciler and
LiteLLM traffic-polling timers before closing Fastify, the shared repository
pool, and the storage lock. A shutdown that begins during startup discovery
also prevents the reconciler timer from being started afterward. This allows an
ECS replacement task to exit normally instead of waiting for the container
stop timeout. Load-balancer target deregistration remains an independent
deployment-level delay.

## Shutdown Guard

Before shutting down a target that was previously desired on, the reconciler
performs one immediate LiteLLM traffic poll. If that poll creates or refreshes a
synthetic traffic reservation, the target remains desired on.

## Startup Estimates

Startup estimates are based on recent observed transitions from starting to
healthy. They are shown for operator context only and are not used for capacity
decisions.

## Health Checks

Health checks are target-level. They should answer the user-facing question:
"can this runtime serve traffic yet?" They should not model every internal
startup phase.

## Failure Behavior

If a provider operation fails:

- target status becomes `failed`
- relevant active reservations become `failed`
- the app process keeps running

Traffic keepalive cannot resurrect a failed target by itself.

For an AWS EC2 target that is observed as `stopping` while demand is on, the
adapter waits rather than sending an invalid start request. The reconciler keeps
the reservation active, reports the target as starting, and retries after AWS
reports `stopped`. Terminal or missing instances still fail closed. This is
control of a pre-created instance only; see [Providers](providers.md#aws-ec2).

## Release notes

Every user- or operator-visible control-plane change should add one concise
Markdown file under `control-plane/changes/`. The first level-one heading is the
Updates-screen title and the remaining text describes impact and any required
operator action. Do not include credentials, private hostnames, migrated data,
or internal incident detail.

`npm run changes:check` validates fragment structure. CI also compares the
branch with its base revision and requires a fragment when control-plane source,
the application Dockerfile, control-plane-local Compose files, or dependencies
change.

## Integration Checks

After deployment, low-risk read-only checks are:

```bash
curl http://localhost:8090/healthz
curl http://localhost:8090/openapi.json
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/models
```

MCP clients can verify tool discovery with:

```bash
curl -H "Authorization: Bearer sk-neuron-..." \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://localhost:8090/mcp
```

When testing MCP mutations in a shared environment, create and end only the
reservation IDs returned by your own test call. Do not end another user's
reservation. NeurOn's MCP `end_reservation` tool enforces ownership, but
operators should still keep test intent narrow.

## Local Development

Local compose uses the Docker provider and mounts the host Docker socket so
NeurOn can provision, start, and stop the configured PreFer container when
resource creation is enabled. Treat that as trusted local-admin access to
Docker. Set `USE_FAKE_PROVIDER=true` for
app-only development or tests. The Docker Compose provider remains available
for bring-your-own local runtime projects. Netskope/corporate CA builds are
supported through the compose overlay and `.netskope` Dockerfile.

The normal root Compose file keeps HassleOff behind the optional `hassleoff`
profile. Follow the exact registration and protection sequence in
[hassleoff.md](hassleoff.md), then start HassleOff before NeurOn. Use
**Admin > HassleOff** to verify readiness and run the synthetic
fail-safe test.

For the isolated fake-only NeurOn plus HassleOff stack, use the explicit
properties file so Docker Compose does not load a default `.env` file:

```bash
docker compose --env-file control-plane/examples/compose-hassleoff.properties -f docker-compose.hassleoff.yml up --build
```
