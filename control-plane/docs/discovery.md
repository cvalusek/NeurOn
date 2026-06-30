---
type: Reference
title: Discovery
description: Runtime model discovery, bootstrap behavior, and failure reporting.
tags: [discovery, models, runtime]
timestamp: 2026-06-29T00:00:00Z
---

# Discovery

Runtime model discovery reads an OpenAI-compatible `/v1/models` endpoint and
records the runtime model IDs, aliases, tags, and metadata that the target
reports.

Explicit model config remains the normal source of truth. Discovery is used to
populate or enrich model choices when a runtime can report them.

## Bootstrap

When a target has no configured models, discovery defaults on. Bootstrap
discovery:

1. Starts the target through its provider.
2. Waits for provider status and optional `healthUrl` to become ready.
3. Reads `/v1/models` from `apiUrl`, inferred RunPod proxy URL, LiteLLM backend
   URL, or the `/v1` origin derived from `healthUrl`.
4. Records discovered models and the discovery time in the configured storage
   layer.
5. Stops the target.

On startup, NeurOn first hydrates discovered models from storage. Bootstrap
then runs only for discovery-enabled targets that still have no configured or
cached models. It also runs in the background after explicit provisioning for a
discovery-enabled target with no configured models.

The admin Discover action runs the same start/wait/read/stop path when the
target is not already healthy. If the target is already healthy, Discover only
refreshes `/v1/models`.

Successful discovery refreshes replace the persisted cache for that target.
Deleting a persisted target also deletes its cached discovery record.

Discovery failure messages include the last concrete blocker seen while
waiting, such as provider status, failed health check, or `/v1/models` HTTP
error.
