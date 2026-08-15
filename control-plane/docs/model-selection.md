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

## NeurOn-backed profile assistant

An administrator selects one existing target/model deployment at **Admin >
Model data**. The selection is stored on the durable target definition; it is
not an environment-configured external endpoint. Asking for help creates or
refreshes a synthetic `profile-advisor` reservation, waits for the ordinary
reconciler and health checks, and calls that target's OpenAI-compatible API.
This means the first request may cold-start the configured target. The admin
setting controls reservation/keep-alive length, startup timeout, and response
timeout. The selected runtime must expose OpenAI-compatible chat completions;
function/tool-call support is required for screen updates and action proposals.

The assistant receives a sanitized deployment catalog (IDs, display names,
aliases, selection measurements, context, and cost), saved-profile IDs/names,
and the user's active reservation summary. It also receives an application-
constructed current-screen snapshot: a named surface such as Home, Profile
create/edit, Client setup, or an admin area; the route and title; and only the
relevant typed controls such as the current profile draft, requirement filters,
ranking shares, selected Home profile/timing, or Client setup profile. This lets
it answer “what am I looking at?” and update the right controls without sending
HTML or scraping visible text. It never receives target endpoints, provider or
model credentials, raw DOM contents, prompt logs, hidden fields outside the
explicit snapshot, unrelated private state, or another user's reservations.
Requests and model responses are not persisted by NeurOn.

The system prompt explains the target/model/profile/reservation relationships,
reconciler ownership of provider lifecycle, health and model preparation,
duration, keep-alive and synthetic traffic demand, hard requirements, ranking
preferences, alias routing, screen-context trust boundaries, and confirmation
rules. The model must use an allowlisted tool:

- `configure_profile` fills reversible browser controls and exact target/model
  selections.
- `save_profile` creates a confirmation card. Only the user's confirmation
  invokes the normal profile service.
- `start_reservation` is separate and requires another confirmation before it
  creates demand.
- Admins additionally receive safe navigation and confirmed target rediscovery
  tools. Destructive target/provider/update controls are not exposed.

The assistant drawer is available throughout authenticated pages and collapses
to a small launcher. A draft created outside the profile builder is held in
session storage and applied when the user opens the builder. If the backend is
unconfigured or unavailable, every local filter, recommendation, and wizard
function remains usable.

`GET /api/profile-advisor/status` reports availability. `POST
/api/profile-advisor` accepts the workload plus structured screen context and
returns a validated tool proposal. Assistant tool calls do not bypass normal
authorization, maintenance mode, validation, or user confirmation.

## PreFer boundary

A PreFer release manifest is not required. PreFer may later publish exact
artifact, quantization, context, and benchmark measurements in this schema, but
NeurOn continues to own durable model data, local cost, direct measurements,
filtering, ranking, and user confirmation.
