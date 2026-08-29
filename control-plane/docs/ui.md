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

- every active reservation owned by the current user, each with independent
  extend and end controls
- reservation profile cards with target and primary model aliases
- links to dedicated profile creation/editing pages for one or more
  target-specific model choices
- duration quick buttons plus custom duration
- keepalive quick buttons plus custom keepalive
- start-form estimated cost based on target hourly cost, duration, and keepalive
- per-target status cards
- aggregate per-target reservation/user/model counts
- the current user's reservations expanded under each target status card
- other users' reservations collapsed under each target status card

Server status cards place the current user's reserved targets first, then other
targets whose desired state is on, then the remaining targets. Most recently
used targets sort first inside each group. Expanded reservation details retain
their state across status polling.

The start form shows a projected cost before reservation creation when NeurOn
knows the selected target's hourly cost. Reservation cards split cost into
cost so far, which is allocated from activation records, and projected total,
which adds the remaining reservation window plus keepalive at the current
target hourly estimate.

Active reservation countdowns update locally once per second and display total
minutes plus seconds. Server status polling remains independently configurable,
so the live countdown does not increase API traffic.

Reservation profiles are user-owned saved launch shapes. The home page treats
profiles as the main reservation path: users pick from a compact profile
selector, adjust duration/keepalive if needed, and reserve. Target and model
choices live on dedicated create/edit pages so the main page can remain compact
and the selector has enough room. The builder shows target hourly cost,
effective per-request context, durable capability metadata, target-specific
performance, estimated quantization retention, favorites, usage, and LiteLLM
aliases. The default Browse & filter view searches names, IDs, aliases, and
capabilities and offers ordinary sort choices. Hard filters remove deployments
with missing or insufficient facts. Hosting mode is an explicit target fact;
the selector reports counts for dedicated, multi-model, and unclassified
targets and never guesses from catalog size or concurrency. The
separately-invoked Good/Fast/Cheap
triangle is the optional profile wizard. Its visible snap points rank the
remainder, show Intelligence/Speed/Cost leaders, update each card's fit score,
and reorder both models and targets. Binary technical capabilities are hard
filters; scored strengths refine Intelligence without filtering. Applying
guidance only fills controls; saving remains explicit.
Selecting a profile immediately updates the visible duration and keepalive
buttons to its stored defaults. Single-model targets select their only model
automatically; multi-model targets require an explicit model choice.
Starting capacity from a profile still creates an ordinary reservation, and
reservation cards show the profile name with a review modal when a reservation
came from one. A profile can span multiple targets, and its reservation stores a
target-specific selection snapshot so each target warms only its own models.

The collapsible NeurOn assistant is available throughout authenticated pages.
It receives structured page identity and profile state—not raw DOM contents—and
can fill filters, defaults, and exact target/model choices. Drafts created away
from the builder carry into it through session storage. The per-user chat and a
pending confirmation also survive full-page navigation until **Clear** is used.
Bounded prior turns are sent with each request and compacted as the conversation
grows. A stable operating-prompt/catalog prefix is followed by an initial
structured page snapshot and then only changed screen-state deltas. Admins can
toggle a privacy-safe diagnostic view of timing, retry, context-delta, and
conversation-size metadata without exposing prompts or model content.
Enter sends; Shift+Enter adds a line break. Sleeping/waking and warm-model
thinking appear as spinner bubbles in the conversation. Guided navigation
points to and pulses the ordinary link before following it, while form actions
highlight the controls they change. Save-profile and start-reservation are
separate tool proposals with separate UI confirmations; admin rediscovery
proposals are confirmed as well. The builder remains complete without an
assistant backend or PreFer release inventory.

When Assistant audio is configured, **Mic** beside Send records dictation and
inserts the transcript for review, **Listen** appears on every chat message,
and **Live voice** opens a separate PersonaPlex conversation panel. The live
panel shows waking, listening, speaking, finishing, error, and timing states and
can be cancelled independently of the text conversation. Audio controls remain
hidden when their deployment is not configured.

The reserve action is held in a bottom action bar alongside the current cost
estimate so it remains visually connected to the form after profile review.
Duration, keepalive, and profile labels expose concise help text on hover and
keyboard focus.

## First-Login Guide

Routes:

```text
GET /welcome
GET /help
```

Home redirects a signed-in user with no profiles to `/welcome`. The page
explains the cost-control loop, profile intent, duration, keepalive, and traffic
reservation, then opens `/profiles/new?onboarding=1`. After the first profile is
saved, the user returns to Home. `/help` exposes the same explanation
at any time from **Guide** in the navigation. Home does not redirect a user who
has an active reservation created through an API or plugin even if they have no
profile, so that reservation remains manageable.

## Profiles Page

Route:

```text
GET /profiles
GET /profiles/new
GET /profiles/:id/edit
```

The profiles page lists the current user's reservation profiles with target
summaries, primary model aliases, default duration/keepalive, and delete
actions. Create and edit actions open the dedicated target/model builder.

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
- copy chips that emphasize the target-scoped LiteLLM route and retain the
  short global fallback route
- exact global and target-scoped LiteLLM names
- target hourly cost, intelligence, prefill/decode speed, and diagnostic TTFT
- estimated quantization quality retained, when measured
- profile/reservation popularity and the current user's favorite state

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
refreshes the cache, benchmarks an activated runtime, and may activate a stopped
target. **Rediscover all** runs targets one by one. AWS EC2 resource discovery
hides instances already assigned to a NeurOn target by default.

**Add target** first chooses **Connect existing** or **Provision new**. Existing
mode asks only for a provider resource and lets discovery fill runtime facts.
Provision mode chooses a catalog-backed Runtime, full PreFer commit, hardware or
instance, and then one runtime configuration. Creating the target stores a draft
without contacting the provider; a separate visible action provisions it.

## Connect

Route:

```text
GET /client-setup
```

The page labels the shortest target-scoped alias as **Use** and the short global
alias as **Fallback** for each LiteLLM route, then creates an OpenCode provider
configuration for all models or one selected profile. The model catalog ID is
shown only as model metadata, not as a callable LiteLLM route. Direct-host
connections show the short alias and runtime model ID. It never creates a
reservation or changes capacity.

## Usage Reports

Route:

```text
GET /admin/usage
```

Admins can inspect 7-, 30-, or 90-day UTC breakdowns by day, user, provider,
target, and model. The page leads with cost, activated time, reservation, and
active-user summaries, then shows one sortable-by-cost breakdown at a time in
Daily, Users, Targets, Providers, and Models tabs. Reports use durable
reservation/activation allocations and exclude synthetic traffic reservations.

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

- Reservation detail: 5 seconds
- Main/admin status: 5 seconds

Local development can override these to faster values through environment
variables or compose defaults.
