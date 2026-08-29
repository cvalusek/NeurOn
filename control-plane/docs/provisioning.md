---
type: Reference
title: Provisioning
description: Explicit target creation from pinned runtime plans and provider-owned infrastructure.
tags: [provisioning, providers, targets, prefer, aws, runpod]
timestamp: 2026-08-29T00:00:00Z
---

# Provisioning

Provisioning creates one missing provider resource from explicit administrator
intent. It is separate from reconciliation: reservations start and stop a known
binding; they do not silently create a Pod, instance, container, network, or
other infrastructure.

Provider records include `provisioning.enabled`, which defaults to false. A
catalog-backed target is created in two stages:

1. **Create provisioning draft** persists the exact runtime plan and a durable
   draft job without contacting the provider.
2. **Provision target** is a separate admin action that invokes the provider,
   persists the returned resource binding, and records the created resource in
   the job.

Existing-capacity targets do not receive accidental provisioning jobs. A target
with an unresolved or incompatible catalog, disabled provider permission, or
missing provider-owned setup fails before resource creation.

## Pinned Runtime Plan

The runtime selection uses a full source commit and a schema-validated release
inventory. NeurOn resolves engine, provider-compatible hardware, configuration,
commit-tagged image, environment, port and paths, and models before creating the
draft. The resolved plan is durable and is retained when the target is edited;
an edit never silently upgrades it to another release. See [PreFer](prefer.md).

## RunPod

For RunPod, the resolved catalog supplies image, GPU type/count, environment,
runtime port, paths, and models. The target-creation screen adds only
provider-owned choices:

- Secure or Community Cloud;
- persistent model volume size;
- container disk size; and
- interruptible capacity.

The API key remains an environment-backed provider credential. The draft does
not contact RunPod. Explicit provisioning sends one create-Pod request and
persists the returned Pod ID. Editing a provisioned target retains that Pod ID
and the immutable runtime plan.

## AWS EC2 Launch Template

EC2 provisioning deliberately reuses infrastructure owned by the operator. The
provider must select exactly one Launch Template ID or name and may pin a
version; the default is `$Default`. The template owns AMI, subnet, security
groups, instance profile, storage, and the boot process. NeurOn does not create
or modify any of those resources.

The Launch Template user data must be text and contain exactly one ordered
managed block:

```text
# BEGIN NEURON MANAGED PREFER DEPLOYMENT
# values in this block are replaced by NeurOn
# END NEURON MANAGED PREFER DEPLOYMENT
```

Custom begin/end markers may be configured together on the provider. NeurOn
refuses missing, duplicate, reversed, binary, or ambiguous blocks. It preserves
every line outside the block and replaces only the block with a private atomic
write of `/opt/prefer/deployment.env`. The file contains the catalog environment
plus `AWS_REGION` and the exact `PREFER_IMAGE`. The Launch Template boot logic is
responsible for consuming that file; NeurOn does not insert restart or service
manager commands.

Provider-level deployment environment values are optional, nonsecret, one-line
defaults. Never store tokens, passwords, credentials, or private material there;
use the Launch Template's instance role or deployment secret mechanism. Catalog
values override provider defaults, while NeurOn owns the final `AWS_REGION` and
`PREFER_IMAGE` values.

NeurOn runs exactly one instance from the chosen template/version, overrides
only the catalog instance type and managed user data, applies the target display
name as the instance Name tag, and persists the one returned instance ID. It
refuses zero or multiple returned IDs.

Minimum additional control-plane permissions are:

- `ec2:DescribeLaunchTemplateVersions`
- `ec2:RunInstances`

The selected template may also require narrowly scoped `iam:PassRole` and
resource permissions. Lifecycle permissions remain `ec2:DescribeInstances`,
`ec2:StartInstances`, and `ec2:StopInstances`. Scope creation using the
operator's template, IAM, subnet/security-group, and tag policy; NeurOn does not
yet terminate or clean up an EC2 instance through the provisioning job.

## Other Providers

- Docker can explicitly create a named container when the target includes an
  image and the provider permits it.
- AWS ECS/ASG and Docker Compose continue to bind existing infrastructure.
- Upstream NeurOn holds reservations and does not provision upstream resources.

## Discovery After Provisioning

After successful creation, NeurOn records provider status and can run normal
runtime discovery. Discovery confirms the models actually advertised by the
activated target and stores the result. It does not rewrite the pinned runtime
plan, and it releases only capacity started by its own operation when no
reservation or traffic demand remains.

## Activate Or Reprovision

Replacement is a different, narrower policy. NeurOn may call
`reprovisionTarget` only when a typed recoverable availability failure occurs,
the target opts in, the provider allows creation, the adapter implements the
contract, and the new binding can be stored before activation retries. RunPod
and EC2 explicit provisioning do not imply automatic replacement. Generic
provider, authentication, rate-limit, or unknown errors never enter that path.
