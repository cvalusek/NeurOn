---
type: Reference
title: Targets
description: Capacity target config, provider relationships, and runtime profiles.
tags: [targets, runtime-profiles, configuration]
timestamp: 2026-06-29T00:00:00Z
---

# Targets

A target is the reservable runtime capacity unit. It answers: which runtime can
serve which models, and what resource-specific config is needed to operate it?

Targets can be declared in JSON/env config or stored in the persistence layer.
Declarative targets are read-only in the admin UI. Persisted targets can be
created and deleted from `/admin/targets`.

Important fields:

- `id`
- `displayName`
- `provider`: provider type, such as `docker`, `runpod`, or `aws-ecs-asg`
- `providerId`: configured provider instance; defaults to `provider`
- `modelIds` and optional detailed `models`
- provider-specific resource config, such as `docker`, `runpod`, `aws`, or `neuron`
- `healthUrl` and `apiUrl` overrides
- optional `modelDiscovery`

Provider relationships are direct: a target should reference the provider
instance that owns it. Shared account/endpoint details belong on the provider;
resource identifiers belong on the target.

## Runtime Profiles

Runtime profiles describe provisionable runtime defaults without provider
specific payloads. The built-in PreFer profile is:

```json
{
  "id": "prefer",
  "name": "PreFer",
  "type": "docker",
  "image": "ghcr.io/cvalusek/prefer:latest",
  "volumes": {
    "/models": "prefer-model-cache"
  }
}
```

For Docker-style profiles, `port`, `health`, `api`, and `discovery` have
defaults: `8080`, `/health`, `/v1`, and `true`. The `volumes` map is keyed by
runtime container path, with the backing volume name as the value. Provider
adapters translate that portable shape into provider-specific mount syntax.
Docker provisioning currently creates containers with all GPUs available by
default.

The target creation UI keeps the common PreFer case small: choose the runtime
profile and enter a model volume name. The selected profile supplies the
container path.
