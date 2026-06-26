# NeurOn

NeurOn is a lightweight control plane for shared self-hosted LLM capacity. It
is the light switch: developers reserve the models they expect to use, NeurOn
keeps the matching runtime on while reservations or recent traffic need it,
and it scales the runtime back down when demand is gone.

It is intentionally small:

- Fastify + TypeScript
- server-rendered HTML, not a SPA
- OpenAPI-compatible REST endpoints
- in-memory v1 state behind repository interfaces
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
use Basic Auth for API calls.

From the repository root, Docker Compose runs NeurOn with the Docker provider
and the default PreFer container target:

```bash
docker compose up --build control-plane
```

For app-only development, set `USE_FAKE_PROVIDER=true` and
`CAPACITY_TARGETS_FILE=examples/capacity-targets.local-fake.json`.

Without `CAPACITY_TARGETS_FILE`, local development defaults to the normal PreFer
Docker target in `examples/capacity-targets.prefer-docker.json`, which expects a
container named `prefer`.

## Runtime Targets

NeurOn does not include an inference container. Configure the targets it should
control with one of:

1. `CAPACITY_TARGETS_JSON`
2. `CAPACITY_TARGET_KEYS` and scoped environment variables
3. `CAPACITY_TARGETS_FILE`

The examples directory includes:

- `capacity-targets.local-fake.json` for local UI/API development
- `capacity-targets.prefer-docker.json` as the default local PreFer container
  example
- `capacity-targets.local-docker.json` as a bring-your-own Docker Compose
  runtime example
- `capacity-targets.runpod.example.json` as a RunPod Pod example
- `capacity-targets.example.json` as an AWS ECS/ASG example

For Docker targets, NeurOn starts and stops the configured container. If an
image is configured and the container is missing, NeurOn installs it by pulling
the image and creating the named container.
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
| `CAPACITY_TARGETS_JSON` | unset | JSON array of targets |
| `CAPACITY_TARGET_KEYS` | unset | Comma-separated target keys for env-expanded config |
| `CAPACITY_TARGETS_FILE` | `examples/capacity-targets.prefer-docker.json` | Local target config file |
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

```bash
curl -u clint:dev-password -H 'content-type: application/json' \
  -d '{"modelIds":["qwen"],"durationMinutes":15}' \
  http://localhost:8090/api/reservations
```

```bash
curl -u clint:dev-password http://localhost:8090/api/status
curl -u clint:dev-password -X POST http://localhost:8090/api/reservations/<id>/done
```

OpenAPI UI is available at `/docs`.

## Traffic Keepalive

NeurOn can keep healthy capacity warm from LiteLLM request logs. Enable:

```env
LITELLM_API_BASE_URL=http://litellm.internal:4000
LITELLM_API_KEY=sk-...
LITELLM_TRAFFIC_POLL_SECONDS=60
LITELLM_TRAFFIC_LOOKBACK_SECONDS=300
```

When `LITELLM_API_BASE_URL` and `LITELLM_API_KEY` are set, the poller reads
`GET /spend/logs/v2`, maps recent `model` values to NeurOn model IDs, and
refreshes a synthetic `traffic` reservation. It will not resurrect a failed
target by itself.

## Deployment Notes

Run NeurOn separately from the LLM host, for example as its own ECS/Fargate
service. It scales the configured LLM ECS service and Auto Scaling Group; it
should not run on the same capacity that it turns off.

The app is intended for internal/Tailscale access. v1 auth is shared-password
Basic Auth plus optional signed HTTP-only login cookie. `AuthProvider` is
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

State is in memory for v1. Restarting NeurOn loses reservations, but the
reconciler reads provider state and tolerates restart without request handlers
owning infrastructure lifecycle transitions.
