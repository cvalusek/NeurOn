---
type: Guide
title: Guided Model Selection
description: Durable model facts, target-specific measurements, filtering, ranking, and optional AI profile guidance.
tags: [models, profiles, benchmarks, litellm, guidance]
timestamp: 2026-08-13T00:00:00Z
---

# Guided Model Selection

NeurOn recommends deployable **target-model pairs**, not abstract models. Cost,
context, runtime speed, hosting shape, aliases, and quantization quality can
differ when the same base model is served on different targets. An absent
measurement remains unknown.

## User controls

The profile builder separates hard requirements from preferences.

Hard requirements are:

- minimum effective context window;
- maximum target hourly cost;
- dedicated or multi-model hosting; and
- every selected capability/domain tag.

An unknown value does not satisfy a corresponding hard requirement. Estimated
quality retained is intentionally display-only: it is useful context, but the
measurement methods are not consistent enough to make it a safe eligibility
gate.

The **Good / Fast / Cheap** triangle ranks the deployments that pass the hard
requirements. The three internal weights each run from 0 through 100, so the
center means equal 100% preference rather than a rounded one-third split. The
triangle snaps at the center, category corners, and balanced edge positions.
It lists the current leader for each category underneath the control. Ranking
uses relative percentiles among eligible deployments. Speed weights measured
decode throughput at 75% and prefill throughput at 25%; first-token latency is
shown as a diagnostic and has no ranking weight. Missing preference data
reduces the displayed data-coverage value instead of becoming an invented zero.

The quick wizard sets requirements and internal ranking preferences. Applying
a recommendation only fills the profile form; the user must still save the
profile and later reserve capacity. Users may favorite exact target-model
deployments. Cards also show profile use, recent reservation use, and the
current quality/speed/cost facts that produced their order.

## Durable operator data

Capability and deployment measurements are application data. Admins edit them
at **Admin > Model data** or through the authenticated admin APIs; they are not
environment variables and are not reloaded from a release manifest.

```text
PUT /api/admin/model-metadata/models/:modelId
PUT /api/admin/model-metadata/deployments/:targetId/:modelId
PUT /api/admin/targets/:targetId/models/:modelId/aliases
```

The durable data has two levels:

- `models` contains capability facts shared by every deployment of one
  canonical NeurOn model ID: overall intelligence, lowercase domain-score
  slugs, and provenance.
- `deployments` contains facts for one exact `targetId` + `modelId`: effective
  context, quantization, measured quality retention, performance, and
  provenance. LiteLLM aliases are stored on the target's model definition.

Scores are validated from 0 through 100. Context and positive performance
values are validated as finite positive numbers. Unknown canonical model IDs
and target/model pairs that NeurOn cannot actually select fail closed.
Provenance supports source, source URL, stable source model ID, retrieval time,
version, and notes.

Do not commit licensed benchmark values or deployment-private measurements.
An authorized assistant can speed up manual data entry, but an operator must
review the values and record the source identifier, methodology version, and
retrieval date. NeurOn's schema and UI do not grant redistribution rights for
third-party data.

## Context and quantization

Deployment context overrides the configuration/runtime fallback because it can
describe the exact serving limit. Without an override, NeurOn uses the
configured or runtime-discovered model context. When the runtime reports one
shared context plus concurrency, NeurOn uses the explicit per-sequence value or
divides the shared context by the concurrent sequence count. Training context
is not treated as serving context.

`qualityRetentionPercent` means a measured score for an exact artifact against
a named reference on a controlled harness. NeurOn does not estimate retention
from `Q4`, `FP8`, a filename, parameter count, or model family. When no such
measurement exists, show the quantization format and leave retention unknown.

## Direct speed benchmark

**Discover models now** and **Rediscover all** can run the small
`neuron-speed-v1` benchmark after the target is activated and discovery has
identified the runtime model IDs. The suite runs targets sequentially for the
bulk operation. For every model it:

- sends one discarded warm-up request;
- sends three measured requests with unique markers and prompt caching disabled;
- records median prefill and decode throughput; and
- persists the result and suite provenance on the exact target-model record.

The prompts are NeurOn-owned synthetic benchmark inputs. Responses are not
stored. The benchmark calls the already-activated target directly and is never
a startup side effect. Operators should still run it during an appropriate
capacity window because it generates inference work. A failure leaves the
previous durable measurement intact and is reported to the operator.

Ordinary LiteLLM traffic may still contribute a short-lived observational
overlay when it supplies unambiguous token/timing data. Cache hits, failed or
duplicate records, invalid timestamps, zero-token records, and routes that map
to more than one target are excluded. The durable direct benchmark remains the
repeatable baseline after restart.

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
domain, hosting-shape, response-length, and preference-weight fields. It never
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
NeurOn continues to own durable model data, local cost, direct measurements,
filtering, ranking, and user confirmation.
