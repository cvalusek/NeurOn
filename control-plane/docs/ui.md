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

## Navigation

The top bar is reserved for global chrome: menu, brand, signed-in user, and
future page-provided actions. Primary navigation lives in the side tree.
Workspace links include Home, Profiles, and API keys. Admin is reserved for
user and authentication management. Configuration paths such as Providers and
Targets live in a separate branch. Historical operational records such as
Reservations and Activations live in History.

The side navigation is a collapsible tree. On desktop-sized screens it opens by
default as a left sidebar and can still be collapsed from the menu control. On
narrow screens it behaves as an overlay drawer and becomes the primary way to
reach anything beyond the quick links. Keep the tree server-rendered with a
small toggle script.

## Main Page

Route:

```text
GET /
```

The main page contains:

- current user's active reservation
- reservation profile cards with target and primary model aliases
- modal-based profile creation for target and model choices
- duration quick buttons plus custom duration
- keepalive quick buttons plus custom keepalive
- start-form estimated cost based on target hourly cost, duration, and keepalive
- per-target status cards
- aggregate per-target reservation/user/model counts
- the current user's reservations expanded under each target status card
- other users' reservations collapsed under each target status card

The start form shows a projected cost before reservation creation when NeurOn
knows the selected target's hourly cost. Reservation cards split cost into
cost so far, which is allocated from activation records, and projected total,
which adds the remaining reservation window plus keepalive at the current
target hourly estimate.

Reservation profiles are user-owned saved launch shapes. The home page treats
profiles as the main reservation path: users pick from a compact profile
selector, adjust duration/keepalive if needed, and reserve. Target and model
choices live in the new-profile modal so the main page can remain compact.
Starting capacity from a profile still creates an ordinary reservation, and
reservation cards show the profile name with a review modal when a reservation
came from one. The profile data model stores selections as a list so future UI
work can allow one profile to span multiple targets.

## Profiles Page

Route:

```text
GET /profiles
```

The profiles page lists the current user's reservation profiles with target
summaries, primary model aliases, default duration/keepalive, and delete
actions. Users can create profiles directly from this page with the same
target/model chooser used by the home page.

## Reservation History

Route:

```text
GET /admin/reservations
```

The reservation history page lists all reservations for administrative review.
It is sorted by expiration descending by default and paginates through the
admin reservations API so long-running installations do not render the entire
history at once.

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

The Admin Targets status also shows whether a persisted runtime discovery cache
exists and when it was recorded. Target create and persisted-target edit forms
expose comma-separated LiteLLM model route prefixes; for example,
`clint-desktop/` links `clint-desktop/gemma-4-e2b` model names and traffic to
that target. Declarative targets remain configuration-owned and must be copied
to the database before Admin can edit them. **Discover models now** explicitly
refreshes the cache and may activate a stopped target.

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
