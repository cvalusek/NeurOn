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

- AWS EC2: `CAPACITY_PROVIDER_<KEY>_AWS_EC2_INSTANCE_NAME_PATTERN`
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
- `SHARED_PASSWORD_ENABLED`
- `SHARED_PASSWORD`
- `COOKIE_SECRET`
- `ADMIN_USERS`
- `PUBLIC_BASE_URL`
- `AUTH_METHOD_KEYS`
- `AUTH_METHOD_<KEY>_*`
- `NEURON_UPDATE_CHECK_ENABLED`
- `NEURON_UPDATE_REPOSITORY`
- `NEURON_UPDATE_CHECK_SECONDS`
- `NEURON_UPDATE_GITHUB_TOKEN`
- `GITHUB_AUTH_ENABLED`
- `GITHUB_AUTH_CLIENT_ID`
- `GITHUB_AUTH_CLIENT_SECRET`
- `GITHUB_AUTH_ALLOWED_USERS`
- `GITHUB_AUTH_ALLOWED_ORGS`
- `STORAGE_DRIVER`
- `SQLITE_PATH`
- `DATABASE_URL`
- `POSTGRES_POOL_MAX`
- `CONTROL_PLANE_MAINTENANCE_MODE`
- `STORAGE_OPERATION_LOCK_PATH`
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
- `HASSLEOFF_FAILSAFE_TEST_TARGET_ID`

The defaults favor responsive scheduling and status feedback while keeping
provider calls bounded:

- Reconciler: 10 seconds
- Reservation page polling: 5 seconds
- Main/admin status polling: 5 seconds
- LiteLLM traffic polling: 60 seconds when LiteLLM API config is present

The main and Admin Targets pages use `ADMIN_STATUS_POLL_SECONDS`; the reservation
detail page uses `RESERVATION_STATUS_POLL_SECONDS`.

Successful reservation create, extend, and end mutations request a coalesced
reconciliation pass immediately. `RECONCILER_INTERVAL_SECONDS` is the
steady-state and recovery interval, rather than the normal wait before new
reservation demand is acted on. The request still returns after intent is
stored; it does not wait for provider startup.

## Storage

All eleven durable repository families use the same configured driver. Storage
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
POSTGRES_POOL_MAX=10
```

Local Compose defaults to SQLite at `/app/data/neuron.db` and mounts the
repository `./data` directory into `/app/data`. SQLite and Postgres persist
active reservations, reservation profiles, `sk-neuron-...` API keys, configured
providers, persisted targets, target provisioning jobs, target model discovery
results, model capability/deployment metadata, user model favorites, target
activations, and reservation cost allocation records across NeurOn restarts.
Target status and startup estimates remain in memory because they are
observational and rebuilt by reconciliation.

PostgreSQL repositories share the bounded pool. Schema creation and upgrades
run transactionally through `neuron_schema_migrations`; repository classes do
not own pools or execute startup DDL. Do not use application startup to transfer
SQLite rows. Follow the explicit [SQLite to PostgreSQL migration](postgres-migration.md)
procedure, which retains a consistent rollback backup and enforces one
production database writer.

`CONTROL_PLANE_MAINTENANCE_MODE=true` disables state-changing HTTP/MCP routes,
the reconciler, LiteLLM traffic polling, startup discovery/provider sync, and
HassleOff status calls for storage verification. `STORAGE_OPERATION_LOCK_PATH`
defaults to `data/neuron-storage.lock`; the application and migration command
use the same exclusive lock.

HassleOff continues to own its separate SQLite database regardless of the
NeurOn control-plane storage driver.

## Auth And API Keys

Interactive users can sign in with a username plus the shared password. API
clients can use Basic Auth with the same shared password:

```bash
curl -u clint:dev-password http://localhost:8090/api/models
```

Set `SHARED_PASSWORD_ENABLED=false` to disable both the shared-password form and
HTTP Basic authentication. `SHARED_PASSWORD` is then optional. Keep
`COOKIE_SECRET` configured because GitHub and OIDC sign-in still use it to sign
authorization state and the resulting NeurOn session cookie.

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

### OIDC / Okta

Admins can add OIDC providers from **Admin > Auth**. NeurOn uses Authorization
Code with PKCE, validates the ID token through the provider's discovery
metadata, and creates the same signed NeurOn session cookie used by the other
interactive login methods. For Okta, create a Web Application integration and
register this sign-in redirect URI:

```text
https://<neuron-host>/auth/oidc/callback
```

Set `PUBLIC_BASE_URL` to the externally visible origin (for example,
`https://epd-neuron.sandbox.benefitsgo.tech`) so redirects remain exact behind
an ALB or reverse proxy. Without it, NeurOn uses the forwarded host and protocol
headers.

The issuer can be the Okta organization issuer
(`https://<tenant>.okta.com`) or a custom authorization server issuer
(`https://<tenant>.okta.com/oauth2/<server-id>`). The defaults request
`openid profile email`; NeurOn also requests `groups` when an allowed-groups
list is configured. The default username claim is `preferred_username`.
`ADMIN_USERS` must contain values from the configured username claim for those
users to receive NeurOn admin access.

OIDC client secrets have three sources:

- **Environment variable** is the UI default. The default name follows
  `AUTH_METHOD_<NORMALIZED_ID>_CLIENT_SECRET`.
- **AWS Secrets Manager** stores only the secret name/ARN and optional JSON key
  in NeurOn. The value is fetched at sign-in using the application task role.
  Grant `secretsmanager:GetSecretValue` only for the selected secret ARNs, plus
  `kms:Decrypt` only when those secrets use a customer-managed KMS key.
- **Stored value** persists the client secret in NeurOn's configured database.
  The UI never displays it again, but this mode is not recommended for
  production because the value is not application-encrypted.

Multiple auth methods can also be declared through scoped environment
variables. `AUTH_METHOD_KEYS` is a comma-separated list:

```env
PUBLIC_BASE_URL=https://neuron.example.com
AUTH_METHOD_KEYS=OKTA,PARTNER_OKTA

AUTH_METHOD_OKTA_TYPE=oidc
AUTH_METHOD_OKTA_ID=okta
AUTH_METHOD_OKTA_DISPLAY_NAME=Company Okta
AUTH_METHOD_OKTA_ISSUER=https://company.okta.com/oauth2/default
AUTH_METHOD_OKTA_CLIENT_ID=...
AUTH_METHOD_OKTA_CLIENT_SECRET_SOURCE=environment
# Optional; defaults to AUTH_METHOD_OKTA_CLIENT_SECRET
AUTH_METHOD_OKTA_CLIENT_SECRET_ENV=AUTH_METHOD_OKTA_CLIENT_SECRET
AUTH_METHOD_OKTA_CLIENT_SECRET=...
AUTH_METHOD_OKTA_USERNAME_CLAIM=preferred_username
AUTH_METHOD_OKTA_GROUPS_CLAIM=groups
AUTH_METHOD_OKTA_SCOPES=openid,profile,email,groups
AUTH_METHOD_OKTA_ALLOWED_GROUPS=neuron-users

AUTH_METHOD_PARTNER_OKTA_TYPE=oidc
AUTH_METHOD_PARTNER_OKTA_ISSUER=https://partner.okta.com
AUTH_METHOD_PARTNER_OKTA_CLIENT_ID=...
AUTH_METHOD_PARTNER_OKTA_CLIENT_SECRET_SOURCE=aws-secrets-manager
AUTH_METHOD_PARTNER_OKTA_CLIENT_SECRET_ID=/neuron/auth/partner-okta
AUTH_METHOD_PARTNER_OKTA_CLIENT_SECRET_JSON_KEY=clientSecret
```

The legacy single-provider `GITHUB_AUTH_*` variables remain supported.

## Image Update Checks

Published images contain `NEURON_BUILD_SHA`, which identifies the source commit
that produced the running container. NeurOn compares it with the most recent
successful `Build NeurOn image` workflow run on `main` and displays an admin
banner when a newer image is available.

```env
NEURON_UPDATE_CHECK_ENABLED=true
NEURON_UPDATE_REPOSITORY=cvalusek/NeurOn
NEURON_UPDATE_CHECK_SECONDS=900
```

Update checks are automatically enabled when `NEURON_BUILD_SHA` is present and
are disabled for ordinary source checkouts. `NEURON_UPDATE_GITHUB_TOKEN` is
optional for private repositories or higher GitHub API limits; inject it as a
secret and do not store it in target configuration. The token needs read-only
access to repository Actions metadata and repository content. The task also
needs outbound HTTPS access to `api.github.com`. NeurOn compares the running and
available revisions, displays changed
`control-plane/changes/*.md` fragments, and falls back to commit titles when a
range has no curated fragments. Check or patch-note failures are reported in the
admin page and never affect reconciliation.

Update controls are available from **Admin > Updates**. See
[Operations](operations.md#safe-update-restarts) for shutdown semantics and
orchestrator requirements.

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
For AWS EC2 targets, NeurOn similarly discovers current on-demand or Spot
hourly prices when the appropriate task-role read permissions are present.
The override still takes precedence and requires no pricing permissions.

## Guided Model Selection

The profile builder always works from the configured NeurOn target/model
catalog. Capability scores and exact target-model context, quantization,
quality-retention, and speed measurements are durable application data managed
at **Admin > Model data**. They are not environment configuration. Keep source,
version, and retrieval provenance with every licensed or deployment-private
value and never put those values in tracked examples or release notes.

Unknown values stay unknown and cannot satisfy a corresponding hard filter.
Explicit discovery can measure target-specific prefill and decode speed against
an already-activated runtime; it is never an application-start side effect. See
[Guided Model Selection](model-selection.md) for ranking, benchmarking,
provenance, and quantization rules.

The optional profile assistant uses an existing NeurOn target/model deployment,
selected at **Admin > Model data** after the target has been copied to durable
storage. Its backend is not configured through environment variables. The
stored selection includes the advisor reservation length, cold-start timeout,
and model-response timeout; runtime credentials continue to use the selected
target's existing secret reference.

Asking the assistant creates or refreshes a synthetic system reservation for
that deployment and waits for the normal reconciler and health path. The model
may fill a browser draft immediately, but save, start-reservation, rediscovery,
and other mutating or capacity-affecting tools require a separate confirmation
in the UI. If no backend is selected, local filters and ranking still work.

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

Use `aws-ec2` when NeurOn should start and stop one existing EC2 instance:

```env
CAPACITY_TARGET_GPU_INSTANCE_PROVIDER=aws-ec2
CAPACITY_TARGET_GPU_INSTANCE_AWS_INSTANCE_ID=i-1234567890abcdef0
# Optional; these are the defaults used for runtime endpoint discovery.
CAPACITY_TARGET_GPU_INSTANCE_AWS_RUNTIME_PORT=8080
CAPACITY_TARGET_GPU_INSTANCE_AWS_RUNTIME_PROTOCOL=http
CAPACITY_TARGET_GPU_INSTANCE_AWS_HEALTH_PATH=/health
CAPACITY_TARGET_GPU_INSTANCE_AWS_API_PATH=/v1
```

The EC2 provider reads the instance's current private IP address (or private DNS
name) and derives the health and API URLs. Explicit target `HEALTH_URL` and
`API_URL` values override the derived values. Reusable EC2 providers can limit
the Admin UI's **Find EC2 instances** result set by Name tag:

```env
CAPACITY_PROVIDER_KEYS=AWS_MAIN
CAPACITY_PROVIDER_AWS_MAIN_ID=aws-main
CAPACITY_PROVIDER_AWS_MAIN_DISPLAY_NAME=AWS Main
CAPACITY_PROVIDER_AWS_MAIN_TYPE=aws-ec2
CAPACITY_PROVIDER_AWS_MAIN_AWS_EC2_INSTANCE_NAME_PATTERN=*.prefer.*
```

When omitted, EC2 discovery uses `*.prefer.*`. Set an explicit provider pattern
to narrow the naming convention further, or `*` to intentionally list every
named instance visible to the task role.

Use `aws-ecs` or `aws-ecs-asg` when NeurOn should control an ECS service backed
by an Auto Scaling Group:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_CLUSTER=llm-cluster
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_SERVICE=llama-cpp-gpu-pool-96gb
CAPACITY_TARGET_MULTIPLE_MOE_96GB_AWS_ASG_NAME=llm-gpu-pool-96gb-asg
```

`AWS_CLUSTER` and `AWS_SERVICE` may be names or ARNs. The Auto Scaling Group
must be supplied by name because Auto Scaling APIs use `AutoScalingGroupName`.
EC2 targets do not use an Auto Scaling Group.

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

When the global `LITELLM_API_BASE_URL` and `LITELLM_API_KEY` are configured,
each successful runtime model discovery also synchronizes the target credential
and its canonical model IDs to LiteLLM. `LITELLM_BACKEND_NAME` remains accepted
for compatibility with older target definitions but is not used by the
discovered-model sync. A target-level `LITELLM_API_BASE_URL` overrides the
runtime API base stored in its LiteLLM credential; normally the provider-derived
`API_URL` is used instead.

Set `TRAFFIC_MODEL_PREFIXES` to override the LiteLLM route prefixes for a target,
for example `prefer/gemma-4b-e2b`. When omitted, NeurOn uses `<target-id>/`, so
target `g6.xlarge.general` publishes and recognizes
`g6.xlarge.general/gemma-4-e2b` without per-target prefix configuration.

Set `LITELLM_DISPLAY_PREFIX` when client-facing LiteLLM model names differ from
traffic log prefixes. By default, plugin clients use the first
`TRAFFIC_MODEL_PREFIXES` value, or `<target-id>/` when no traffic prefix is
configured. Set
`CAPACITY_TARGET_<KEY>_LITELLM_DISPLAY_PREFIX=__empty__` to publish an empty
prefix from environment config when LiteLLM aliases the prefix away. JSON config
can use `"litellmDisplayPrefix": ""` directly.

Set the hosting shape and alias priority when they are known:

```env
CAPACITY_TARGET_G6_XLARGE_GENERAL_HOSTING_MODE=dedicated
CAPACITY_TARGET_G6_XLARGE_GENERAL_ALIAS_PRIORITY=10
```

`HOSTING_MODE` is `dedicated` or `multi-model` and is used by the profile
builder's hard filter. Lower positive `ALIAS_PRIORITY` values win collisions
for global LiteLLM aliases. Scoped `<target>/<alias>` names remain available for
every target, and LiteLLM deployments carry the same numeric order for fallback.

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
route prefix, not only `prefer/`. The Admin target create and persisted-target
edit forms expose the same comma-separated setting; for example,
`clint-desktop/` maps
`clint-desktop/gemma-4-e2b` model names and traffic to that target. The first
traffic prefix is also the default `litellmDisplayPrefix` exposed to clients.
For a declarative target, set the field in JSON/env configuration or use
**Copy to DB** before editing it in Admin.

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
When a target has no configured models and no persisted discovery record,
NeurOn bootstraps discovery on startup by starting the target, waiting for
health, reading `/v1/models`, persisting the result with a discovery timestamp,
and releasing its target-scoped operation lease. Capacity started only for
discovery is stopped when no reservation or traffic demand exists.

Before startup discovery runs, NeurOn hydrates persisted discovery records.
Any record, including a successful empty catalog, satisfies automatic startup
bootstrap. NeurOn then reuses the cache without calling the provider, health
URL, or model endpoint. `bootstrapOnStartup=true` enables an initial bootstrap
for a target with configured models; it does not force a refresh on every
control-plane restart. Set it to `false` to opt out. Use the authenticated Admin
**Discover models now** action when an operator wants to force a refresh.
Reuse across process restarts requires `STORAGE_DRIVER=sqlite` or `postgres`;
the `memory` driver has no persisted record after a restart.

Optional bootstrap:

```env
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_ON_STARTUP=true
CAPACITY_TARGET_MULTIPLE_MOE_96GB_MODEL_DISCOVERY_BOOTSTRAP_TIMEOUT_SECONDS=600
```

When enabled and no persisted result exists, NeurOn starts the target once,
waits for health, reads `/v1/models`, records runtime IDs, persists the result,
and reconciles discovery-started capacity against current demand.

### LiteLLM Discovered-Model Sync

When global LiteLLM connectivity is configured, discovery creates or updates one
reusable credential per target and one LiteLLM deployment per primary `id`
returned by `/v1/models`. The defaults are:

- credential name: `neuron/<target-id>`
- callable model name: `<effective-prefix><runtime-model-id>`
- provider: OpenAI-compatible (`custom_llm_provider=openai`)
- API key: the target key environment variable, or `noapikey` when the runtime
  does not require authentication
- runtime model: the primary `/v1/models` `id`, unchanged

The credential carries the current runtime `api_base`, so a provider-derived EC2
private-address change updates the credential once for every model on the
target. Configure the runtime key by reference, never by value:

```env
CAPACITY_TARGET_G6_XLARGE_GENERAL_LITELLM_API_KEY_ENV=PREFER_G6_XLARGE_GENERAL_API_KEY
PREFER_G6_XLARGE_GENERAL_API_KEY=<injected-secret>
```

Optional overrides and opt-out:

```env
CAPACITY_TARGET_G6_XLARGE_GENERAL_LITELLM_CREDENTIAL_NAME=neuron/g6.xlarge.general
CAPACITY_TARGET_G6_XLARGE_GENERAL_LITELLM_SYNC_DISCOVERED_MODELS=false
```

NeurOn records `neuron_target_id` and `neuron_target_display_name` in LiteLLM
credential/deployment metadata. Credential metadata also identifies the provider
as `openai`; a non-empty `noapikey` placeholder keeps LiteLLM's OpenAI-compatible
client usable for unauthenticated runtimes. Primary IDs and configured/runtime
aliases are published as scoped `<target>/<alias>` routes. The lowest target
`aliasPriority` also publishes each unscoped alias; ties fail closed instead of
making routing nondeterministic. The LiteLLM deployment `order` carries this
priority, allowing a global alias to fall through to a later target when
LiteLLM pre-call checks and ordered fallback are enabled.

NeurOn does not change deployment block state when capacity stops. Deployments
that disappear from later discovery are retired non-destructively under a
`neuron-retired/...` name, preserving their LiteLLM database record while
removing the stale callable alias. This keeps current routes available for
LiteLLM queueing while capacity starts and does not override operator-managed
block state.

LiteLLM must have database-backed model storage enabled. Its global API key must
be allowed to manage models and reusable credentials. Because target API keys
are sent to LiteLLM during credential upsert, use TLS for the NeurOn-to-LiteLLM
connection outside an explicitly accepted trusted-network setup. LiteLLM marks
its reusable-credentials endpoint as beta, so pin and test the LiteLLM version
used by the deployment. Ordered fallback also depends on LiteLLM version and
router configuration; enable pre-call checks and verify the chosen version with
a disposable routing test before relying on fallback in production.

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
