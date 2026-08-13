---
type: Guide
title: Guided Model Selection
description: Private benchmark metadata, target-specific measurements, filtering, ranking, and optional AI profile guidance.
tags: [models, profiles, benchmarks, litellm, guidance]
timestamp: 2026-08-13T00:00:00Z
---

# Guided Model Selection

NeurOn recommends deployable **target-model pairs**, not abstract models. Cost,
context, runtime speed, and quantization quality can differ when the same base
model is served on different targets.

The selector never starts capacity to collect a score. It combines facts that
the operator supplies with privacy-safe observations from normal LiteLLM
traffic. An absent measurement remains unknown.

## User controls

The profile builder separates hard requirements from preferences.

Hard requirements are:

- minimum effective context window;
- maximum target hourly cost;
- a domain with a recorded capability score; and
- minimum measured quantization quality retention.

An unknown value does not satisfy a hard requirement. Quality, speed, and cost
preferences rank the remaining deployments. The triangle and its accessible
range controls stay synchronized. Ranking uses relative percentiles among the
eligible deployments, weights decode throughput at 70%, prefill throughput at
20%, and first-token latency at 10% within speed, and reports preference-data
coverage instead of silently
treating missing data as zero.

The quick wizard sets the same visible controls. Category cards show the best
fit, smartest, fastest, and cheapest eligible deployments. Applying one of
those cards only fills the profile form; the user must still save the profile
and later reserve capacity.

## Private catalog

Set one of:

```env
MODEL_SELECTION_CATALOG_FILE=/run/secrets/model-selection.local.private.json
# or
MODEL_SELECTION_CATALOG_JSON={"schemaVersion":1,"models":[],"deployments":[]}
```

Do not set both. The file is resolved from the control-plane working directory
when a relative path is used. A synthetic schema example is available at
`examples/model-selection-catalog.example.json`. The real local filename
`model-selection.local.private.json` is ignored by Git.

The catalog has two levels:

- `models` contains capability facts shared by every deployment of one
  canonical NeurOn model ID: overall intelligence, lowercase domain-score
  slugs, and provenance.
- `deployments` contains facts for one exact `targetId` + `modelId`: effective
  context, quantization, measured quality retention, performance, and
  provenance.

Scores are validated from 0 through 100. Context and positive performance
values are validated as finite positive numbers. Duplicate models and
deployments, unknown canonical model IDs, and target/model pairs that NeurOn
cannot actually select fail startup. Provenance supports source, source URL,
stable source model ID, retrieval time, version, and notes.

Keep licensed or deployment-private benchmark values outside the repository.
If a separate licensed assistant produces the file, review it before loading
and preserve the source identifier, methodology version, and retrieval date.
NeurOn's schema and importer do not grant redistribution rights for third-party
data.

## Context and quantization

Deployment context overrides the configuration/runtime fallback because it can
describe the exact serving limit. Without an override, NeurOn uses the
configured or runtime-discovered model context.

`qualityRetentionPercent` means a measured score for an exact artifact against
a named reference on a controlled harness. NeurOn does not estimate retention
from `Q4`, `FP8`, a filename, parameter count, or model family. When no such
measurement exists, show the quantization format and leave retention unknown.

## Passive LiteLLM observations

When ordinary LiteLLM traffic polling is enabled, NeurOn can derive:

- first-token latency from `completionStartTime - startTime`;
- approximate prefill throughput from `prompt_tokens / first-token latency`;
- decode throughput from `completion_tokens / (endTime - completionStartTime)`.

Cache hits, failed records, invalid timestamps, zero-token records, and
ambiguous routes that map to more than one target do not become performance
samples. Request IDs suppress repeat samples as the polling windows overlap.
After three samples, the selector uses rolling medians, keeping at most 200
samples per deployment for seven days. These observations are intentionally
in-memory and observational: after a restart, configured baselines remain and
normal traffic repopulates the local overlay.

No prompts, responses, user identities, API keys, or token contents are stored
by this feature.

## Optional AI advisor

Configure an OpenAI-compatible endpoint with:

```env
PROFILE_ADVISOR_API_BASE_URL=https://advisor.example.internal/v1
PROFILE_ADVISOR_API_KEY=replace-with-a-private-secret
PROFILE_ADVISOR_MODEL=profile-guide
PROFILE_ADVISOR_TIMEOUT_SECONDS=15
```

The advisor receives only the user's workload description and the configured
domain vocabulary. It converts natural language into validated context, cost,
domain, retention, response-length, and preference-weight fields. It never
receives target endpoints, benchmark values, provider credentials, or model
descriptions, and it never recommends or mutates a deployment directly.
NeurOn's deterministic selector computes the result.

Use an endpoint that is available before the user has a NeurOn profile. Pointing
the advisor at capacity that itself requires a new NeurOn reservation creates a
first-use dependency. When the advisor is not configured or unavailable, every
filter, recommendation, and wizard function remains local.

`GET /api/model-selection` exposes authenticated selection facts and advisor
availability. `POST /api/profile-advisor` accepts a workload description and
returns validated requirements. Neither endpoint mutates control-plane state.

## PreFer boundary

A PreFer release manifest is not required. PreFer may later publish exact
artifact, quantization, context, and benchmark measurements in this schema, but
NeurOn continues to own local cost, LiteLLM observations, filtering, ranking,
and user confirmation.
