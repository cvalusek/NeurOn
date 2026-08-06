---
type: Reference
title: Providers
description: Capacity, Docker Compose, AWS EC2, AWS ECS/ASG, NeurOn, and LiteLLM provider behavior.
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
reprovisionTarget?(target)
ensureTargetOn(target)
ensureTargetOff(target)
getTargetStatus(target)
getTargetCostEstimate?(target)
discoverResources?(provider)
forceStopTarget(target)
```

Implementations must surface errors through status messages and exceptions that
the reconciler can catch. They should not crash the app process.

Provisioning is not part of normal lifecycle reconciliation. Providers only
create resources when an admin explicitly runs provisioning and the provider has
resource creation enabled. Start/stop/status operate known resources.

`reprovisionTarget` is an optional, narrower replacement contract. NeurOn calls
it only after `ensureTargetOn` throws `RecoverableTargetUnavailableError`, the
target explicitly enables `activationPolicy.reprovisionOnRecoverableUnavailable`,
the provider permits provisioning, and the replacement binding can be stored
durably. Generic provider errors never enter this path.

Credentials are not a separate first-class record yet. Until that exists,
providers should prefer environment-variable references such as `apiKeyEnv`
rather than storing secret material directly.

## AWS EC2

The AWS EC2 provider starts and stops a pre-created EC2 instance. It is the
simplest AWS lifecycle option when an operator wants to own instance creation,
AMI selection, security groups, EBS volumes, instance profile, and runtime
bootstrap outside NeurOn.

For a target desired on:

- Start the configured EC2 instance.

For a target desired off:

- Stop the configured EC2 instance.

The provider does not create instances, AMIs, launch templates, networking,
instance profiles, or volumes yet. Provisioning should be added as an explicit
admin action only, because AMI IDs vary by region and runtime projects own the
image and model-loading details.

In the Admin UI, create an `aws-ec2` provider with provisioning disabled. Its
instance Name-tag pattern defaults to `*.prefer.*`; set an explicit pattern to
narrow that convention, or `*` to intentionally search every named instance
visible to the task role. When creating a target, **Find EC2 instances** lists
matching pending, running, stopping, and stopped instances and fills the chosen
instance ID. This discovery is read-only and uses the same
`ec2:DescribeInstances` permission as status checks. The target can also be
supplied declaratively with the JSON or environment forms below.

While the instance is available, the provider derives runtime endpoints from
its current private IP address, falling back to its private DNS name. Defaults
are `http`, port `8080`, health path `/health`, and API path `/v1`. This means a
stop/start that changes the private IP is picked up on the next status read.
Target-level `healthUrl` and `apiUrl` remain explicit overrides and win over
the derived URLs. The runtime security group must allow NeurOn to reach the
configured port.

When a manual `costEstimate.hourlyUsd` is absent, NeurOn discovers the hourly
price at activation or reservation-estimate time. On-demand instances use the
AWS Price List `GetProducts` API; Spot instances use the latest matching EC2
Spot price for the instance's Availability Zone. Results are cached for one
hour. These are current list/Spot estimates, not invoice data, negotiated
discounts, Savings Plans, or Reserved Instance effective prices. A manual
hourly-cost override always wins.

### Target config

```json
{
  "id": "gpu-instance",
  "displayName": "GPU Instance",
  "provider": "aws-ec2",
  "modelIds": ["qwen"],
  "aws": {
    "instanceId": "i-1234567890abcdef0",
    "runtimePort": 8080,
    "runtimeProtocol": "http",
    "healthPath": "/health",
    "apiPath": "/v1"
  }
}
```

Provider discovery config:

```json
{
  "id": "aws-main",
  "displayName": "AWS Main",
  "type": "aws-ec2",
  "config": {
    "awsEc2": {
      "instanceNamePattern": "*.prefer.*"
    }
  }
}
```

### Minimal IAM for Pre-Created Instances

Use this policy shape when operators create and tag the instances themselves
and NeurOn only starts, stops, and reads status. Scope the resource ARN to the
specific instance IDs NeurOn may control.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StartStopKnownInstances",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances"
      ],
      "Resource": [
        "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0"
      ]
    },
    {
      "Sid": "ReadInstanceStatus",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeSpotPriceHistory"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadOnDemandPrices",
      "Effect": "Allow",
      "Action": "pricing:GetProducts",
      "Resource": "*"
    }
  ]
}
```

`ec2:DescribeInstances` does not support resource-level permissions for this
use case, so it remains `Resource: "*"`. Prefer a separate NeurOn IAM role per
environment/account and keep start/stop resources tightly scoped.
`ec2:DescribeSpotPriceHistory` is only needed for Spot targets.
`pricing:GetProducts` is only needed for automatic on-demand estimates; AWS
Price List requests use its `us-east-1` API endpoint while filtering products
for the workload region. Neither pricing action is required when all EC2
targets have manual hourly-cost overrides.

### Future IAM for Provisioning

When EC2 provisioning is implemented, the policy will need to cover instance
creation and cleanup in addition to lifecycle. Keep it separate from the
minimal start/stop role and constrain it with tags such as
`ManagedBy=NeurOn`, allowed AMI ARNs, subnet/security group ARNs, and the
specific instance profile NeurOn may pass.

Likely additional actions:

- `ec2:RunInstances`
- `ec2:CreateTags`
- `ec2:TerminateInstances`
- `ec2:DescribeImages`
- `ec2:DescribeInstanceTypes`
- `ec2:DescribeSubnets`
- `ec2:DescribeSecurityGroups`
- `ec2:DescribeVpcs`
- `iam:PassRole` for the runtime instance profile only

Provisioning config should require a region-appropriate AMI ID or SSM parameter
reference, instance type, subnet, security groups, IAM instance profile, storage
shape, and bootstrap/user-data owned by the runtime project.

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

The RunPod adapter does not yet implement `reprovisionTarget`. Replacement
semantics require confirmed production facts about which fields should be
copied, what happens to the unavailable Pod, and how cleanup is proven. The
provider-neutral boundary and fake-provider contract tests are complete; a
future RunPod adapter must return the new durable Pod binding and remain behind
both policy gates.

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
