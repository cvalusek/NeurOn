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

A reservation represents intent from an authenticated user.

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

A reservation contributes to desired capacity only when it is active and its
expiration is in the future.

### CapacityTarget

A capacity target represents a shared runtime/backend. It can serve one or more
models and is handled by a provider such as Docker Compose or AWS ECS/ASG.

Important fields:

- `id`
- `displayName`
- `provider`
- `models`
- `modelsMax`
- provider-specific config
- `healthCheckUrl`
- optional LiteLLM backend config
- optional runtime model discovery config

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

## Interfaces

The core interfaces keep replaceable parts isolated:

- `CapacityProvider`
- `BackendConfigSync`
- `ReservationRepository`
- `ApiKeyRepository`
- `AuthProvider`
- `TrafficSource`
- `TargetStatusRepository`

Implementations should depend on these interfaces instead of directly reaching
into AWS, Docker, LiteLLM, or a concrete repository from unrelated code.

## Main Services

- `ReservationService`: validates user input, canonicalizes model IDs, creates,
  extends, and ends reservations.
- `ApiKeyService`: generates personal API keys, stores only hashed key
  material, lists key metadata, and revokes keys.
- `ModelCatalog`: maps selectable model IDs, aliases, backend IDs, and runtime
  IDs to model definitions and targets.
- `Reconciler`: computes desired target state from aggregate reservations and
  applies that state through a capacity provider.
- `TrafficKeepaliveService`: records recent traffic as a short-lived synthetic
  reservation when the target is already healthy or has real user demand.
- `TrafficPoller`: polls a `TrafficSource` and records keepalive traffic.
- `BackendConfigSync`: pushes backend configuration/availability into LiteLLM
  or another proxy when runtime state changes.
- `RuntimeModelDiscovery`: reads OpenAI-compatible `/v1/models` from healthy
  targets, records runtime IDs, trusts API-provided aliases, and uses runtime
  metadata such as context size, parameter count, vocabulary size, and model
  size when it is provided. A later discovery pass can enrich an already
  discovered model after the runtime has loaded it.

## Request Flow

1. Auth resolves an `AuthenticatedUser`.
2. UI or API creates a reservation with model IDs, duration, and keepalive
   window.
3. `ReservationService` maps models to targets through `ModelCatalog`.
4. Request handler stores intent only. It does not directly start or stop
   infrastructure.
5. The periodic reconciler observes aggregate desired state and applies provider
   changes.

## API Keys

Users can create personal API keys from the UI or `/api/api-keys`. Newly
generated keys use the `sk-neuron-...` format and are returned only in the
creation response. NeurOn stores a SHA-256 hash plus a display prefix, so later
list responses can show which key exists without revealing the secret again.

API keys authenticate REST calls with `Authorization: Bearer <key>` and resolve
to the same username and admin status as the user that created them. Revoking a
key removes it immediately from the configured API key repository.

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

Target status, startup estimates, and runtime model discovery cache remain
in-memory observational state. Provider state is still observed on the next
reconciliation loop, and startup estimates are not used for scheduling
decisions.
