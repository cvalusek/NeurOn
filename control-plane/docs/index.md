# NeurOn Knowledge Bundle

## Orientation

* [User Guide](user-guide.md) - Profiles, reservations, keepalive, status, and cost.
* [OKF Bundle Notes](okf.md) - How this directory uses Open Knowledge Format.
* [Architecture](architecture.md) - Domain objects, services, and request flow.
* [Reconciler](reconciler.md) - Desired-state loop and lifecycle decisions.
* [Configuration](configuration.md) - JSON, file, and env-expanded config.
* [Integrations](integrations.md) - API keys, OpenAPI, Swagger UI, and MCP.
* [Providers](providers.md) - Lifecycle boundaries for Docker, AWS, RunPod, upstream NeurOn, and LiteLLM.
* [Targets](targets.md) - Target config, provider relationships, and runtime profiles.
* [PreFer](prefer.md) - PreFer runtime config, presets, and plugin direction.
* [Provisioning](provisioning.md) - Explicit resource creation and persisted jobs.
* [HassleOff](hassleoff.md) - Dead-man leases, start interlock, fail-safe testing, and scoped shutdowns.
* [Discovery](discovery.md) - Runtime model discovery and bootstrap behavior.
* [Guided Model Selection](model-selection.md) - Private capability data, target performance, filters, ranking, and optional AI guidance.
* [SQLite to PostgreSQL Migration](postgres-migration.md) - Fail-closed backup, dry-run, cutover, verification, and rollback.
* [UI](ui.md) - Target-first interaction model and server-rendered pages.
* [Operations](operations.md) - Deployment, IAM, runtime behavior, and limits.

## North Star

NeurOn should make the expensive thing obvious and controlled. A developer
should be able to answer three questions quickly:

* Which shared runtime am I waking up?
* Which models do I expect to use?
* How long should it stay available?

The implementation should remain boring on purpose: explicit service classes,
small REST endpoints, server-rendered HTML, and provider interfaces that keep
AWS, Docker, and LiteLLM assumptions contained.

## Documentation map

New users should begin with the [User guide](user-guide.md). Operators should
then read [Configuration](configuration.md), [Providers](providers.md), and
[Operations](operations.md). Changes to durable storage belong with the
[PostgreSQL migration playbook](postgres-migration.md); HassleOff always remains
the separate failure domain described in its own [operating guide](hassleoff.md).
