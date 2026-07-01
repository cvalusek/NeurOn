---
type: Reference
title: PreFer
description: How NeurOn configures, provisions, and reserves PreFer runtimes.
tags: [prefer, docker, runtime-profiles, presets, plugins]
timestamp: 2026-06-30T00:00:00Z
---

# PreFer

PreFer is an external llama.cpp runtime project. NeurOn treats it as a
capacity target and does not own its model-download scripts, preset tuning, or
container internals. Keep PreFer-specific inference behavior in the PreFer
project; keep NeurOn focused on reservations, lifecycle control, discovery, and
operator-facing configuration.

The current built-in NeurOn runtime profile points at:

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

That profile supplies Docker image and volume defaults for targets created in
the admin UI. A target still owns its concrete container name, model metadata,
traffic prefixes, runtime URLs, and any PreFer environment overrides.

## Docker Target

Use the Docker provider when NeurOn should control a named PreFer container:

```json
[
  {
    "id": "prefer-local",
    "displayName": "PreFer Local",
    "provider": "docker",
    "trafficModelPrefixes": ["prefer/"],
    "docker": {
      "containerName": "prefer",
      "image": "ghcr.io/cvalusek/prefer:latest",
      "ports": ["8080:8080"],
      "volumes": ["prefer-model-cache:/models"]
    },
    "healthUrl": "http://host.docker.internal:8080/health",
    "apiUrl": "http://host.docker.internal:8080/v1"
  }
]
```

When the container already exists, NeurOn only needs the container name and
runtime URLs to start, stop, inspect, and discover models. Include `image`,
`ports`, `volumes`, and environment only when admins should be able to
provision the missing container from NeurOn.

Docker provisioning is explicit. The reconciler does not create missing PreFer
containers as part of ordinary reservation start.

## Presets

PreFer normally selects a preset itself from the runtime environment, such as
detected GPU VRAM. Most NeurOn targets should not set a preset at all; they
should let PreFer own that decision.

Named presets are still useful when an operator deliberately wants to pin a
specific runtime shape. PreFer selects named presets through environment
variables. Do not pass preset names as Docker command arguments from NeurOn
config.

For automated browser tests and very small local smoke tests, pin the tiny
`smol.ini` preset:

```json
{
  "docker": {
    "containerName": "prefer-smol",
    "image": "ghcr.io/cvalusek/prefer:latest",
    "ports": ["8080:8080"],
    "volumes": ["prefer-model-cache:/models"],
    "environment": {
      "LLAMA_ARG_MODELS_PRESET": "/presets/smol.ini"
    }
  }
}
```

The repository includes `examples/capacity-targets.prefer-smol.json` as a
browser-test fixture. It is useful for verifying NeurOn's UI and reservation
flow quickly without requiring real GPU sizing or encoding production model
policy into NeurOn.

`LLAMA_ARG_MODELS_MAX`, `PRESTAGE_MODELS`, `HF_TOKEN`, and other PreFer runtime
settings should also be passed as Docker environment when a target needs them.
Secret values should come from the deployment environment rather than being
stored directly in committed target examples.

## Models And Discovery

Model choices are owned by target configuration or runtime discovery:

- Use explicit `models` when operators want stable cards, aliases, and context
  labels in the NeurOn UI.
- Omit configured models when the target should discover models from PreFer's
  OpenAI-compatible `/v1/models` endpoint.
- Use `trafficModelPrefixes`, such as `prefer/`, when LiteLLM traffic logs use
  prefixed model names.

NeurOn should not infer a production model catalog by reading PreFer preset
files. Preset files and model-download logic belong to the PreFer project.

## Admin UI

The current admin UI can create a PreFer Docker target from the built-in runtime
profile. The form intentionally captures only generic fields:

- provider
- runtime profile
- runtime profile variant
- target ID and display name
- Docker container name
- model volume name
- runtime URL and model overrides

The built-in PreFer profile exposes these variants:

- `Standard`: does not set a preset, allowing PreFer to auto-select from the
  runtime environment.
- `DeepSeek V4 Flash`: sets
  `LLAMA_ARG_MODELS_PRESET=/presets/deepseek-v4-flash.ini`.
- `GLM 5.2`: sets `LLAMA_ARG_MODELS_PRESET=/presets/glm-5.2.ini`.
- `GLM 5.2 REAP`: sets
  `LLAMA_ARG_MODELS_PRESET=/presets/glm-5.2-reap.ini`.
- `Smol`: sets `LLAMA_ARG_MODELS_PRESET=/presets/smol.ini` for automated UI
  tests and tiny local smoke checks.

For other named presets or deeper runtime customization today, declare the
target JSON/env config with Docker environment values, or add the environment
to whatever provider integration owns the runtime.

## Variants And Customizations

Profile variants are flavors of a runtime profile. For PreFer, `standard` is
the normal flavor and named-preset variants pin specific runtime shapes. A
variant does not replace the base profile; it layers a small, explicit set of
runtime choices onto it.

Variants are only one part of the customization story. Real deployments also
need a way to express runtime and provider-specific knobs such as environment
variables, model cache settings, port choices, concurrency, secrets, and
provider creation options. The long-term design should separate:

- base runtime profile defaults
- selectable profile variants
- operator customizations for a specific target
- provider-specific provisioning details

Until the broader customization design exists, NeurOn should keep customizations
explicit in target configuration and keep variants limited to profile-owned
overrides.

## Plugin Direction

The preferred long-term shape is a PreFer-owned NeurOn plugin that is loaded by
default in deployments that want PreFer ergonomics. That plugin can contribute
PreFer-specific knowledge without making NeurOn core responsible for the
runtime catalog.

Expected plugin responsibilities:

- publish the default PreFer runtime profile
- publish additional profile variants
- expose preset choices through variant or customization controls
- map a selected preset to Docker or provider-specific environment variables
- provide model metadata, aliases, and context labels for known presets
- keep PreFer preset names and model policy versioned with the PreFer project

Until that plugin exists, NeurOn core should keep PreFer support generic:
runtime profiles, Docker environment, target model config, runtime discovery,
and explicit provisioning.
