---
type: Reference
title: Provisioning
description: Explicit resource creation, provider gates, and provisioning jobs.
tags: [provisioning, providers, targets]
timestamp: 2026-06-29T00:00:00Z
---

# Provisioning

Provisioning means creating a missing provider resource from explicit admin
intent. It is separate from lifecycle reconciliation.

The reconciler starts and stops known resources. It does not create containers,
Pods, EC2 instances, services, or other infrastructure as a side effect of a
reservation, except through the explicit activate-or-reprovision policy below.

Provider records include `provisioning.enabled`. The default is disabled. An
admin must enable resource creation on a provider before `provisionTarget` can
run.

Provider-scoped target creation records a persisted target provisioning job.
Jobs store the provider, provider type, runtime profile, target draft, status,
and created resources reported by the provider. This gives the control plane a
place to resume, inspect, or abort multi-step flows as provider adapters grow.

After a target is provisioned, NeurOn records the provider-observed status. If
the target has discovery enabled and no configured models, NeurOn starts a
background bootstrap discovery pass. That pass starts the target, waits for
health, reads `/v1/models`, records discovered models, and stops the target.

Provisioning should remain provider-specific:

- Docker can create a named container from an image.
- RunPod can create a Pod from a create request body.
- AWS ECS/ASG currently assumes resources already exist.
- Future EC2 provisioning can create or start instances from a PreFer AMI.

## Activate Or Reprovision

The provider-neutral activation boundary can replace an unavailable binding,
but only when every gate is true:

1. activation threw the typed `RecoverableTargetUnavailableError`;
2. the target sets `activationPolicy.reprovisionOnRecoverableUnavailable=true`;
3. the provider record sets `provisioning.enabled=true`;
4. the adapter implements `reprovisionTarget`; and
5. NeurOn can durably persist the returned target binding before retrying
   activation.

Config-only targets must first be copied to persisted storage. This preflight
happens before the adapter may create a replacement, avoiding an orphan whose
new identity would disappear on restart. Generic errors, authentication
failures, rate limits, and unknown exceptions are never treated as recoverable
availability conditions.

The boundary is covered entirely with fake/mock providers. RunPod replacement
is intentionally deferred until its live resource/cleanup contract is known;
the existing adapter continues to start, stop, inspect, and explicitly create
Pods without guessing at replacement behavior.
