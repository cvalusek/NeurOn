---
type: Reference
title: PreFer
description: How NeurOn connects and provisions PreFer llama.cpp and audio.cpp runtimes.
tags: [prefer, runtimes, provisioning, audio, plugins]
timestamp: 2026-08-29T00:00:00Z
---

# PreFer

PreFer is an external runtime project. NeurOn owns reservation intent,
lifecycle control, discovery, and operator configuration; PreFer owns images,
model artifacts, engine configuration, and runtime tuning. NeurOn must not copy
PreFer presets or download logic into this repository.

NeurOn ships two built-in runtime descriptors:

- **PreFer llama.cpp** for OpenAI-compatible text and vision models.
- **PreFer audio.cpp** for transcription, speech generation, voice authoring,
  music generation, and full-duplex PersonaPlex sessions.

The TypeScript schema still calls these `RuntimeProfile` records for backward
compatibility. The UI calls them **Runtime** because they are not user
reservation profiles. A future plugin can contribute the same generic
descriptor and catalog contract without changing target persistence.

## Connect Existing Or Provision New

**Connect existing** records a provider resource that already exists. The
operator supplies the resource identity and endpoint facts that cannot be
discovered. Runtime model discovery fills the current model catalog from the
activated host. No release inventory is required for this path.

**Provision new** is a separate, explicit admin workflow:

1. Choose a provisioning-enabled RunPod or AWS EC2 provider.
2. Choose the PreFer runtime engine.
3. Enter the full 40-character PreFer source commit.
4. Load the provider-compatible hardware or instance choices.
5. Choose one runtime configuration.
6. Create a persisted target and provisioning draft, then explicitly confirm
   provider creation.

NeurOn retrieves the catalog from the exact source commit:

```text
https://raw.githubusercontent.com/cvalusek/PreFer/<full-commit>/docker/llama-cpp/deployment-inventory.generated.json
https://raw.githubusercontent.com/cvalusek/PreFer/<full-commit>/docker/audio-cpp/deployment-inventory.generated.json
```

The accepted schemas are `prefer.deployment-inventory.v1` and
`prefer.audio-deployment-inventory.v1`. The catalog is cached for 24 hours by
runtime and full commit. `catalog_fingerprint` is stored as a compatibility and
cache identity; it is not treated as a whole-file checksum.

Before any provider call, NeurOn persists the resolved plugin ID, full source
commit, schema and fingerprint, deployment ID, provider type, image, runtime
port and paths, environment, hardware, and model list. Later catalog changes
cannot silently change that target.

The published image conventions are:

```text
ghcr.io/cvalusek/prefer:llama-cuda-sha-<7-character-commit>
ghcr.io/cvalusek/prefer:audio-cuda12-sha-<7-character-commit>
```

Moving `latest`, `llama-cuda`, and `audio-cuda12` tags are never used for a
catalog-backed provisioning draft. The full source commit remains stored beside
the derived release tag. NeurOn does not currently resolve the tag to an OCI
index digest; operators that require content-addressed image policy should
enforce or record that digest in their registry/deployment layer until the
catalog publishes it directly.

## Audio Catalog And Assistant

The audio catalog provides deployment hardware, server configuration,
environment, residency, capabilities, staged bytes, and exact model choices.
NeurOn maps advertised tasks to target-model technical flags:

- `asr` → speech to text
- `tts` → text to speech
- `s2s` → real-time speech
- `vdes` → voice design
- `gen` → audio generation

These flags describe endpoint capability. Intelligence and quantization quality
remain canonical model facts; measured performance remains specific to the
target/model deployment.

At **Admin > Assistant**, an operator can select independent existing
deployments for chat guidance, dictation, spoken replies, and live voice. The
configuration is stored in the singleton `assistant_config` record, never on a
target or model. Every operation creates or refreshes a visible per-role
synthetic reservation and waits through the ordinary reconciler.

Dictation records a short browser WAV and sends it to the selected
`/v1/audio/transcriptions` model. Spoken replies call `/v1/audio/speech`. A
reference voice is stored as a private standard-base64 RIFF/WAVE value with its
exact transcript; decoded size is capped at 5 MiB and admin read APIs redact the
bytes. Clean 24 kHz mono PCM16 WAV around 3–10 seconds is recommended.

Live voice uses a separate PersonaPlex panel. The browser sends 24 kHz mono
PCM16 to a bounded NeurOn WebSocket. NeurOn holds one upstream chunked POST,
parses SSE independently of HTTP chunks, forwards audio deltas as binary
WebSocket frames, and aborts upstream work when the browser closes. NeurOn does
not expose runtime endpoints or credentials to browser JavaScript.

The current built-in CustomVoice and PersonaPlex voice IDs are versioned in
NeurOn because the pinned runtime's `/v1/audio/voices` response does not yet
enumerate those packaged voices usefully. Update the lists only with a verified
PreFer/audio.cpp contract.

## Existing Docker Targets And Variants

For a container that already exists, NeurOn needs only its name and reachable
runtime URLs. Image, ports, volumes, and environment are present only when an
admin should be able to provision a missing local container explicitly.

The llama.cpp runtime retains named variants for deliberate compatibility and
small local tests. `standard` leaves runtime selection to PreFer;
`deepseek-v4-flash`, `glm-5.2`, `glm-5.2-reap`, and `smol` set the corresponding
`LLAMA_ARG_MODELS_PRESET`. These variants are not a production model catalog.
Production model choices come from target configuration, resolved provisioning
plans, or runtime discovery.

## Plugin Boundary

The runtime descriptor and release-catalog adapter are the plugin seam:

- the runtime/plugin contributes its identity, catalog URL shape, schema,
  engine, image repository, and provider-neutral deployment choices;
- the provider owns credentials and creation controls such as RunPod disk/cloud
  choices or an AWS Launch Template; and
- NeurOn persists the resolved target, performs explicit provisioning, then
  discovers the live runtime to confirm what is actually serving.

This keeps provider variation out of PreFer presets and keeps runtime-specific
model policy out of NeurOn core.
