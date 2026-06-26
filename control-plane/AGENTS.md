# AGENTS.md

Context for AI agents and future humans working on NeurOn.

## Project Overview

NeurOn is a lightweight internal control plane for shared self-hosted LLM
capacity. Developers reserve capacity targets and models, and a reconciler keeps
the required runtime capacity on while demand exists.

This repository is NeurOn. Do not add bundled inference images or model-preset
logic back into the control plane; runtime details belong in target
configuration or in the external runtime project.

## Product Principles

- Target-first UX is intentional. A target is the expensive shared runtime.
- Model choices express user intent; they are not a capacity solver.
- Multiple users can overlap on one target.
- Ending one reservation must not stop a target needed by another reservation.
- Keep runtime states simple: stopped, provisioning, healthy, stopping, failed.
- `modelsMax` is display/debug metadata only.

## Architecture Rules

- Request handlers mutate reservation state only. Infrastructure lifecycle
  transitions belong to the reconciler.
- Keep AWS, Docker, and LiteLLM assumptions inside provider/integration
  adapters.
- Prefer the existing interfaces before adding new abstractions:
  `CapacityProvider`, `BackendConfigSync`, `ReservationRepository`,
  `AuthProvider`, `TrafficSource`, and `TargetStatusRepository`.
- v1 storage is in memory. Do not add SQLite/Postgres unless the task is
  explicitly about persistence.
- Use explicit service classes and typed interfaces over framework magic.

## Configuration Rules

- Config must work without mounting a file. Maintain the env-expanded target
  pattern documented in `docs/configuration.md`.
- Keep `CAPACITY_TARGETS_JSON` and `CAPACITY_TARGETS_FILE` working.
- For AWS, prefer `aws.cluster` and `aws.service` because ECS accepts names or
  ARNs. Keep `clusterName` and `serviceName` backward-compatible.
- ASG config uses `autoScalingGroupName`; the AWS APIs used here require the
  ASG name.
- Model choices are owned by NeurOn target configuration. Do not infer the
  production catalog from external preset files.

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
npm run typecheck
npm test
```

Most lifecycle behavior should be tested with fake providers. Do not require AWS
or Docker for ordinary unit tests.

## Documentation

Update `docs/` when changing design rationale, config shape, provider behavior,
or reconciler semantics. The docs are part of the product surface for future
operators and agents.
