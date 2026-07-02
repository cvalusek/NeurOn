---
type: Product Design
title: User Interface
description: Target-first interaction model and server-rendered UI conventions.
tags: [ui, product, server-rendered]
timestamp: 2026-06-25T00:00:00Z
---

# UI

The UI is server-rendered HTML with small browser JavaScript for polling and
copy interactions. Do not turn NeurOn into a heavy SPA unless the product shape
changes substantially.

## Main Page

Route:

```text
GET /
```

The main page contains:

- current user's active reservation
- target-first reservation form
- model groups under the selected target
- duration quick buttons plus custom duration
- keepalive quick buttons plus custom keepalive
- start-form estimated cost based on target hourly cost, duration, and keepalive
- per-target status cards
- reservations grouped under each target status card

The start form shows a projected cost before reservation creation when NeurOn
knows the selected target's hourly cost. Reservation cards split cost into
cost so far, which is allocated from activation records, and projected total,
which adds the remaining reservation window plus keepalive at the current
target hourly estimate.

## API Keys Page

Route:

```text
GET /api-keys
```

Users can generate personal API keys for plugin, REST, OpenAPI, and MCP
integrations. A generated key is displayed once with a copy button, then only
its name, prefix, creation time, and last-used time remain visible. Users can
revoke their own keys from the same page.

API keys are intentionally separate from model copy chips. Model chips copy
runtime/model identifiers; API keys authenticate clients.

## Target-First Model

The product is honest about the expensive unit: a shared runtime target.

Users choose:

1. Capacity target
2. Models they expect to use on that target
3. Duration
4. Traffic keepalive window

This avoids implying that model selection is a placement solver. A future
solver could invert this flow back to model-first if NeurOn owns enough data to
choose a target safely.

## Model Cards

Model cards show:

- display name
- context pill
- model trait pills such as parameter shape, instruction tuning, and quantization
- short description
- copy chips for the shortest alias, canonical ID, and other aliases

Aliases discovered from llama.cpp `/v1/models` are treated as authoritative.
The shortest supported alias is rendered first and emphasized. The card does
not label it as "recommended alias" because the chip order carries that meaning
without extra text. Trait pills are visual metadata only; they are not copyable
model aliases.

## Status Cards

Each target has its own status card showing:

- desired state
- observed state
- active users
- provider
- status message
- recent startup estimate, when available
- reservations for that target only

Reservations render compact model copy chips so users can quickly copy the
model ID or alias they should use.

## Activations Page

Route:

```text
GET /admin/activations
```

The activations page lists target activations recorded by the reconciler. Each
activation shows:

- target
- open or closed status
- activation window
- configured hourly estimate, when present
- total estimated activation cost
- reservation allocation rows with user, reservation status, model IDs, and
  estimated allocation cost

The page is admin-scoped because activation history is operational chargeback
data.

## Polling

Defaults are production-friendly:

- Reservation detail: 10 seconds
- Main/admin status: 30 seconds

Local development can override these to faster values through environment
variables or compose defaults.
