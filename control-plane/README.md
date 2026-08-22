# NeurOn

NeurOn is a lightweight control plane for shared self-hosted LLM capacity. It
is the light switch: developers reserve the models they expect to use, NeurOn
keeps the matching runtime on while reservations or recent traffic need it,
and it scales the runtime back down when demand is gone.

It is intentionally small:

- Fastify + TypeScript
- server-rendered HTML, not a SPA
- OpenAPI-compatible REST endpoints, Swagger UI, and MCP
- durable reservation and API-key storage with memory, SQLite, or Postgres
  options
- provider adapters for Docker containers, Docker Compose, AWS EC2, and AWS ECS/ASG
- LiteLLM request-log polling for traffic-based keepalive

## Local Run

For pure app development without touching real capacity:

```bash
cd control-plane
npm install
npm run build
STORAGE_DRIVER=sqlite SQLITE_PATH=./data/neuron-dev.db npm run users -- create-owner-link --username admin --base-url http://localhost:8090 --confirm-application-stopped
STORAGE_DRIVER=sqlite SQLITE_PATH=./data/neuron-dev.db USE_FAKE_PROVIDER=true CAPACITY_TARGETS_FILE=examples/capacity-targets.local-fake.json npm run dev
```

Open the one-time URL printed by the Owner-link command, choose the first local
password, and sign in. Each account has its own password. Users can create API
keys from `/api-keys` for Bearer-auth plugin and MCP integrations.

From the repository root, Docker Compose runs NeurOn without starter providers
or targets. Local Compose stores reservations in `./data/neuron.db` so
restarting NeurOn does not forget active demand, configured providers/targets,
or API keys:

```bash
docker compose up --build neuron
```

For app-only development, set `USE_FAKE_PROVIDER=true` and optionally
`CAPACITY_TARGETS_FILE=examples/capacity-targets.local-fake.json`.

Without target configuration, NeurOn starts with no providers or targets. Add
them from Admin or supply declarative config.

The normal Compose file also has an opt-in HassleOff profile. Configure the
shared token, internal `http://hassleoff:8091` URL, and registration file first,
then start the services in this order:

```bash
docker compose --profile hassleoff up -d hassleoff
docker compose up -d neuron
```

The default NeurOn command does not start HassleOff. The status and synthetic
test are at **Admin > HassleOff**. See [docs/hassleoff.md](docs/hassleoff.md)
for the exact safe enablement order.

For an isolated fake-only dead-man safety stack:

```bash
docker compose --env-file control-plane/examples/compose-hassleoff.properties -f docker-compose.hassleoff.yml up --build
```

This explicit properties file prevents Compose from loading a default `.env`.
NeurOn is at `http://localhost:18090`, HassleOff is at
`http://localhost:18091`, and both registered provider actions are fake. See
[docs/hassleoff.md](docs/hassleoff.md).

## Runtime Targets

NeurOn does not include an inference container. Configure the targets it should
control with one of:

1. `CAPACITY_TARGETS_JSON`
2. `CAPACITY_TARGET_KEYS` and scoped environment variables
3. `CAPACITY_TARGETS_FILE`

The examples directory includes:

- `capacity-targets.local-fake.json` for local UI/API development
- `capacity-targets.prefer-docker.json` as a local PreFer container example
- `capacity-targets.prefer-smol.json` as a quick PreFer/latest `smol.ini`
  preset example
- `capacity-targets.local-docker.json` as a bring-your-own Docker Compose
  runtime example
- `capacity-targets.runpod.example.json` as a RunPod Pod example
- `capacity-targets.example.json` as an AWS ECS/ASG example

For Docker targets, NeurOn starts and stops the configured container. If an
image is configured and the container is missing, an admin can explicitly
provision it by pulling the image and creating the named container when the
provider allows resource creation. The default PreFer profile mounts
the `prefer-model-cache` volume at `/models` for local model files.
Use the admin Discover action to temporarily start the runtime, read
`/v1/models`, add those runtime models as selectable choices, and stop the
target again.

For Docker Compose targets, NeurOn starts capacity with:

```bash
docker compose -p <project-name> -f <compose-file> up -d --no-build <service>
```

And stops it with:

```bash
docker compose -p <project-name> -f <compose-file> stop <service>
```

The target compose project, service, health URL, and models are all supplied by
configuration.
If the target service is gated by a Compose profile, set
`dockerCompose.profiles` or `CAPACITY_TARGET_<KEY>_DOCKER_PROFILES`.

## Configuration

Environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `PORT` | `8090` | HTTP port inside the container |
| `COOKIE_SECRET` | unset | Enables login cookie auth |
| `ADMIN_USERS` | unset | Optional comma-separated Owner bootstrap/recovery usernames; empty grants nobody Owner |
| `PUBLIC_BASE_URL` | forwarded request origin | External origin used for OAuth/OIDC callback URLs |
| `AUTH_METHOD_KEYS` | unset | Comma-separated scoped GitHub/OIDC method keys; local auth is durable and managed in Admin |
| `NEURON_UPDATE_CHECK_ENABLED` | enabled for published images | Check the latest successful main image build |
| `NEURON_UPDATE_REPOSITORY` | `cvalusek/NeurOn` | GitHub repository used for update checks |
| `NEURON_UPDATE_CHECK_SECONDS` | `900` | Minimum interval between GitHub update checks |
| `STORAGE_DRIVER` | `memory` | `memory`, `sqlite`, or `postgres` reservation and API-key storage |
| `SQLITE_PATH` | `data/neuron.db` | SQLite database path when `STORAGE_DRIVER=sqlite` |
| `DATABASE_URL` | unset | Postgres connection string when `STORAGE_DRIVER=postgres` |
| `POSTGRES_POOL_MAX` | `10` | Maximum connections in the shared Postgres application pool |
| `CONTROL_PLANE_MAINTENANCE_MODE` | `false` | Disable mutations and lifecycle/provider background work for storage maintenance |
| `STORAGE_OPERATION_LOCK_PATH` | `data/neuron-storage.lock` | Exclusive application/migration storage lock |
| `CAPACITY_TARGETS_JSON` | unset | JSON array of targets |
| `CAPACITY_TARGET_KEYS` | unset | Comma-separated target keys for env-expanded config |
| `CAPACITY_TARGETS_FILE` | unset | Local target config file |
| `RECONCILER_INTERVAL_SECONDS` | `10` | Background scheduling and target reconcile loop |
| `RESERVATION_STATUS_POLL_SECONDS` | `5` | Reservation detail polling |
| `ADMIN_STATUS_POLL_SECONDS` | `5` | Main/admin status polling |
| `HEALTH_CHECK_TIMEOUT_SECONDS` | `5` | Per-target health check timeout |
| `HEALTH_CHECK_INTERVAL_SECONDS` | `15` | Reserved for health tuning |
| `AWS_REGION` | `us-east-1` | AWS region for EC2 and ECS/ASG providers |
| `LITELLM_API_BASE_URL` | unset | LiteLLM admin API base URL |
| `LITELLM_API_KEY` | unset | LiteLLM admin API key |
| `LITELLM_TRAFFIC_POLL_SECONDS` | `60` | Poll `/spend/logs/v2`; set `0` to disable |
| `LITELLM_TRAFFIC_LOOKBACK_SECONDS` | `300` | Recent traffic window |
| `USE_FAKE_PROVIDER` | `false` | Local fake provider for app development |
| `HASSLEOFF_URL` | unset | HassleOff base URL for protected targets |
| `HASSLEOFF_CONTROLLER_TOKEN` | unset | Authenticates controller lease calls |
| `HASSLEOFF_CONTROLLER_ID` | `neuron` | Stable deployment identity in leases |
| `HASSLEOFF_REQUEST_TIMEOUT_SECONDS` | `5` | Timeout for server-side HassleOff calls |
| `HASSLEOFF_FAILSAFE_TEST_TARGET_ID` | `hassleoff-failsafe-test` | Exact synthetic `testOnly` fake registration exposed in the admin safety UI |

Model choices are configuration-first. Put the user-facing choices in each
target's `models` array with display names, aliases, backend model IDs, context,
and optional technical-capability flags. Admins add durable intelligence,
scored-strength, quantization, and exact target-model performance facts at
**Admin > Model data**. The profile builder searches and sorts the catalog and
filters by context, cost, required technical capabilities, and dedicated versus
multi-model hosting. Users can optionally open the Good/Fast/Cheap triangle
wizard to rank eligible choices by Intelligence, Speed, and Cost. Scored
strengths refine Intelligence; quality-retention estimates remain display-only.
Hosting mode is explicit: unclassified targets remain visible and are not
guessed from their model count. The collapsible Assistant keeps bounded
conversation history across pages, sends screen-state deltas behind a stable
cache-friendly operating prompt, and exposes privacy-safe diagnostics to admins.
No PreFer manifest is required.
See [Guided Model Selection](docs/model-selection.md).

When a target becomes healthy, NeurOn polls the target's OpenAI-compatible
`/v1/models` endpoint and records matching runtime model IDs from
`backendModelIds`/`aliases`. That enriches status and traffic mapping without
creating surprise UI options or changing capacity decisions.
If a target has no configured models, NeurOn bootstraps runtime discovery when
no persisted discovery result exists. A required bootstrap may briefly hold the
exact target on, read `/v1/models`, and then stop discovery-started capacity
only when no reservation or traffic demand needs it. On later NeurOn restarts,
the persisted result is hydrated and startup skips provider and model contact.
Set `modelDiscovery.bootstrapOnStartup=false` to disable automatic bootstrap,
or `true` to request an initial bootstrap for a target with configured models.
Use authenticated **Admin > Targets > Discover models now** to force a refresh
and speed measurement, or **Rediscover all** to process targets sequentially.
Cache reuse across process restarts requires SQLite or Postgres storage; the
memory driver intentionally has no state to hydrate after a restart.
If discovery has not populated models yet, users can still reserve the target
itself; NeurOn treats that as keeping the full runtime available.

Full configuration details live in [docs/configuration.md](docs/configuration.md).

## API Examples

```bash
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/models
```

```bash
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/status
curl -H "Authorization: Bearer sk-neuron-..." -X POST http://localhost:8090/api/reservations/<id>/done
```

OpenAPI UI is available at `/docs`, and the OpenAPI 3.0 document is available
at `/openapi.json`.

MCP is available at `/mcp` for authenticated JSON-RPC clients. It exposes tools
for listing models/targets/status and creating or ending the key user's own
reservations. See [docs/integrations.md](docs/integrations.md).

## LiteLLM Model Synchronization

When `LITELLM_API_BASE_URL` and `LITELLM_API_KEY` are set, runtime discovery
publishes one canonical deployment per target/runtime model to LiteLLM. Scoped
`<target-id>/<alias>` and global friendly names use LiteLLM's formal
`model_group_alias` router setting instead of duplicate deployments. Global
alias collisions choose the target with the lowest numeric `aliasPriority`, and
later targets become formal LiteLLM `fallbacks`. Each target gets one reusable
`neuron/<target-id>` credential containing its current runtime API base.
Set the target's `litellm.apiKeyEnv` to the name of an injected runtime secret
when the runtime requires authentication; otherwise NeurOn supplies the
non-empty placeholder `noapikey` required by the OpenAI-compatible LiteLLM
client. See
[docs/configuration.md](docs/configuration.md#litellm-discovered-model-sync).

NeurOn never changes LiteLLM deployment block state when capacity stops. Current
routes remain available so LiteLLM can queue requests while NeurOn starts the
target. Aliases removed by a later discovery are retired under a non-callable
NeurOn name instead of deleting LiteLLM history.

## Traffic Keepalive

NeurOn can keep healthy capacity warm from LiteLLM request logs. Enable:

```env
LITELLM_API_BASE_URL=http://litellm.internal:4000
LITELLM_API_KEY=sk-...
LITELLM_TRAFFIC_POLL_SECONDS=60
LITELLM_TRAFFIC_LOOKBACK_SECONDS=300
```

When `LITELLM_API_BASE_URL` and `LITELLM_API_KEY` are set, the poller reads
LiteLLM spend logs, maps recent `model_group`/`model` values to NeurOn model IDs
or target traffic prefixes, and refreshes a synthetic `traffic` reservation. It
uses the active reservation's keepalive window and will not resurrect a failed
target by itself.

## Deployment Notes

Run NeurOn separately from the LLM host, for example as its own ECS/Fargate
service. It scales the configured LLM ECS service and Auto Scaling Group; it
should not run on the same capacity that it turns off.

The app is intended for internal/Tailscale access. Interactive sign-in supports
individual local passwords plus configured GitHub and OIDC methods. Browser
sessions are signed, HTTP-only, and bounded; users can generate hashed
`sk-neuron-...` API keys for Bearer-auth integrations. See
[Identity and Access](docs/identity-access.md) before disabling local auth or
rolling an existing deployment forward.

## IAM

For AWS EC2 targets that use pre-created instances, the task role needs:

- `ec2:StartInstances`
- `ec2:StopInstances`
- `ec2:DescribeInstances`
- `pricing:GetProducts` for automatic on-demand price estimates
- `ec2:DescribeSpotPriceHistory` for automatic Spot price estimates

Scope start/stop to the specific instance ARNs NeurOn may control. EC2 targets
use `aws.instanceId` and do not use an Auto Scaling Group. Instance discovery
does not add another permission beyond `ec2:DescribeInstances`. The pricing
permissions are optional when targets use manual hourly-cost overrides.

For AWS ECS/ASG targets, the task role needs:

- `autoscaling:SetDesiredCapacity`
- `autoscaling:DescribeAutoScalingGroups`
- `ecs:UpdateService`
- `ecs:DescribeServices`

If LiteLLM or target runtime credentials are stored in AWS Secrets Manager or
SSM Parameter Store, grant the ECS task execution role read access and inject
`LITELLM_API_KEY` plus each target-specific environment variable referenced by
`litellm.apiKeyEnv` at runtime. NeurOn stores only the environment-variable name
in target configuration.

## Development

```bash
npm run typecheck
npm test
npm run lint
docker build -t neuron-control-plane .
```

Reservation and API-key storage defaults to memory for direct local runs. Set
`STORAGE_DRIVER=sqlite` for a single-file durable database or
`STORAGE_DRIVER=postgres` with `DATABASE_URL` for Postgres. The local Compose
file defaults to SQLite at `/app/data/neuron.db` and mounts the repository
`./data` directory there. Runtime discovery records use the selected durable
driver. Target status and startup estimates remain in memory and are rebuilt
observationally by reconciliation. PostgreSQL uses one bounded shared pool and
a transactional versioned schema ledger.

For local private PostgreSQL Compose, safe SQLite transfer, dry-run proof,
cutover, backup, and rollback, follow
[docs/postgres-migration.md](docs/postgres-migration.md). The PostgreSQL service
publishes no host database port. Never operate SQLite and PostgreSQL as
simultaneous production writers; HassleOff's separate SQLite store is not part
of this migration.
