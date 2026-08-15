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
- every selected binary technical capability, such as vision or tool use.

Scored strengths such as coding, math, and reasoning are preferences. Selecting
several of them refines the Intelligence dimension; a missing strength score
reduces data coverage rather than removing the deployment.

An unknown value does not satisfy a corresponding hard requirement. Estimated
quality retained is intentionally display-only: it is useful context, but the
measurement methods are not consistent enough to make it a safe eligibility
gate.

The **Good / Fast / Cheap** triangle is the profile wizard. It controls the
internal Intelligence / Speed / Cost weights and snaps at the center, category
corners, and balanced edge positions. Everywhere outside the triangle uses the
formal Intelligence, Speed, and Cost names. The current leader for each formal
category appears beside the triangle.

Intelligence uses the model's 0–100 score, refined by selected scored strengths.
Speed compares the deployment against the fastest eligible measurements and
weights decode throughput at 80% and prefill throughput at 20%; first-token
latency is diagnostic only. Cost compares the deployment with the least
expensive eligible target. Missing preference data reduces data coverage rather
than becoming an invented zero. Every card shows its live fit score and data
coverage, and both model cards and target cards reorder as the triangle moves.
Applying a recommendation only fills the profile form; the user must still save
the profile and later reserve capacity.

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

- `models` contains artifact facts shared by every deployment of one canonical
  NeurOn model ID: overall intelligence, lowercase scored-strength slugs,
  quantization format, measured quality retention, and provenance.
- `deployments` contains measured performance for one exact `targetId` +
  `modelId`, with provenance. Serving context and LiteLLM aliases remain on the
  target's model definition or its runtime-discovery snapshot.

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

NeurOn uses configured or runtime-discovered serving context. When the runtime
reports one shared context plus concurrency, NeurOn uses the explicit
per-sequence value or divides the shared context by the concurrent sequence
count. Training context is not treated as serving context, and Model data does
not duplicate a separate context override.

`qualityRetentionPercent` means a measured score for the canonical artifact
against a named reference on a controlled harness. NeurOn does not estimate
retention from `Q4`, `FP8`, a filename, parameter count, or model family. When
no such measurement exists, show the quantization format and leave retention
unknown.

## Direct speed benchmark

**Discover models now** and **Rediscover all** can run the 50K-class
`neuron-speed-v2-50k` benchmark after the target is activated and discovery has
identified the runtime model IDs. The suite runs targets sequentially for the
bulk operation. For every model it:

- sends one discarded 50K-class warm-up request;
- sends three measured 50K-class requests with leading unique markers and
  prompt caching disabled;
- rejects a run if the runtime reports that it processed fewer than 40K prompt
  tokens;
- records median prefill and decode throughput; and
- persists the result and suite provenance on the exact target-model record.

The benchmark calls the already-activated target directly and is never a
startup side effect or a target-configuration operation. Only aggregate timing
measurements are stored. Operators should run it during an appropriate capacity
window because it generates inference work. A failure leaves the previous
durable measurement intact and is reported to the operator.

Ordinary LiteLLM traffic may still contribute a short-lived observational
overlay when it supplies unambiguous token/timing data. Cache hits, failed or
duplicate records, invalid timestamps, zero-token records, and routes that map
to more than one target are excluded. The durable direct benchmark remains the
repeatable baseline after restart.

## NeurOn-backed profile assistant

An administrator selects one existing target/model deployment at **Admin >
Assistant**. The selection is stored in a singleton `assistant_config` record,
independent of target definitions and Model data; it is not an
environment-configured external endpoint. Asking for help creates or
refreshes a synthetic `profile-advisor` reservation, waits for the ordinary
reconciler and health checks, and calls that target's OpenAI-compatible API.
This means the first request may cold-start the configured target. The admin
setting controls reservation duration, keep-alive, and response timeout. The
reservation duration is also the maximum cold-start wait. The selected runtime
must expose OpenAI-compatible chat completions;
function/tool-call support is required for screen updates and action proposals.

![The independent Assistant configuration screen](images/assistant-config.png)

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
unconfigured or unavailable, every local requirement, triangle, ranking, and
recommendation remains usable.

`GET /api/profile-advisor/status` reports availability. `POST
/api/profile-advisor` accepts the workload plus structured screen context and
returns a validated tool proposal. Assistant tool calls do not bypass normal
authorization, maintenance mode, validation, or user confirmation.

## PreFer boundary

A PreFer release manifest is not required. PreFer may later publish exact
artifact, quantization, context, and benchmark measurements in this schema, but
NeurOn continues to own durable model data, local cost, direct measurements,
filtering, ranking, and user confirmation.
