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
  `ApiKeyRepository`, `AuthProvider`, `TrafficSource`, and
  `TargetStatusRepository`.
- The selected storage driver supplies reservations, reservation profiles, API
  keys, auth methods, provider and target definitions, provisioning jobs,
  runtime discovery records, model capability/deployment metadata, user model
  favorites, independent assistant configuration, target activation/cost
  history, durable users and identity links, local credentials, roles, nested
  teams, memberships, invitations, external user links, and identity audit
  events. SQLite and Postgres are durable; memory storage is process-local.
- Stable user IDs own profiles, real reservations, API keys, and favorites.
  Provider usernames are identity attributes, not durable ownership keys.
- Local authentication uses per-user credentials; do not reintroduce a
  deployment-wide shared password. Protect wildcard Owner authority and keep an
  offline, lock-taking Owner recovery path.
- Enforce global/team/user target audiences consistently across UI, REST, MCP,
  reservations, discovery, and traffic attribution.
- Target status and startup estimates remain observational and in-memory unless
  a task is explicitly about persisting them.
- PostgreSQL schema changes belong in the centralized versioned migration
  ledger. Repositories share one bounded application pool and must not create
  their own pools or run startup DDL.
- Model choices are owned by target configuration. Do not infer the production
  catalog from external preset files.
- Reservation profiles may contain multiple target/model selections. Preserve
  the per-target mapping when storing a reservation; aggregate target/model
  arrays remain a compatibility surface for legacy records and clients.
- Model-selection scores must retain source/version provenance. Intelligence,
  scored strengths, and quantization facts belong to the canonical model;
  performance belongs to the exact target-model deployment; serving context
  belongs to target/model configuration or runtime discovery. These are managed
  through the application, not environment configuration. Never put
  licensed/private values in tracked examples or release notes. Missing
  performance or quality data must remain unknown rather than inferred from
  model names or quant formats.

## Configuration Rules

- Config must work without mounting a file. Maintain the env-expanded target
  pattern documented in `control-plane/docs/configuration.md`.
- Keep `CAPACITY_TARGETS_JSON` and `CAPACITY_TARGETS_FILE` working.
- For AWS, prefer `aws.cluster` and `aws.service` because ECS accepts names or
  ARNs. Keep `clusterName` and `serviceName` backward-compatible.
- ASG config uses `autoScalingGroupName`; the AWS APIs used here require the
  ASG name.

## Integration Rules

- Users can create personal `sk-neuron-...` API keys from `/api-keys`. The full
  key is shown once and stored only as a hash.
- API keys authenticate REST and MCP calls with `Authorization: Bearer <key>`.
- OpenAPI 3.0 is available at `/openapi.json`; Swagger UI is available at
  `/docs`.
- MCP is exposed at `/mcp` with JSON-RPC methods `initialize`, `tools/list`,
  and `tools/call`. Current tools list models, targets, and status, and create
  or end reservations.
- MCP `end_reservation` must remain scoped to reservations owned by the API-key
  user. Do not loosen this to admin-wide cancellation without an explicit task
  and careful safety review.
- The Codex stdio bridge lives at
  `control-plane/scripts/neuron-mcp-stdio.js` and forwards stdio-framed MCP
  messages to NeurOn's HTTP `/mcp` endpoint.
- LiteLLM sync keeps one canonical deployment per target/runtime model. Publish
  friendly names through `model_group_alias` and priority failover through
  `fallbacks`; never materialize aliases as duplicate model deployments.

## UI Rules

- Server-rendered HTML plus small browser JavaScript only.
- Do not introduce React/Next/Vite SPA machinery.
- Main page status should stay grouped by capacity target.
- Model cards should preserve copy chips for aliases/IDs and context pills.
- Keep copy interactions usable without making the whole card ambiguous.
- Keep the API keys page on the same server-rendered UI pattern. Generated
  keys should be copyable once, and later lists must show metadata/prefix only.
- Profile-assistant configuration tools may populate reversible browser
  controls immediately. Save-profile, start-reservation, rediscovery, and any
  other mutating or capacity-affecting tool must produce a UI confirmation and
  must not invoke its domain service until the user confirms that exact action.
- The profile assistant backend is an operator-selected existing target/model
  deployment stored in its own singleton durable assistant configuration, not
  inside target or model data. Asking for guidance may create a visible
  synthetic system reservation through the normal reconciler; do not add a
  separate environment-configured advisor endpoint.

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
provider behavior, API/auth/integration surfaces, or reconciler semantics. The
docs are part of the product surface for future operators and agents.

Add a concise `control-plane/changes/*.md` fragment for every user- or
operator-visible control-plane change so the Updates screen can explain the
delta between the running and available revisions. Never put secrets or private
deployment data in a release-note fragment.
