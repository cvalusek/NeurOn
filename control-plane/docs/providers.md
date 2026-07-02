---
type: Reference
title: Providers
description: Capacity, Docker Compose, AWS ECS/ASG, NeurOn, and LiteLLM provider behavior.
tags: [providers, aws, docker, neuron, litellm]
timestamp: 2026-06-25T00:00:00Z
---

# Providers

Providers translate target desired state into concrete runtime operations.
Provider-specific names should stay inside provider config and adapters.
Targets reference providers by `providerId`; `provider` remains the provider
type used to choose the lifecycle adapter. This lets one configured provider,
such as a RunPod account or local Docker daemon, own multiple targets.
Explicit provider records are optional. A target with `provider: docker` still
runs through the Docker adapter even when no provider row exists.

A provider record can come from declarative config or persisted storage:

```ts
interface CapacityProviderDefinition {
  id: string;
  displayName: string;
  type: string;
  provisioning?: { enabled?: boolean };
  config?: Record<string, unknown>;
  credentialId?: string;
}
```

Provider config should hold shared endpoint or credential-reference data. Target
config should hold resource-specific data such as a RunPod Pod ID, Docker
container name, or ECS service names.

## CapacityProvider

The capacity provider interface is:

```ts
provisionTarget(target)
ensureTargetOn(target)
ensureTargetOff(target)
getTargetStatus(target)
forceStopTarget(target)
```

Implementations must surface errors through status messages and exceptions that
the reconciler can catch. They should not crash the app process.

Provisioning is not part of normal lifecycle reconciliation. Providers only
create resources when an admin explicitly runs provisioning and the provider has
resource creation enabled. Start/stop/status operate known resources.

Credentials are not a separate first-class record yet. Until that exists,
providers should prefer environment-variable references such as `apiKeyEnv`
rather than storing secret material directly.

## AWS ECS/ASG

The AWS provider is the production v1 provider. For a target desired on:

- Set Auto Scaling Group desired capacity to `1`.
- Set ECS service desired count to `1`.

For a target desired off:

- Set ECS service desired count to `0`.
- Set Auto Scaling Group desired capacity to `0`.

The provider does not create ECS services, ASGs, launch templates, AMIs, or
clusters. Those resources must already exist.

### Identifiers

ECS config:

- `cluster`: name or ARN
- `service`: name or ARN

ASG config:

- `autoScalingGroupName`: ASG name only

Auto Scaling APIs require `AutoScalingGroupName`; ARNs are not accepted for the
calls NeurOn uses.

### IAM

The task role needs, at a high level:

- `autoscaling:SetDesiredCapacity`
- `autoscaling:DescribeAutoScalingGroups`
- `ecs:UpdateService`
- `ecs:DescribeServices`

## RunPod

The RunPod provider uses the RunPod REST API. It can start and stop an existing
Pod by ID, read Pod status, and provision a Pod from a configured create
request body when resource creation is enabled on the provider.
Health checks are optional for RunPod targets. NeurOn can use RunPod Pod status
as the capacity signal. Discovery uses `apiUrl` when configured, or
infers RunPod's proxy URL from Pod ID and runtime port.
When target cost is not configured explicitly, NeurOn reads the Pod detail
response at activation start and uses RunPod's adjusted hourly Pod cost when
available, falling back to the base hourly Pod cost.

Provision:

```bash
POST /v1/pods
```

On:

```bash
POST /v1/pods/{podId}/start
```

Off:

```bash
POST /v1/pods/{podId}/stop
```

Status:

```bash
GET /v1/pods/{podId}
```

Cost estimation uses the same Pod detail endpoint. The RunPod API exposes
`adjustedCostPerHr` for the effective hourly cost after Savings Plans and
`costPerHr` for the base hourly cost.

## NeurOn

The NeurOn provider delegates capacity to another NeurOn instance. It is used
when this control plane should expose targets from an upstream control plane
while keeping local reservations and API keys local.

Provider-level config holds the upstream API endpoint and credential:

```json
{
  "id": "upstream",
  "displayName": "Upstream NeurOn",
  "type": "neuron",
  "config": {
    "neuron": {
      "apiBaseUrl": "https://neuron-upstream.example.com",
      "apiKeyEnv": "UPSTREAM_NEURON_API_KEY",
      "syncTargets": true,
      "reservationMinutes": 5
    }
  }
}
```

When `syncTargets` is true, startup reads upstream `/api/status` and
`/api/models`, then materializes local targets whose IDs are prefixed with the
provider ID by default, for example `upstream-gpu-pool`. Each synced target
stores the upstream target ID in `neuron.targetId`.

For lifecycle, `ensureTargetOn` creates an upstream reservation for the
upstream target and later extends that same reservation from now. `ensureTargetOff`
ends the upstream reservation. The upstream reservation ID remains private to
the provider adapter; local reservation ownership and MCP `end_reservation`
scoping are unchanged.

Status reads upstream `/api/status` and mirrors the upstream target's observed
state and message. Provisioning is not supported because NeurOn provider
targets are discovered from the upstream instance.

## Docker Container

The Docker provider controls a named container. It is the preferred local
provider when the runtime project owns the container setup and NeurOn only needs
to start, stop, inspect, and discover models from that container.
When NeurOn runs inside Docker, this provider needs access to the host Docker
daemon, typically by mounting `/var/run/docker.sock`.

Provision:

```bash
docker pull <image>
docker create ... --name <container> <image>
```

On:

```bash
docker start <container>
```

Off:

```bash
docker stop <container>
```

If a reservation starts a missing container, the provider reports an error.
Provisioning a missing container requires `docker.image` and an explicit admin
provision action.
The admin Discover action uses the same lifecycle to start a target briefly,
read `/v1/models`, record discovered models, and stop it again.

## Docker Compose

The Docker Compose provider exists for local development. It shells out to
`docker compose` with configured project and compose file arguments.

On:

```bash
docker compose ... up -d --no-build <service>
```

Off:

```bash
docker compose ... stop <service>
```

It intentionally does not build images or manage model downloads directly.

## LiteLLM

LiteLLM integration has two separate roles:

- `BackendConfigSync`: sync backend config when a target becomes healthy.
- `TrafficSource`: poll LiteLLM request logs for recent usage.

`BackendConfigSync` is not a capacity provider and not a generic notification
bus. It represents an outbound configuration sync interface for the proxy layer.
The current LiteLLM adapter is deliberately isolated because the exact admin API
shape may need adjustment across LiteLLM versions. Do not spread LiteLLM API
assumptions through the app.

## No-Op/Fake Providers

- No-op LiteLLM is used for local development when no LiteLLM API config exists.
- Fake capacity provider is used by tests and can be enabled for pure app
  development with `USE_FAKE_PROVIDER=true`.
