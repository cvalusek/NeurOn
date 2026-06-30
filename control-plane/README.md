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
- provider adapters for Docker containers, Docker Compose, and AWS ECS/ASG
- LiteLLM request-log polling for traffic-based keepalive

## Local Run

For pure app development without touching real capacity:

```bash
cd control-plane
npm install
SHARED_PASSWORD=dev-password USE_FAKE_PROVIDER=true CAPACITY_TARGETS_FILE=examples/capacity-targets.local-fake.json npm run dev
```

Open `http://localhost:8090`, sign in with any username and `dev-password`, or
use Basic Auth for API calls. Users can create API keys from `/api-keys` for
Bearer-auth plugin and MCP integrations.

From the repository root, Docker Compose runs NeurOn without starter providers
or targets. Local Compose stores reservations in `./data/neuron.db` so
restarting NeurOn does not forget active demand, configured providers/targets,
or API keys:

```bash
docker compose up --build control-plane
```

For app-only development, set `USE_FAKE_PROVIDER=true` and optionally
`CAPACITY_TARGETS_FILE=examples/capacity-targets.local-fake.json`.

Without target configuration, NeurOn starts with no providers or targets. Add
them from Admin or supply declarative config.

## Runtime Targets

NeurOn does not include an inference container. Configure the targets it should
control with one of:

1. `CAPACITY_TARGETS_JSON`
2. `CAPACITY_TARGET_KEYS` and scoped environment variables
3. `CAPACITY_TARGETS_FILE`

The examples directory includes:

- `capacity-targets.local-fake.json` for local UI/API development
- `capacity-targets.prefer-docker.json` as a local PreFer container example
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
| `SHARED_PASSWORD` | required in production | Basic/cookie auth password |
| `COOKIE_SECRET` | unset | Enables login cookie auth |
| `ADMIN_USERS` | any authenticated user | Comma-separated admin usernames |
| `STORAGE_DRIVER` | `memory` | `memory`, `sqlite`, or `postgres` reservation and API-key storage |
| `SQLITE_PATH` | `data/neuron.db` | SQLite database path when `STORAGE_DRIVER=sqlite` |
| `DATABASE_URL` | unset | Postgres connection string when `STORAGE_DRIVER=postgres` |
| `CAPACITY_TARGETS_JSON` | unset | JSON array of targets |
| `CAPACITY_TARGET_KEYS` | unset | Comma-separated target keys for env-expanded config |
| `CAPACITY_TARGETS_FILE` | unset | Local target config file |
| `RECONCILER_INTERVAL_SECONDS` | `60` | Background reconcile loop |
| `RESERVATION_STATUS_POLL_SECONDS` | `10` | Reservation detail polling |
| `ADMIN_STATUS_POLL_SECONDS` | `30` | Main/admin status polling |
| `HEALTH_CHECK_TIMEOUT_SECONDS` | `5` | Per-target health check timeout |
| `HEALTH_CHECK_INTERVAL_SECONDS` | `15` | Reserved for health tuning |
| `AWS_REGION` | `us-east-1` | AWS region for ECS/ASG provider |
| `LITELLM_API_BASE_URL` | unset | LiteLLM admin API base URL |
| `LITELLM_API_KEY` | unset | LiteLLM admin API key |
| `LITELLM_TRAFFIC_POLL_SECONDS` | `60` | Poll `/spend/logs/v2`; set `0` to disable |
| `LITELLM_TRAFFIC_LOOKBACK_SECONDS` | `300` | Recent traffic window |
| `USE_FAKE_PROVIDER` | `false` | Local fake provider for app development |

Model choices are configuration-first. Put the user-facing choices in each
target's `models` array with display names, aliases, backend model IDs, and
context metadata. The start page asks users to choose a capacity target first,
then the models they expect to use on that target.

When a target becomes healthy, NeurOn polls the target's OpenAI-compatible
`/v1/models` endpoint and records matching runtime model IDs from
`backendModelIds`/`aliases`. That enriches status and traffic mapping without
creating surprise UI options or changing capacity decisions.
If a target has no configured models, NeurOn bootstraps runtime discovery on
startup by briefly starting the target, reading `/v1/models`, and stopping it
again. Set `modelDiscovery.bootstrapOnStartup=false` to disable that behavior,
or `true` to force it for a target with configured models.
If discovery has not populated models yet, users can still reserve the target
itself; NeurOn treats that as keeping the full runtime available.

Full configuration details live in [docs/configuration.md](docs/configuration.md).

## API Examples

```bash
curl -u clint:dev-password http://localhost:8090/api/models
```

Generate API keys from `/api-keys`, then call the API with Bearer auth:

```bash
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/models
```

```bash
curl -u clint:dev-password -H 'content-type: application/json' \
  -d '{"modelIds":["qwen"],"durationMinutes":15}' \
  http://localhost:8090/api/reservations
```

```bash
curl -u clint:dev-password http://localhost:8090/api/status
curl -u clint:dev-password -X POST http://localhost:8090/api/reservations/<id>/done
```

OpenAPI UI is available at `/docs`, and the OpenAPI 3.0 document is available
at `/openapi.json`.

MCP is available at `/mcp` for authenticated JSON-RPC clients. It exposes tools
for listing models/targets/status and creating or ending the key user's own
reservations. See [docs/integrations.md](docs/integrations.md).

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

The app is intended for internal/Tailscale access. v1 auth is shared-password
Basic Auth plus optional signed HTTP-only login cookie. Users can generate
hashed `sk-neuron-...` API keys for Bearer-auth integrations. `AuthProvider` is
isolated so GitHub/AuthentiK/Okta/Tailscale identity can replace it later.

## IAM

For AWS ECS/ASG targets, the task role needs:

- `autoscaling:SetDesiredCapacity`
- `autoscaling:DescribeAutoScalingGroups`
- `ecs:UpdateService`
- `ecs:DescribeServices`

If LiteLLM credentials are stored in AWS Secrets Manager or SSM Parameter
Store, grant read access and inject `LITELLM_API_KEY` at runtime.

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
`./data` directory there. Target status, runtime discovery cache, and startup
estimates remain in memory and are rebuilt observationally by reconciliation.
