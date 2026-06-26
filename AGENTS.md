# AGENTS.md

Context for AI agents and future humans working on NeurOn.

## Project Overview

NeurOn is a lightweight internal control plane for shared self-hosted LLM
capacity. Developers reserve capacity targets and models, and a reconciler keeps
the required runtime capacity on while demand exists.

This repository owns the control plane only. Do not add bundled inference
images, model-download scripts, or runtime-specific model tuning back into this
repo. Those details belong with the external runtime project and should be
referenced through NeurOn target configuration.

## Repository Layout

- `control-plane/` contains the Fastify/TypeScript app, tests, examples, and
  product docs.
- `.github/workflows/` contains the control-plane build workflow.
- `docker/certs/` is reserved for local corporate CA material used by the
  Netskope Dockerfile.

## Architecture Rules

- Request handlers mutate reservation state only. Infrastructure lifecycle
  transitions belong to the reconciler.
- Keep AWS, Docker Compose, and LiteLLM assumptions inside provider and
  integration adapters.
- Prefer the existing interfaces before adding new abstractions:
  `CapacityProvider`, `BackendConfigSync`, `ReservationRepository`,
  `AuthProvider`, `TrafficSource`, and `TargetStatusRepository`.
- v1 storage is in memory. Do not add SQLite/Postgres unless the task is
  explicitly about persistence.
- Model choices are owned by target configuration. Do not infer the production
  catalog from external preset files.

## Configuration Rules

- Config must work without mounting a file. Maintain the env-expanded target
  pattern documented in `control-plane/docs/configuration.md`.
- Keep `CAPACITY_TARGETS_JSON` and `CAPACITY_TARGETS_FILE` working.
- For AWS, prefer `aws.cluster` and `aws.service` because ECS accepts names or
  ARNs. Keep `clusterName` and `serviceName` backward-compatible.
- ASG config uses `autoScalingGroupName`; the AWS APIs used here require the
  ASG name.

## UI Rules

- Server-rendered HTML plus small browser JavaScript only.
- Do not introduce React/Next/Vite SPA machinery.
- Main page status should stay grouped by capacity target.
- Model cards should preserve copy chips for aliases/IDs and context pills.
- Keep copy interactions usable without making the whole card ambiguous.

## Reconciler Rules

- Avoid crashing the app on provider errors.
- Before shutting down a previously-on target, keep the last-minute traffic poll
  behavior unless replacing it with a stronger traffic signal.
- Traffic keepalive must not resurrect failed targets by itself.
- Startup estimates are observational and in-memory. Do not use them for
  scheduling decisions.

## Testing

Run before handing off code changes:

```bash
cd control-plane
npm run typecheck
npm test
```

Most lifecycle behavior should be tested with fake providers. Do not require AWS
or Docker for ordinary unit tests.

## Documentation

Update `control-plane/docs/` when changing design rationale, config shape,
provider behavior, or reconciler semantics. The docs are part of the product
surface for future operators and agents.
