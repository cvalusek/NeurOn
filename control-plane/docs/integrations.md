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

Use keys with Bearer auth:

```http
Authorization: Bearer sk-neuron-...
```

API keys resolve to the username that created them. Their admin status follows
the same `ADMIN_USERS` rule as cookie and Basic auth. For safety, the MCP
`end_reservation` tool only ends reservations owned by the key's user, even if
that user is an admin.

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

Good read-only smoke tests:

```bash
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/models
curl -H "Authorization: Bearer sk-neuron-..." http://localhost:8090/api/status
```

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
