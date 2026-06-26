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
- `AuthProvider`
- `TrafficSource`
- `TargetStatusRepository`

Implementations should depend on these interfaces instead of directly reaching
into AWS, Docker, LiteLLM, or the in-memory repository from unrelated code.

## Main Services

- `ReservationService`: validates user input, canonicalizes model IDs, creates,
  extends, and ends reservations.
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

## State

v1 uses in-memory repositories. This keeps the implementation small, but it
means reservations and startup estimates reset on app restart. Provider state is
still observed on the next reconciliation loop.
