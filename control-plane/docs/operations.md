---
type: Playbook
title: Operations
description: Deployment, runtime behavior, polling, failure handling, and local development notes.
tags: [operations, deployment, iam, polling]
timestamp: 2026-06-25T00:00:00Z
---

# Operations

## Deployment Shape

Run NeurOn separately from the LLM host capacity it controls. ECS/Fargate is a
good fit for the control plane itself. The app must not run on the EC2 capacity
that it scales down.

## Networking

NeurOn is designed for internal/Tailscale-style access. v1 authentication is
shared password via Basic Auth and optional signed HTTP-only login cookie.

## Persistence

Reservation storage is configurable:

- `STORAGE_DRIVER=memory` keeps all reservations in process memory
- `STORAGE_DRIVER=sqlite` stores reservations in `SQLITE_PATH`
- `STORAGE_DRIVER=postgres` stores reservations in `DATABASE_URL`

SQLite is the local Compose default and uses `/app/data/neuron.db`, mounted from
the repository `./data` directory. Durable reservations allow NeurOn to restart
without forgetting active demand, so the reconciler continues to desire matching
targets on after the process comes back.

Target startup estimates, runtime model IDs discovered from healthy targets,
and target status remain in memory. They are observational state and are rebuilt
by reconciliation; they are not used for scheduling decisions.

## Polling Defaults

Production defaults are intentionally moderate:

- Reconciler: 60 seconds
- Reservation status page: 10 seconds
- Main/admin status: 30 seconds
- LiteLLM request logs: 60 seconds when LiteLLM API config is present

Set `LITELLM_TRAFFIC_POLL_SECONDS=0` to disable request-log polling.

## Shutdown Guard

Before shutting down a target that was previously desired on, the reconciler
performs one immediate LiteLLM traffic poll. If that poll creates or refreshes a
synthetic traffic reservation, the target remains desired on.

## Startup Estimates

Startup estimates are based on recent observed transitions from provisioning to
healthy. They are shown for operator context only and are not used for capacity
decisions.

## Health Checks

Health checks are target-level. They should answer the user-facing question:
"can this runtime serve traffic yet?" They should not model every internal
startup phase.

## Failure Behavior

If a provider operation fails:

- target status becomes `failed`
- relevant active reservations become `failed`
- the app process keeps running

Traffic keepalive cannot resurrect a failed target by itself.

## Local Development

Local compose uses the Docker provider and mounts the host Docker socket so
NeurOn can install, start, and stop the configured PreFer container. Treat that
as trusted local-admin access to Docker. Set `USE_FAKE_PROVIDER=true` for
app-only development or tests. The Docker Compose provider remains available
for bring-your-own local runtime projects. Netskope/corporate CA builds are
supported through the compose overlay and `.netskope` Dockerfile.
