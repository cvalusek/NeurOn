---
type: Reference
title: Configuration
description: JSON, file, and environment-variable configuration patterns for NeurOn.
tags: [configuration, environment, deployment]
timestamp: 2026-06-25T00:00:00Z
---

# Configuration

NeurOn can run without a mounted config file. Configuration precedence is:

1. `CAPACITY_TARGETS_JSON`
2. `CAPACITY_TARGET_KEYS` and scoped environment variables
3. `CAPACITY_TARGETS_FILE`

If none of those target sources is supplied, NeurOn starts with no capacity
targets. Providers are also empty unless supplied with config or created in the
admin UI.

Use JSON when that is convenient, but prefer env-expanded config for container
deployments where mounting a file is awkward.

Reusable provider definitions can be supplied with `CAPACITY_PROVIDERS_JSON`.
Existing target config does not require this; a target can still specify a
provider type such as `aws-ecs`, `docker`, or `runpod` directly. The provider
management screen only shows explicitly configured or persisted providers.
Providers can also use env-expanded config:

```env
CAPACITY_PROVIDER_KEYS=RUNPOD_MAIN
CAPACITY_PROVIDER_RUNPOD_MAIN_ID=runpod-main
CAPACITY_PROVIDER_RUNPOD_MAIN_DISPLAY_NAME=RunPod Main
CAPACITY_PROVIDER_RUNPOD_MAIN_TYPE=runpod
# Default is false. Enable only when NeurOn should create provider resources.
CAPACITY_PROVIDER_RUNPOD_MAIN_PROVISIONING_ENABLED=false
```

Provider-specific env-expanded fields include:

- RunPod: `CAPACITY_PROVIDER_<KEY>_RUNPOD_API_KEY_ENV`,
  `CAPACITY_PROVIDER_<KEY>_RUNPOD_API_BASE_URL`
- NeurOn: `CAPACITY_PROVIDER_<KEY>_NEURON_API_BASE_URL`,
  `CAPACITY_PROVIDER_<KEY>_NEURON_API_KEY_ENV`,
  `CAPACITY_PROVIDER_<KEY>_NEURON_RESERVATION_MINUTES`,
  `CAPACITY_PROVIDER_<KEY>_NEURON_SYNC_TARGETS`,
  `CAPACITY_PROVIDER_<KEY>_NEURON_TARGET_ID_PREFIX`

Admins can also add persisted providers from `/admin/providers`. Providers from
configuration are shown there as read-only; providers created in the UI are
stored with the configured storage driver.
Admins can add persisted targets from `/admin/targets`. Targets from
configuration are shown there as read-only; targets created in the UI are stored
with the configured storage driver and become available to reservations and the
reconciler immediately.
Both screens show copyable declarative JSON and environment-variable forms for
each provider or target. Config-backed rows also include a `Copy to DB` action
for migrating declarative setups into the configured storage driver.

## Runtime Profiles

Runtime profiles describe provisionable runtime defaults in provider-neutral
terms. The built-in profile is:

```json
{
  "id": "prefer",
  "name": "PreFer",
  "type": "docker",
  "image": "ghcr.io/cvalusek/prefer:latest",
  "volumes": {
    "/models": "prefer-model-cache"
  }
}
```

For Docker-style runtimes, `port` defaults to `8080`, `health` defaults to
`/health`, `api` defaults to `/v1`, and `discovery` defaults to `true`.
Providers translate those generic profile fields into their own provisioning
requests. For example, RunPod derives its Pod image from the profile `image`
rather than requiring RunPod-specific profile config.
The PreFer profile also declares that `/models` is backed by the
`prefer-model-cache` volume. Docker provisioning currently creates containers
with all GPUs available by default.

Runtime profiles can declare variants. A variant is a named flavor of the base
profile that layers a small set of overrides onto it. Variants use the same
portable fields as profiles: `image`, `port`, `health`, `api`, `volumes`,
`env`, and `discovery`.

The built-in PreFer profile includes these variants:

- `standard`: does not set a preset; PreFer auto-selects from runtime signals.
- `deepseek-v4-flash`: sets `LLAMA_ARG_MODELS_PRESET` to
  `/presets/deepseek-v4-flash.ini`.
- `glm-5.2`: sets `LLAMA_ARG_MODELS_PRESET` to `/presets/glm-5.2.ini`.
- `glm-5.2-reap`: sets `LLAMA_ARG_MODELS_PRESET` to
  `/presets/glm-5.2-reap.ini`.
- `smol`: sets `LLAMA_ARG_MODELS_PRESET` to `/presets/smol.ini` for automated
  UI tests and local smoke checks.

A variant with a preset looks like:

```json
{
  "env": {
    "LLAMA_ARG_MODELS_PRESET": "/presets/smol.ini"
  }
}
```

Additional profiles can be supplied with `RUNTIME_PROFILES_JSON`:

```env
RUNTIME_PROFILES_JSON=[{"id":"prefer-nightly","name":"PreFer Nightly","type":"docker","image":"ghcr.io/cvalusek/prefer:nightly","port":8080}]
```

## Core Environment

- `PORT`
- `SHARED_PASSWORD`
- `COOKIE_SECRET`
- `ADMIN_USERS`
- `GITHUB_AUTH_ENABLED`
- `GITHUB_AUTH_CLIENT_ID`
- `GITHUB_AUTH_CLIENT_SECRET`
- `GITHUB_AUTH_ALLOWED_USERS`
- `GITHUB_AUTH_ALLOWED_ORGS`
- `STORAGE_DRIVER`
- `SQLITE_PATH`
- `DATABASE_URL`
- `AWS_REGION`
- `LITELLM_API_BASE_URL`
- `LITELLM_API_KEY`
- `CAPACITY_PROVIDERS_JSON`
- `RECONCILER_INTERVAL_SECONDS`
- `RESERVATION_STATUS_POLL_SECONDS`
- `ADMIN_STATUS_POLL_SECONDS`
- `HEALTH_CHECK_TIMEOUT_SECONDS`
- `LITELLM_TRAFFIC_POLL_SECONDS`
- `LITELLM_TRAFFIC_LOOKBACK_SECONDS`
- `HASSLEOFF_URL`
- `HASSLEOFF_CONTROLLER_TOKEN`
- `HASSLEOFF_CONTROLLER_ID`
- `HASSLEOFF_REQUEST_TIMEOUT_SECONDS`

Production-friendly defaults are intentionally calmer than local development:

- Reconciler: 60 seconds
- Reservation page polling: 10 seconds
- Main/admin status polling: 30 seconds
- LiteLLM traffic polling: 60 seconds when LiteLLM API config is present

Local compose overrides the important polling settings for faster iteration.

## Storage

Reservation and API-key storage use the same configured driver. Storage
defaults to memory for direct local runs:

```env
STORAGE_DRIVER=memory
```

Use SQLite for single-node durable storage:

```env
STORAGE_DRIVER=sqlite
SQLITE_PATH=./data/neuron.db
```

Use Postgres when the control plane should use external database storage:

```env
STORAGE_DRIVER=postgres
DATABASE_URL=postgres://neuron:secret@postgres:5432/neuron
```

Local Compose defaults to SQLite at `/app/data/neuron.db` and mounts the
repository `./data` directory into `/app/data`. SQLite and Postgres persist
active reservations, reservation profiles, `sk-neuron-...` API keys, configured providers, persisted
targets, target provisioning jobs, target model discovery results, target
activations, and reservation cost allocation records across NeurOn restarts. Target status and
startup estimates remain in memory because they are observational and rebuilt by
reconciliation.

## Auth And API Keys

Interactive users sign in with a username plus the shared password. API clients
can use Basic Auth with the same shared password:

```bash
curl -u clint:dev-password http://localhost:8090/api/models
```

Users can create personal API keys from `/api-keys`. The generated key is shown
once, starts with `sk-neuron-...`, and is stored as a hash. API keys authenticate
REST and MCP calls with:

```http
Authorization: Bearer sk-neuron-...
```

`ADMIN_USERS` controls admin status for Basic, cookie, and API-key auth. When
`ADMIN_USERS` is empty, any authenticated user is treated as an admin, matching
the existing local-development behavior.

GitHub sign-in can be configured from environment or from Admin > Auth. Create a
GitHub OAuth app with this callback URL:

```text
https://<neuron-host>/auth/github/callback
```

For local development, use:

```text
http://localhost:8090/auth/github/callback
```

Environment-backed GitHub auth is read-only in the UI:

```env
GITHUB_AUTH_ENABLED=true
GITHUB_AUTH_CLIENT_ID=...
GITHUB_AUTH_CLIENT_SECRET=...
GITHUB_AUTH_ALLOWED_USERS=alice,bob
GITHUB_AUTH_ALLOWED_ORGS=my-org
```

If both allow lists are empty, any GitHub user who completes OAuth can sign in.
If `GITHUB_AUTH_ALLOWED_USERS` is set, the GitHub login must be listed. If
`GITHUB_AUTH_ALLOWED_ORGS` is set, the user must belong to at least one listed
organization. GitHub-authenticated users use their GitHub login as the NeurOn
username, so `ADMIN_USERS` should list GitHub logins for admin access.

Admins can add, edit, disable, or delete persisted GitHub methods from
`/admin/auth`. Persisted methods are stored by the configured storage driver.

## Env-Expanded Target Config

Declare target keys:

```env
CAPACITY_TARGET_KEYS=MULTIPLE_MOE_96GB
```

Then define scoped variables:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_ID=gpu-pool-96gb
CAPACITY_TARGET_MULTIPLE_MOE_96GB_DISPLAY_NAME=GPU Pool 96GB
CAPACITY_TARGET_MULTIPLE_MOE_96GB_PROVIDER=aws-ecs
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HEALTH_URL=http://llm-96gb.internal:8080/health
CAPACITY_TARGET_MULTIPLE_MOE_96GB_ESTIMATED_HOURLY_COST_USD=4.25
```

Opt a rented target into the HassleOff start/provision interlock:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HASSLEOFF_PROTECTED=true
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HASSLEOFF_LEASE_DURATION_SECONDS=120
```

Existing targets remain unprotected unless this flag is explicitly true. A
protected start fails explicitly when the configured HassleOff instance cannot
accept the exact target lease. Optional stale-test shutdown routing is also
off by default:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HASSLEOFF_SHUTDOWN_ON_STALE_TRIP_TEST=true
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HASSLEOFF_TRIP_TEST_MAX_AGE_SECONDS=86400
```

Replacement provisioning after a typed recoverable availability failure is a
separate opt-in and still requires provider provisioning permission plus a
durable target record:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_REPROVISION_ON_RECOVERABLE_UNAVAILABLE=true
```

See [HassleOff](hassleoff.md) and [Provisioning](provisioning.md) for failure
and recovery semantics.

Use `PROVIDER_ID` when the target should reference a reusable provider
definition:

```env
CAPACITY_TARGET_RUNPOD_QWEN_PROVIDER_ID=runpod-main
```

When a target uses JSON config, `providerId` works the same way. If `provider`
is omitted and `providerId` references a declared provider, NeurOn derives the
target provider type from that provider definition. Set `PROVIDER` explicitly
when no reusable provider definition exists.

`ESTIMATED_HOURLY_COST_USD` is optional. When set, NeurOn records target
activations and allocates elapsed estimated target cost across the active
reservations for that activation. JSON config uses the equivalent shape:

```json
{
  "costEstimate": {
    "hourlyUsd": 4.25
  }
}
```

For RunPod targets, `ESTIMATED_HOURLY_COST_USD` is usually not required.
When a target has a RunPod Pod ID and API key, NeurOn asks RunPod for the
Pod's hourly cost when an activation opens. A configured
`ESTIMATED_HOURLY_COST_USD` still wins when you need a manual override.

Model keys are nested under a target:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_KEYS=QWEN_36,GEMMA_4
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_ID=qwen-3.6-35b-a3b
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_DISPLAY_NAME=Qwen3.6 35B A3B
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_FAMILY=Qwen 3.6
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_ALIASES=qwen-3.6
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_BACKEND_MODEL_IDS=qwen-3.6,qwen-3.6-35b-a3b
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_QWEN_36_CONTEXT_LABEL=256k
```

## AWS Env Fields

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_CLUSTER=llm-cluster
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_SERVICE=llama-cpp-gpu-pool-96gb
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_ASG_NAME=llm-gpu-pool-96gb-asg
```

`AWS_CLUSTER` and `AWS_SERVICE` may be names or ARNs. The Auto Scaling Group
must be supplied by name because Auto Scaling APIs use `AutoScalingGroupName`.

Older JSON fields `clusterName` and `serviceName` are still supported, but new
configs should use `cluster` and `service`.

## RunPod Env Fields

Use `runpod` provider targets when NeurOn should start and stop an existing
RunPod Pod:

```env
CAPACITY_TARGET_RUNPOD_PROVIDER=runpod
CAPACITY_TARGET_RUNPOD_RUNPOD_POD_ID=your-runpod-pod-id
CAPACITY_TARGET_RUNPOD_RUNPOD_API_KEY_ENV=RUNPOD_API_KEY
CAPACITY_TARGET_RUNPOD_RUNPOD_RUNTIME_PORT=8080
CAPACITY_TARGET_RUNPOD_TRAFFIC_MODEL_PREFIXES=prefer/
```

For multiple RunPod targets that share one account/API key, put shared API
settings in `CAPACITY_PROVIDERS_JSON` and reference the provider from each
target:

```env
CAPACITY_PROVIDERS_JSON=[{"id":"runpod-main","displayName":"RunPod Main","type":"runpod","provisioning":{"enabled":false},"config":{"runpod":{"apiKeyEnv":"RUNPOD_API_KEY"}}}]
CAPACITY_TARGET_RUNPOD_QWEN_PROVIDER_ID=runpod-main
CAPACITY_TARGET_RUNPOD_QWEN_RUNPOD_POD_ID=pod-qwen
```

Target-level RunPod fields override provider-level RunPod fields. This lets
one provider define shared access while each target keeps its Pod ID and
runtime port.

Cost estimation for RunPod targets uses the same RunPod API key. Put
`RUNPOD_API_KEY` in the environment, set target-level `RUNPOD_API_KEY_ENV`, or
define shared `RUNPOD_API_KEY_ENV` on the reusable provider record.

`HEALTH_URL` is optional for RunPod targets. Without it, NeurOn trusts
RunPod Pod status for capacity readiness. For model discovery, NeurOn infers
RunPod's proxy URL as `https://<pod-id>-<port>.proxy.runpod.net/v1` from
`RUNPOD_POD_ID` and `RUNPOD_RUNTIME_PORT`. Set `API_URL` only when
that inferred URL is not right for your runtime.

For explicitly provisioned RunPod targets, a create Pod request body can be
supplied as JSON:

```env
CAPACITY_TARGET_RUNPOD_RUNPOD_CREATE_JSON={"name":"prefer","imageName":"ghcr.io/cvalusek/prefer:latest"}
```

Targets created through the provider UI use runtime profiles instead. The
provisioning job is persisted so creation can be resumed or inspected after
restart. Providers do not create resources during ordinary target start unless
that behavior is added later as an explicit policy.

`LITELLM_BACKEND_NAME` and target-level `LITELLM_API_BASE_URL` are optional.
They are only for syncing a LiteLLM backend entry when a target becomes healthy;
they are not required for RunPod start/stop or model discovery.

Set `TRAFFIC_MODEL_PREFIXES` when LiteLLM logs model groups with a route prefix,
for example `prefer/gemma-4b-e2b`. The prefix is target configuration; NeurOn
does not require `prefer/` specifically.

Set `LITELLM_DISPLAY_PREFIX` when client-facing LiteLLM model names differ from
traffic log prefixes. By default, plugin clients can use the first
`TRAFFIC_MODEL_PREFIXES` value as the display prefix. Set
`CAPACITY_TARGET_<KEY>_LITELLM_DISPLAY_PREFIX=__empty__` to publish an empty
prefix from environment config when LiteLLM aliases the prefix away. JSON config
can use `"litellmDisplayPrefix": ""` directly.

## NeurOn Provider Env Fields

Use a `neuron` provider when another NeurOn instance owns the real runtime
targets and this NeurOn instance should reserve capacity through it:

```env
CAPACITY_PROVIDER_KEYS=UPSTREAM
CAPACITY_PROVIDER_UPSTREAM_ID=upstream
CAPACITY_PROVIDER_UPSTREAM_DISPLAY_NAME=Upstream NeurOn
CAPACITY_PROVIDER_UPSTREAM_TYPE=neuron
CAPACITY_PROVIDER_UPSTREAM_NEURON_API_BASE_URL=https://neuron-upstream.example.com
CAPACITY_PROVIDER_UPSTREAM_NEURON_API_KEY_ENV=UPSTREAM_NEURON_API_KEY
CAPACITY_PROVIDER_UPSTREAM_NEURON_SYNC_TARGETS=true
CAPACITY_PROVIDER_UPSTREAM_NEURON_RESERVATION_MINUTES=5
```

When `NEURON_SYNC_TARGETS=true`, startup imports upstream targets from
`/api/status` and upstream model metadata from `/api/models`. Local target IDs
default to `<provider-id>-<upstream-target-id>`. Set
`NEURON_TARGET_ID_PREFIX` to override that prefix.

Manually configured NeurOn targets are also supported:

```env
CAPACITY_TARGET_REMOTE_QWEN_PROVIDER_ID=upstream
CAPACITY_TARGET_REMOTE_QWEN_DISPLAY_NAME=Remote Qwen
CAPACITY_TARGET_REMOTE_QWEN_NEURON_TARGET_ID=qwen
```

The local reconciler creates or extends one upstream reservation per local
NeurOn target while local demand exists, then ends that upstream reservation
when demand disappears.

## Docker Env Fields

Use `docker` provider targets when NeurOn should control a named container.
Model lists may be omitted when you want runtime discovery to populate choices
from `/v1/models`:

```env
CAPACITY_TARGET_LOCAL_PROVIDER=docker
CAPACITY_TARGET_LOCAL_DOCKER_CONTAINER_NAME=prefer
CAPACITY_TARGET_LOCAL_TRAFFIC_MODEL_PREFIXES=prefer/
```

Set `DOCKER_IMAGE` and optional Docker provisioning fields only when NeurOn should
provision a missing container through an explicit admin action. If the
container already exists, NeurOn can start, stop, inspect, and discover models
from it with just the container name and a runtime URL such as
`HEALTH_URL`.
When creating a PreFer Docker target through the admin UI, enter only the model
volume name, for example `prefer-model-cache`; the runtime profile supplies the
container path. The lower-level `DOCKER_VOLUMES` setting is still available for
raw Docker overrides.

Set `TRAFFIC_MODEL_PREFIXES` when LiteLLM logs model names with a route prefix,
for example `prefer/gemma-4b-e2b`. Traffic whose model starts with one of those
prefixes keeps the matching target warm even if runtime model discovery has not
seen that exact LiteLLM-facing name. The prefix can be any target-specific
route prefix, not only `prefer/`.

Set `LITELLM_DISPLAY_PREFIX` separately when tools show a different
LiteLLM-facing model name than the traffic log prefix. Use `__empty__` in
environment config to publish an intentionally empty display prefix.

LiteLLM traffic polling reads `model_group` and `model` from spend logs. NeurOn
tries `/spend/logs/v2` first, then falls back to the legacy `/spend/logs`
response shape when v2 is empty.

Use `docker-compose` provider targets when the runtime is still owned by a
Compose project:

```env
CAPACITY_TARGET_LOCAL_PROVIDER=docker-compose
CAPACITY_TARGET_LOCAL_DOCKER_PROJECT_DIRECTORY=/workspace
CAPACITY_TARGET_LOCAL_DOCKER_PROJECT_NAME=local-llm
CAPACITY_TARGET_LOCAL_DOCKER_COMPOSE_FILE=docker-compose.yml
CAPACITY_TARGET_LOCAL_DOCKER_PROFILES=PreFer
CAPACITY_TARGET_LOCAL_DOCKER_SERVICE_NAME=llm-runtime
```

Use `DOCKER_COMPOSE_FILES` as a comma-separated list when an overlay is needed.
Use `DOCKER_PROFILES` as a comma-separated list when the target service lives
behind one or more Compose profiles.

## Runtime Model Discovery

Explicit model config is the normal source of truth. Runtime discovery enriches
models with IDs reported by the backend. It should not be treated as a solver.
When a target has no configured or cached models, NeurOn bootstraps discovery
on startup by starting the target, waiting for health, reading `/v1/models`,
persisting the discovered models with a discovery timestamp, and stopping the
target again. Set `bootstrapOnStartup=false` to opt out.

Optional bootstrap:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_ON_STARTUP=true
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_TIMEOUT_SECONDS=600
```

When enabled, NeurOn starts the target once before accepting requests, waits for
health, reads `/v1/models`, records runtime IDs, persists the discovery result,
and stops the target again.

## Model Warmup

When an active reservation names specific models and a target reports healthy,
NeurOn sends a one-token OpenAI-compatible `/chat/completions` request for each
requested model before marking the target healthy. This keeps plugin clients
waiting until the runtime has loaded the model, not merely until the process is
up.

Warmup uses `MODEL_WARMUP_API_BASE_URL` when configured. Otherwise it falls back
to `API_URL`, target-level LiteLLM `apiBaseUrl`, an inferred RunPod
proxy URL, or the `/v1` origin derived from `HEALTH_URL`.

Env-expanded target settings:

```env
CAPACITY_TARGET_LOCAL_MODEL_WARMUP_ENABLED=true
CAPACITY_TARGET_LOCAL_MODEL_WARMUP_API_BASE_URL=http://runtime.internal:8080/v1
CAPACITY_TARGET_LOCAL_MODEL_WARMUP_API_KEY_ENV=RUNTIME_API_KEY
CAPACITY_TARGET_LOCAL_MODEL_WARMUP_TIMEOUT_SECONDS=60
```

Set `MODEL_WARMUP_ENABLED=false` on a target to skip warmup.
