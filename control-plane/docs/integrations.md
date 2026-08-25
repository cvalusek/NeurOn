---
type: Reference
title: Integrations
description: API keys, OpenAPI, Swagger UI, MCP, and plugin integration notes.
tags: [integrations, api, openapi, mcp, api-keys]
timestamp: 2026-06-28T00:00:00Z
---

# Integrations

NeurOn exposes integration surfaces for internal tools and plugins that need to
reserve capacity or inspect current capacity state.

## API Keys

Users can create API keys from:

```text
GET /api-keys
```

Generated keys use the `sk-neuron-...` format. The full key is shown only once
in the creation response/page. After that, NeurOn stores only a SHA-256 hash and
a display prefix.

Reservations created with an API key keep the real owner as the username, but
status pages show the API key name in parentheses, for example
`clint ( OpenCode )`.

Use keys with Bearer auth:

```http
Authorization: Bearer sk-neuron-...
```

API keys belong to a durable user ID. Every request re-resolves that user's
current status, roles, permissions, username, and target visibility, so a
disable, merge, or role change takes effect without rotating the key. For
safety, the MCP `end_reservation` tool only ends reservations owned by the
key's user, even if that user is an administrator.

API keys are stored through the configured storage driver:

- `memory`: process-local keys for throwaway development
- `sqlite`: keys in the SQLite `api_keys` table
- `postgres`: keys in the Postgres `api_keys` table

SQLite and Postgres keys survive NeurOn restarts. Keys created before durable
API-key storage existed were never written to disk and must be regenerated.

## OpenAPI And Swagger

The OpenAPI 3.0 document is available at:

```text
GET /openapi.json
```

Swagger UI is available at:

```text
GET /docs
```

The OpenAPI document includes Basic and Bearer authentication schemes and
schemas for the main plugin-facing endpoints, including models, reservations,
status, API keys, and MCP.

Local HTTP Basic authentication uses an individual user's password and is
rejected when the durable local authentication method is disabled. Personal
Bearer keys remain available for automation. Owners and Administrators with
`users.manage` may rename an active canonical account at
`PUT /api/admin/users/:id/name`. Those with `users.merge` may preview and
confirm duplicate-account merges at `POST /api/admin/users/merge/preview` and
`POST /api/admin/users/merge`; see
[Identity and Access](identity-access.md).

Reservation responses may include `costEstimate` after the reconciler has
allocated estimated target activation cost to that reservation. This is best-effort
chargeback metadata, not a provider invoice.

Good read-only smoke tests:

```bash
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/models
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/status
```

## Guided Model Selection API

Authenticated clients can read exact target-model selection facts from:

```text
GET /api/model-selection
```

The response includes explicit unknowns, target hourly estimates, measurement
provenance, available scored-strength keys, runtime-advertised technical
capabilities, favorites, popularity/profile counts, and whether the profile
assistant is enabled. It is read-only and does not start a target to collect
facts.

Authenticated users may add or remove an exact target-model favorite through
`/api/model-favorites`. Admins manage durable capability/deployment facts under
`/api/admin/model-metadata`; **Admin > Model data** is the normal human
interface.

`GET /api/profile-advisor/status` reports whether an administrator selected an
existing target/model backend. The browser sends the request, structured
current-page identity, and optional editable draft to `POST
/api/profile-advisor/requests`, then polls its owner-scoped status at `GET
/api/profile-advisor/requests/:id`. Asking may create or refresh the backend's
synthetic system reservation. The asynchronous response phases distinguish a
sleeping/waking backend from a warm model that is thinking, while avoiding one
long ALB request through a cold start. The eventual result is one validated
assistant tool proposal: configure controls, answer, propose a confirmed
save/start, or—only for admins—navigate or propose confirmed rediscovery. The
browser must not execute confirmation-required tools merely because the model
requested them. The synchronous `POST /api/profile-advisor` remains available
for compatible clients. See [Guided Model Selection](model-selection.md).

Admins configure that backend independently from target and Model data through
`GET/PUT /api/admin/assistant-config` or **Admin > Assistant**, including
optional trusted local system guidance. That guidance cannot loosen tool
schemas, ownership, authorization, confirmation, or lifecycle safety rules.

These assistant tools reuse NeurOn services and validation but are distinct
from the external MCP transport. MCP remains appropriate for API-key clients;
the browser assistant needs session identity, current-screen context, and
explicit confirmation semantics.

## OpenCode Plugin

This repository includes a project-local OpenCode plugin at
`.opencode/plugins/neuron.js`. It reads `NEURON_API_KEY` by default and creates
a short NeurOn reservation before a chat message is sent. Every matching chat
message waits for health before the request is sent. Completion events
refresh that reservation to the configured duration from now without waiting for
health again or stacking more time onto the old expiration.

The plugin package is publishable as `opencode-neuron` from the `.opencode`
directory. The plugin build workflow checks syntax, unit tests, and `npm pack
--dry-run`.

Release process:

1. Update `.opencode/package.json` and `.opencode/package-lock.json` to the new
   version.
2. Merge the change after the plugin build workflow passes.
3. Run the `Publish OpenCode plugin` workflow manually with the same version.
4. Leave `dry_run=true` for a release rehearsal, then rerun with
   `dry_run=false` to publish to npm using the repository `NPM_TOKEN` secret.

For local registry testing, publish to Verdaccio with:

```bash
cd .opencode
npm publish --registry http://localhost:4873
```

Default behavior:

- `NEURON_API_BASE_URL=http://localhost:8090`
- `NEURON_RESERVATION_DURATION_MINUTES=2`
- `NEURON_RESERVATION_KEEPALIVE_MINUTES=2`
- `NEURON_WAIT_FOR_HEALTHY=true`
- `NEURON_ALLOWED_PROVIDERS` is unset, allowing any provider with a model that
  maps to NeurOn

When `NEURON_WAIT_FOR_HEALTHY` is enabled, the plugin blocks the chat message
until all reservation targets report `healthy`. NeurOn performs any configured
model warmup before reporting `healthy`, so the plugin only waits for NeurOn's
readiness signal.

Set `NEURON_ALLOWED_PROVIDERS` to a comma-separated OpenCode provider allowlist
(for example, `litellm`) when the same OpenCode installation uses providers that
must not create NeurOn reservations.

The plugin reads `/api/client-models` and maps OpenCode's LiteLLM-facing name to
the exact NeurOn target/model pair. The response includes global aliases,
target-scoped aliases, canonical IDs, backend/runtime IDs, and legacy display
prefix names. A 404 falls back to the older `/api/status` and `/api/models`
mapping for compatibility.

Users can open **Connect** to copy an OpenCode provider
configuration for the entire catalog or one profile. Global aliases choose the
target with the lowest numeric `aliasPriority`; scoped `<target>/<alias>` names
remain available for every deployment. The profile page shows these names
alongside each model.
The Admin target create and persisted-target edit forms expose
`trafficModelPrefixes` as **LiteLLM model route prefixes**, so a value such as
`clint-desktop/` links `clint-desktop/gemma-4-e2b` to the selected target
without editing JSON. Declarative targets can set the field in JSON/env config
or use **Copy to DB** before editing it in Admin.

With global LiteLLM connectivity configured, successful runtime discovery
upserts a `neuron/<target-id>` credential and one canonical deployment for each
target/runtime model. Scoped and global friendly names are formal LiteLLM
`model_group_alias` entries that point at those canonical groups; they are not
additional model deployments. Global alias collisions use the target priority
to produce formal LiteLLM `fallbacks`, and ties fail closed. Operators should
validate alias resolution and failover against their pinned LiteLLM version.

The friendly target display name is preserved in LiteLLM metadata as
`neuron_target_display_name`; routing remains based on the stable target ID.
Credentials identify `openai` as their provider and use `noapikey` when the
target has no configured runtime key. Target stops do not block deployments,
allowing requests to remain queued while NeurOn starts capacity. Once LiteLLM
accepts the replacement router settings, NeurOn deletes only stale or redundant
NeurOn-owned deployment rows. This includes duplicate alias rows made by older
versions; operator-owned rows and router settings remain untouched.

Home and reservation detail pages emphasize the shortest target-scoped alias as
**Use** because it pins the selected deployment. The short global alias appears
as **Fallback** because it follows target priority and may route elsewhere. The
canonical catalog ID is not presented as a LiteLLM route. Direct-host blocks
show the short runtime alias as **Use** and the backend/runtime ID as **ID**.
A healthy target with a safe HTTP(S) `apiUrl` gets an icon that opens the
runtime root rather than its trailing `/v1` API path and omits credentials,
query parameters, and fragments. Stopped, starting, stopping, and failed
targets do not show a direct-host launch icon. LiteLLM gets the same icon only
when `LITELLM_UI_URL` explicitly names the correct operator-facing page;
NeurOn does not guess that path from the API URL.

LiteLLM traffic monitoring remains useful for clients that cannot run a plugin.
The OpenCode plugin is a stronger signal when it is available because it can
reserve capacity before sending traffic, rather than reacting to logs after a
request has already reached LiteLLM.

## MCP

NeurOn exposes an authenticated JSON-RPC endpoint:

```text
POST /mcp
```

It supports:

- `initialize`
- `tools/list`
- `tools/call`

Current MCP tools:

- `list_models`: list configured and discovered models
- `list_targets`: list capacity targets and runtime state
- `get_status`: return active reservations and target status
- `create_reservation`: create a reservation for models or targets
- `end_reservation`: mark one of the key user's reservations done

Example:

```bash
curl -H "Authorization: Bearer sk-neuron-..." \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://localhost:8090/mcp
```

Create a short target reservation:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_reservation",
    "arguments": {
      "targetIds": ["runpod"],
      "durationMinutes": 5,
      "keepaliveMinutes": 2
    }
  }
}
```

End that reservation:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "end_reservation",
    "arguments": {
      "reservationId": "<reservation-id>"
    }
  }
}
```

## Codex Stdio Bridge

Some MCP clients, including local Codex MCP configuration, launch command-based
stdio servers instead of connecting directly to HTTP JSON-RPC. NeurOn includes
a small bridge:

```text
scripts/neuron-mcp-stdio.js
```

The bridge reads stdio-framed MCP messages, forwards them to NeurOn's HTTP
`/mcp` endpoint, and writes stdio-framed responses.

Required environment variables:

```env
NEURON_MCP_URL=http://localhost:8090/mcp
NEURON_API_KEY=sk-neuron-...
```

Example Codex MCP config:

```toml
[mcp_servers.neuron]
command = 'C:\Path\To\node.exe'
args = ['C:\Users\Clint\source\repos\NeurOn\control-plane\scripts\neuron-mcp-stdio.js']
startup_timeout_sec = 30

[mcp_servers.neuron.env]
NEURON_MCP_URL = 'http://localhost:8090/mcp'
NEURON_API_KEY = 'sk-neuron-...'
```
