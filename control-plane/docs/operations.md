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

v1 uses in-memory repositories:

- reservations reset on restart
- target startup estimates reset on restart
- runtime model IDs discovered from healthy targets reset on restart

This is acceptable for v1 because provider state is still observed during
reconciliation. A durable repository can replace the in-memory implementation
behind `ReservationRepository` and `TargetStatusRepository` later.

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
