# NeurOn Knowledge Bundle

## Orientation

* [OKF Bundle Notes](okf.md) - How this directory uses Open Knowledge Format.
* [Architecture](architecture.md) - Domain objects, services, and request flow.
* [Reconciler](reconciler.md) - Desired-state loop and lifecycle decisions.
* [Configuration](configuration.md) - JSON, file, and env-expanded config.
* [Integrations](integrations.md) - API keys, OpenAPI, Swagger UI, and MCP.
* [Providers](providers.md) - Docker Compose, AWS ECS/ASG, and LiteLLM.
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
