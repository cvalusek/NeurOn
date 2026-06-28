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

Use JSON when that is convenient, but prefer env-expanded config for container
deployments where mounting a file is awkward.

## Core Environment

- `PORT`
- `SHARED_PASSWORD`
- `COOKIE_SECRET`
- `ADMIN_USERS`
- `STORAGE_DRIVER`
- `SQLITE_PATH`
- `DATABASE_URL`
- `AWS_REGION`
- `LITELLM_API_BASE_URL`
- `LITELLM_API_KEY`
- `RECONCILER_INTERVAL_SECONDS`
- `RESERVATION_STATUS_POLL_SECONDS`
- `ADMIN_STATUS_POLL_SECONDS`
- `HEALTH_CHECK_TIMEOUT_SECONDS`
- `LITELLM_TRAFFIC_POLL_SECONDS`
- `LITELLM_TRAFFIC_LOOKBACK_SECONDS`

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
active reservations and `sk-neuron-...` API keys across NeurOn restarts. Target
status, runtime discovery cache, and startup estimates remain in memory because
they are observational and rebuilt by reconciliation.

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
CAPACITY_TARGET_MULTIPLE_MOE_96GB_HEALTH_CHECK_URL=http://llm-96gb.internal:8080/health
```

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

`HEALTH_CHECK_URL` is optional for RunPod targets. Without it, NeurOn trusts
RunPod Pod status for capacity readiness. For model discovery, NeurOn infers
RunPod's proxy URL as `https://<pod-id>-<port>.proxy.runpod.net/v1` from
`RUNPOD_POD_ID` and `RUNPOD_RUNTIME_PORT`. Set `RUNTIME_API_BASE_URL` only when
that inferred URL is not right for your runtime.

For installable targets, provide the RunPod create Pod request body as JSON:

```env
CAPACITY_TARGET_RUNPOD_RUNPOD_CREATE_JSON={"name":"prefer","imageName":"ghcr.io/cvalusek/prefer:latest"}
```

Created Pod IDs are held in memory for v1. For durable deployments, prefer
configuring an existing `podId` until persistent target installation state
exists.

`LITELLM_BACKEND_NAME` and target-level `LITELLM_API_BASE_URL` are optional.
They are only for syncing a LiteLLM backend entry when a target becomes healthy;
they are not required for RunPod start/stop or model discovery.

Set `TRAFFIC_MODEL_PREFIXES` when LiteLLM logs model groups with a route prefix,
for example `prefer/gemma-4b-e2b`. The prefix is target configuration; NeurOn
does not require `prefer/` specifically.

## Docker Env Fields

Use `docker` provider targets when NeurOn should control a named container.
Model lists may be omitted when you want runtime discovery to populate choices
from `/v1/models`:

```env
CAPACITY_TARGET_LOCAL_PROVIDER=docker
CAPACITY_TARGET_LOCAL_DOCKER_CONTAINER_NAME=prefer
CAPACITY_TARGET_LOCAL_TRAFFIC_MODEL_PREFIXES=prefer/
```

Set `DOCKER_IMAGE` and optional Docker run fields only when NeurOn should
install a missing container. If the container already exists, NeurOn can start,
stop, inspect, and discover models from it with just the container name and a
runtime URL such as `HEALTH_CHECK_URL`.

Set `TRAFFIC_MODEL_PREFIXES` when LiteLLM logs model names with a route prefix,
for example `prefer/gemma-4b-e2b`. Traffic whose model starts with one of those
prefixes keeps the matching target warm even if runtime model discovery has not
seen that exact LiteLLM-facing name. The prefix can be any target-specific
route prefix, not only `prefer/`.

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
When a target has no configured models, NeurOn bootstraps discovery on startup
by starting the target, waiting for health, reading `/v1/models`, and stopping
the target again. Set `bootstrapOnStartup=false` to opt out.

Optional bootstrap:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_ON_STARTUP=true
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_TIMEOUT_SECONDS=600
```

When enabled, NeurOn starts the target once before accepting requests, waits for
health, reads `/v1/models`, records runtime IDs, and stops the target again.
