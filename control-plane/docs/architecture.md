---
type: Architecture
title: NeurOn Architecture
description: Domain objects, interfaces, services, request flow, and state boundaries.
tags: [architecture, domain, services]
timestamp: 2026-06-25T00:00:00Z
---

# Architecture

NeurOn is a Fastify + TypeScript application with OpenAPI-compatible REST
routes and server-rendered HTML. Browser JavaScript is limited to polling and
small interaction helpers.

## Core Domain

### Reservation

A reservation represents intent from an authenticated user. Every real
reservation is owned by a durable `userId`; `username` remains a denormalized
display/compatibility field. Synthetic system reservations have no user owner.

Important fields:

- `id`
- `username`
- `modelIds`
- `targetIds`
- `createdAt`
- `expiresAt`
- `keepaliveMinutes`: the traffic keepalive window to apply while the
  reservation is active
- `endedAt`
- `status`: `active`, `done`, `expired`, or `failed`
- optional `failureMessage`
- optional `synthetic` for traffic keepalive reservations
- optional `profileId` and `profileName` when the reservation was created from
  a saved reservation profile
- optional `targetSelections`, an immutable snapshot of the exact model IDs
  selected for each target. Legacy reservations without this field keep the
  original aggregate `modelIds` and `targetIds` behavior.

A reservation contributes to desired capacity only when it is active and its
expiration is in the future.

### User, roles, and teams

A `User` is NeurOn's stable ownership root. Local credentials and external
GitHub/OIDC identities are separate authentication links to it. Profiles,
reservations, API keys, favorites, LiteLLM subjects, global roles, and team
memberships use the durable user ID, so a provider username change does not
orphan state.

Global roles grant application permissions. Owner is the protected wildcard
role; final-Owner removal is serialized in PostgreSQL and guarded in every
repository. Teams form an acyclic hierarchy backed by a closure table, which
allows an audience granted to a parent to include descendant-team members.
Targets declare a global, team, or user audience, and the same visibility check
is applied by UI, REST, MCP, reservation creation, and traffic attribution.

### ReservationProfile

A reservation profile is a saved launch shape with a durable user creator/audit
owner. It is personal by default, or it may carry one durable team ID that
shares it with eligible members of that team and its descendants. Team
owners/managers can maintain profiles in their managed hierarchy; installation
administrators can manage every team profile. It records one or more target
selections, each with the model IDs the user expects to use on that target. The
UI can combine several target/model selections in one profile and automatically
selects the only model on single-model targets.

Profiles are not runtime provider presets. They do not tune inference images,
download models, or infer a production catalog. They only store user reservation
intent. `ReservationService` snapshots the target-specific selections onto the
reservation while retaining aggregate `modelIds` and `targetIds` for compatible
clients and legacy records. A team profile can contain only global targets or
team targets whose audience contains the profile team; personal/user-only
targets cannot accidentally be shared with a broader team.

### TargetActivation

A target activation represents one contiguous period where the reconciler desired
a capacity target on. Activations are created and closed by the reconciler, not
by request handlers.

Target activation reservations connect an activation to the reservations that
contributed to it. They accumulate estimated cost allocated back to each
reservation. Reservation API payloads expose their sum as
`costEstimate`.

Synthetic traffic reservations never receive cost. When an activation enters a
traffic-only tail, its durable links to the latest real participating
reservations remain the allocation owners until new real demand supersedes
them. This keeps attribution stable across control-plane restarts without
claiming that the traffic source identifies a user.

Configured hourly target estimates take precedence. Providers may otherwise
return a current hourly estimate through `getTargetCostEstimate`; AWS EC2 uses
on-demand catalog or Spot market data and RunPod uses Pod details. These remain
operational estimates, not provider invoices or negotiated-discount accounting.

### CapacityTarget

A capacity target represents a shared runtime/backend. It can serve one or more
models and is handled by a provider such as Docker Compose or AWS ECS/ASG.
Today the `provider` field is a provider adapter key. The persisted provider
and target management model separates provider type, provider instance, optional
credentials, and target-specific runtime config so one configured provider can
own multiple targets. See [Providers](providers.md) and [Targets](targets.md).

Important fields:

- `id`
- `displayName`
- `provider`
- `models`
- `modelsMax`
- provider-specific config
- `healthUrl`
- optional LiteLLM backend config
- optional runtime model discovery config
- optional HassleOff protection and activate-or-reprovision policy
- optional `hostingMode` and numeric LiteLLM `aliasPriority`

### ModelDefinition

Models are configuration-first. They are the user-facing choices under a target.
Runtime `/v1/models` data enriches them, but it does not create surprise capacity
decisions.

Important fields:

- `id`
- `displayName`
- `modelFamily`
- `aliases`
- `tags`
- `backendModelIds`
- `contextLabel` or `contextWindowTokens`
- `targetIds`
- `runtimeModelIds`
- `runtimeMeta`

Intelligence, scored strengths, quantization format, and estimated quality
retained attach to the canonical model artifact. Serving context comes from the
target's model configuration or runtime discovery. Performance attaches to the
exact target-model deployment. Measurements retain provenance and use the
selected durable storage driver. User favorites identify an exact target-model
pair. Binary technical capabilities such as vision and tool use come from
explicit configuration or runtime-advertised discovery fields.

## Interfaces

The core interfaces keep replaceable parts isolated:

- `CapacityProvider`
- `BackendConfigSync`
- `ReservationRepository`
- `ApiKeyRepository`
- `TargetModelDiscoveryRepository`
- `TargetActivationRepository`
- `ModelMetadataRepository`
- `ModelFavoriteRepository`
- `AssistantConfigRepository`
- `IdentityRepository`
- `AuthProvider`
- `TrafficSource`
- `TargetStatusRepository`

Implementations should depend on these interfaces instead of directly reaching
into AWS, Docker, LiteLLM, or a concrete repository from unrelated code.

## Main Services

- `ReservationService`: validates user input, canonicalizes model IDs, creates,
  extends, and ends reservations. It can also expand a user-owned reservation
  profile into a normal reservation request.
- `ReservationProfileService`: validates and stores personal and team-shared
  reservation profiles, including team management and whole-team target access.
- `CostEstimationService`: records target activations and accumulates estimated
  per-reservation cost allocations from reconciler state.
- `ApiKeyService`: generates personal API keys, stores only hashed key
  material, lists key metadata, and revokes keys.
- `IdentityService`: authenticates local credentials, attaches stable external
  subjects, resolves live roles and nested-team membership, protects Owner
  authority, manages invitations and external LiteLLM links, and atomically
  previews/merges duplicate users.
- `AuthMethodService`: combines environment-backed external methods with
  durable local/GitHub/OIDC methods and validates OIDC membership rules before
  persistence.
- `ModelCatalog`: maps selectable model IDs, aliases, backend IDs, and runtime
  IDs to model definitions and targets.
- `ModelSelectionService`: combines durable capability metadata, exact
  target-model deployment facts, target cost, and performance observations. It
  applies hard requirements before deterministic weighted ranking and treats
  missing measurements as unknown.
- `ModelBenchmarkService`: runs an explicit 50K-class warm-up-plus-three-sample suite
  against an activated target and persists median prefill/decode measurements.
- `ModelFavoriteService`: stores user favorites for exact target-model pairs.
- `UsageAnalyticsService`: derives deployment popularity and UTC daily/user/
  provider/target/model breakdowns from durable reservations and allocations.
- `ProfileAdvisorService`: runs an operator-selected existing target/model
  through a synthetic system reservation and normal reconciliation, then
  converts a sanitized catalog and structured current-screen snapshot into a
  validated allowlisted tool proposal. Its in-memory request coordinator
  exposes owner-scoped waking/thinking/completed polling, while the browser
  retains session-scoped bounded conversation history, compaction state,
  previous screen context, and pending UI state. The invariant system/catalog
  prefix stays stable for model-host caching; subsequent application context is
  emitted as a delta. Warm requests use the configured response deadline,
  while the first completion after a cold start gets the reservation-duration
  response window. One constrained repair pass accepts providers that return an
  empty or malformed tool result without loosening tool validation. Reversible profile
  controls can be filled immediately; profile saves, reservation starts, and
  capacity-affecting admin proposals remain separate UI-confirmed actions.
- `Reconciler`: computes desired target state from aggregate reservations and
  applies that state through a capacity provider. When a target is no longer
  continuously healthy it clears the process-local model-warmup cache, so the
  next healthy transition prepares the runtime model again.
- `HassleOffCapacityProvider`: decorates provider lifecycle calls with the
  opt-in exact-target start/provision interlock and stale-test shutdown route.
- `ActivateOrReprovisionCapacityProvider`: recognizes only the typed
  recoverable-unavailable condition and applies a policy-gated durable
  replacement binding before retrying activation.
- `TrafficKeepaliveService`: records recent traffic as a short-lived synthetic
  reservation when the target is already healthy or has real user demand.
- `TrafficPoller`: polls a `TrafficSource`, records one latest keepalive signal
  per target-model route, and forwards unambiguous performance observations to
  model selection.
- `BackendConfigSync`: pushes backend configuration/availability into LiteLLM
  or another proxy when runtime state changes. The LiteLLM adapter owns one
  canonical deployment per target/runtime model and manages friendly names and
  priority failover through formal model-group aliases and fallbacks; it does
  not materialize aliases as duplicate deployments.
- `RuntimeModelDiscovery`: reads OpenAI-compatible `/v1/models` from healthy
  targets, records runtime IDs, trusts API-provided aliases, and uses runtime
  metadata such as context size, parameter count, vocabulary size, and model
  size when it is provided. Discovery results are persisted per target with a
  discovery timestamp and hydrated into the catalog on startup. A later
  discovery pass can enrich an already discovered model after the runtime has
  loaded it.
- `TargetOperationCoordinator`: owns in-memory target-scoped discovery leases,
  coalesces duplicate discovery, rejects force-stop/discovery conflicts, and
  serializes provider lifecycle mutations per target. The reconciler consumes
  operation leases as non-attributable desired-on demand.

## Request Flow

1. Auth resolves the credential or signed session to a durable user, then
   refreshes current status, roles, permissions, and team closure.
2. UI or API creates a reservation with model IDs, duration, and keepalive
   window, or with a `profileId` plus duration/keepalive.
3. `ReservationService` validates target-specific model selections through
   `ModelCatalog`, expanding the profile first when one was provided.
4. Request handler stores intent only. It does not directly start or stop
   infrastructure.
5. A successful reservation mutation requests a non-blocking, coalesced
   reconciler pass, which observes aggregate desired state and applies provider
   changes. The periodic loop remains the steady-state recovery path.

API clients can also extend a reservation relative to the current request time
with `fromNow`. This is useful for plugins that send a small keep-warm signal
before each chat message without accumulating a long reservation tail.

## API Keys

Users can create personal API keys from the UI or `/api/api-keys`. Newly
generated keys use the `sk-neuron-...` format and are returned only in the
creation response. NeurOn stores a SHA-256 hash plus a display prefix, so later
list responses can show which key exists without revealing the secret again.

API keys authenticate REST calls with `Authorization: Bearer <key>` and resolve
to the current durable user state. Disabling or merging the user, changing a
role, or changing a target audience takes effect on the next request. Revoking
a key removes it immediately from the configured API key repository.

## Integration Surfaces

NeurOn exposes an OpenAPI 3.0 document at `/openapi.json` and Swagger UI at
`/docs`. The OpenAPI document includes Basic and Bearer authentication schemes,
with `sk-neuron-...` API keys intended for plugin integrations.

NeurOn also exposes a lightweight authenticated MCP JSON-RPC endpoint at
`/mcp`. It supports `initialize`, `tools/list`, and `tools/call` for these
tools:

- `list_models`
- `list_targets`
- `get_status`
- `create_reservation`
- `end_reservation`

## State

Reservations and API keys can use memory, SQLite, or Postgres storage behind
their repository interfaces. Durable storage lets NeurOn restart without
forgetting active demand or invalidating plugin keys, so reconciliation
continues to keep matching targets on after the process comes back.

Reservation profiles use the same memory, SQLite, or Postgres storage family.
SQLite and Postgres store the profile target selections as JSON so the profile
can grow from one target selection to many without a relational schema change.

Runtime model discovery results persist with the configured storage driver so
NeurOn can restart without waking discovery-only targets just to recover their
model list. Presence of a persisted record, including an empty successful
catalog, suppresses a full process-start discovery pass; manual discovery and
post-provision refresh remain explicit paths. Target status and startup
estimates remain in-memory observational state. Provider state is still
observed on the next reconciliation loop, and startup estimates are not used
for scheduling decisions.

The durable driver is one control-plane ownership boundary covering
reservations, profiles, hashed API keys, auth methods, provider and target
definitions, provisioning jobs, model discovery, model capability/deployment
metadata, favorites, assistant configuration, activation/cost history, and the
identity graph (users, identities, local credentials, roles, assignments,
nested teams, memberships, invitations, external links, and audit events).
PostgreSQL uses one bounded shared pool.
Ordered transactional schema changes are recorded in
`neuron_schema_migrations`; the data-transfer ledger is separate so an exact
SQLite import can be verified without confusing it with schema upgrades.

Only one application storage writer may own the deployment. A storage operation
lock coordinates application startup with explicit backup/migration commands,
and maintenance mode suppresses lifecycle/provider side effects during cutover
verification. HassleOff is a separate failure domain with its own SQLite state
and is outside this ownership boundary.
