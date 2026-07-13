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

1. Acquires an in-memory, target-scoped discovery operation and desired-on
   lease.
2. Lets the reconciler start the target through the normal decorated provider
   boundary.
3. Waits for provider status and optional `healthUrl` to become ready.
4. Reads `/v1/models` from `apiUrl`, inferred RunPod proxy URL, LiteLLM backend
   URL, or the `/v1` origin derived from `healthUrl`.
5. Records discovered models and the discovery time in the configured storage
   layer.
6. Releases the operation lease and, when discovery started the capacity,
   immediately reconciles the target against current reservation and traffic
   demand.

The discovery lease is operational demand, not a user or synthetic traffic
reservation. It is never persisted and is excluded from reservation cost
attribution. Every success, provider failure, catalog failure, and timeout path
releases it.

The ownership invariant is:

- A target that discovery starts from stopped is stopped after success or
  failure when no reservation or traffic demand exists.
- Reservation or traffic demand that exists or appears while discovery runs
  keeps the target on after the lease is released.
- Discovery does not stop a target that was already running without NeurOn
  demand when the operation began. Later ordinary reconciliation continues to
  follow the normal reservation/traffic desired-state policy.
- Provider start, stop, force-stop, and provisioning mutations for one target
  use the same serialized lifecycle lane. Different targets remain
  independent.

On startup, NeurOn first hydrates discovered models from storage. Bootstrap
then runs only for discovery-enabled targets that still have no configured or
cached models. It also runs in the background after explicit provisioning for a
discovery-enabled target with no configured models.

Startup bootstrap, the admin Discover action, and post-provision background
bootstrap all use this same operation path. Concurrent discovery requests for
one target coalesce onto the in-flight result, and catalog reads are likewise
coalesced. Discovery on different targets remains independent.

Force stop has explicit precedence rules: while discovery is active for a
target, force stop returns HTTP `409 Conflict` and does not call the provider.
Likewise, discovery cannot begin while a force stop is running. The operator
can retry either operation after the in-flight operation completes. After a
force stop succeeds, ordinary reconciliation remains unchanged: active
reservation or traffic demand can start the target again on a later pass.

Successful discovery refreshes replace the persisted cache for that target.
Deleting a persisted target also deletes its cached discovery record.

Discovery failure messages include the last concrete blocker seen while
waiting, such as provider status, failed health check, or `/v1/models` HTTP
error. The admin action remains synchronous, returns that concrete error, and
shows it in the browser instead of leaving only a generic failed result.

## Retry `local-prefer` After Updating NeurOn

1. Update the NeurOn checkout/deployment to the fixed revision and rebuild or
   restart only the NeurOn control-plane service using the normal deployment
   procedure.
2. Leave the existing Docker container named `prefer` unchanged. Its
   checkout-built `prefer:local` image is intentionally reusable; the
   configured `ghcr.io/cvalusek/prefer:latest` image is used only if an explicit
   provisioning action creates a missing container.
3. Sign in as an admin and open **Admin > Targets > local-prefer**.
4. Select **Discover** once and wait for the synchronous success or concrete
   failure message. A second click while it is running joins the same discovery
   operation.
5. On success, refresh the target/model view and confirm the runtime catalog is
   populated. On failure, use the displayed error and the matching NeurOn log
   entry to correct the underlying readiness or catalog issue before retrying.

No storage migration or target configuration change is required.
