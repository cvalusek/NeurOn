---
type: Reference
title: HassleOff Safety Watchdog
description: Dead-man leases, start interlock, a synthetic fail-safe test, maintenance holds, and scoped shutdown behavior.
tags: [safety, watchdog, leases, operations]
timestamp: 2026-07-13T00:00:00Z
---

# HassleOff Safety Watchdog

HassleOff is a separate process and image in this repository. It is an
out-of-band dead-man watchdog for explicitly registered, NeurOn-owned rented
targets. It has one narrow capability: stop the exact provider resource bound
to a registered target. It has no start or provision operation.

Run HassleOff in a failure domain that does not depend on the rented inference
host. NeurOn remains the only service Ground Control should use for capacity;
Ground Control must not call RunPod or HassleOff directly.

## Registration And Action Scope

Set exactly one target-registration source. `HASSLEOFF_TARGETS_FILE` is
preferred for local and container operation; `HASSLEOFF_TARGETS_JSON` remains
available for deployment systems that already supply structured environment
configuration. The selected source must contain a non-empty list. Each entry
has a stable `targetId`, a version-like `registrationId`, and exactly one stop
action:

```json
[
  {
    "targetId": "rented-qwen",
    "registrationId": "rented-qwen-v1",
    "action": {
      "type": "runpod-stop",
      "podId": "the-exact-pod-id",
      "apiKeyEnv": "HASSLEOFF_RUNPOD_API_KEY"
    }
  },
  {
    "targetId": "hassleoff-failsafe-test",
    "registrationId": "hassleoff-failsafe-test-v1",
    "displayName": "HassleOff fail-safe test",
    "testOnly": true,
    "action": { "type": "fake" }
  }
]
```

Registrations are copied into SQLite. A restart uses the durable registration
as the authority. If startup config changes a durable registration or omits
one, HassleOff remains able to trip previously armed leases but reports not
ready and refuses new leases. This prevents an accidental config change from
silently remapping or dropping a protected resource. Registration migration or
decommissioning is intentionally an operator-controlled database migration in
this first slice; there is no remote delete or global disable endpoint.

The RunPod action sends only `POST /v1/pods/{registeredPodId}/stop`. The API key
is read from the registered environment-variable name when the action runs. It
is never stored in SQLite or returned by status/audit APIs. Provider stop
operations must be idempotent because a process crash can leave the result of a
network request unknowable and HassleOff will safely retry.

## Authenticated Lease Protocol

All `/v1` routes require:

```http
Authorization: Bearer <HASSLEOFF_CONTROLLER_TOKEN>
```

`/healthz` and `/readyz` do not require the token and do not expose secrets.
The current protocol version is string `"1"`.

NeurOn creates or renews a lease with:

```http
PUT /v1/targets/{targetId}/lease
Content-Type: application/json

{
  "protocolVersion": "1",
  "targetId": "rented-qwen",
  "controllerId": "neuron-production",
  "leaseId": "a-controller-session-id",
  "sequence": 4,
  "issuedAt": "2026-07-13T12:00:00.000Z",
  "expiresAt": "2026-07-13T12:02:00.000Z"
}
```

The path and body target IDs must match exactly. HassleOff rejects unknown
targets, unsupported versions, non-monotonic sequence numbers, a second controller
while another controller has an unexpired lease, leases outside the configured
duration bounds, and controller clocks outside `HASSLEOFF_MAX_CLOCK_SKEW_MS`.

HassleOff calculates a conservative `acceptedUntil` from its own clock and the
requested duration. NeurOn treats a start as blocked unless the response says
the service is armed, the exact target is armed, the lease ID and sequence
match, and `acceptedUntil` is still in the future. The lease call itself proves
reachability; there is no separate optimistic health check in the interlock.

Once a target has accepted its first lease, it remains armed in durable state.
At or after `acceptedUntil`, HassleOff records a trip decision and performs the
target's registered stop action. Successful stops are not repeated for the same
lease. Failed stops are retried after `HASSLEOFF_FAILED_ACTION_RETRY_MS` and each
attempt is audited.

## Status And Audit

Authenticated `GET /v1/status` reports:

- service health, readiness, and armed state;
- durable registration issues;
- per-target armed and lease state;
- the target-scoped maintenance hold, if any;
- the last trip/action result;
- recent destructive-action audit events; and
- the last successful HassleOff fail-safe test.

`GET /v1/audit?targetId=<id>&limit=100` returns the durable audit trail. Events
include lease acceptance/rejection, expiry decisions, maintenance hold changes,
provider stop start/success/failure, and complete fail-safe-test success. Tokens and
provider credentials are never included.

## Maintenance Holds

A maintenance hold is scoped to one registered target and must have a reason
and an absolute expiry:

```http
POST /v1/targets/{targetId}/maintenance-hold

{
  "protocolVersion": "1",
  "targetId": "rented-qwen",
  "until": "2026-07-13T13:00:00.000Z",
  "reason": "controller deployment"
}
```

The expiry must be in the future and no later than
`HASSLEOFF_MAX_MAINTENANCE_HOLD_MS`. A hold only delays the exact target's trip;
it cannot affect another target. When the hold expires, an already expired
lease trips on the same watchdog pass. There is deliberately no indefinite or
global disable.

## HassleOff Fail-Safe Test

The complete synthetic test path is restricted to a registration with both
`testOnly: true` and `action.type: "fake"`:

```http
POST /v1/targets/hassleoff-failsafe-test/trip-test

{
  "protocolVersion": "1",
  "targetId": "hassleoff-failsafe-test"
}
```

The `/trip-test` route is the internal API behind the operator-facing
fail-safe test. HassleOff uses the normal lease acceptance logic, deliberately
expires that lease, runs the normal trip decision and action path, confirms the
durable success audit, and stores `lastFullTripTestSucceededAt`. It cannot run
against a real action registration.

Real-target fail-safe testing remains disabled by default. An explicit NeurOn target
policy can instead route a shutdown NeurOn already intends to perform through
HassleOff when the synthetic test timestamp is stale:

```json
{
  "hassleOff": {
    "protected": true,
    "leaseDurationSeconds": 120,
    "staleTripTestShutdown": {
      "enabled": true,
      "maxAgeSeconds": 86400
    }
  }
}
```

NeurOn sends `POST /v1/targets/{exactTargetId}/shutdown` with a stable request
ID. HassleOff persists that ID and replays a successful result without issuing
another provider stop. If HassleOff is unavailable, NeurOn falls back to its
normal direct stop because a watchdog outage must never keep paid capacity on.
The routed path is opt-in and disabled when the policy is absent.

## NeurOn Start Interlock

Deployment-level client configuration is:

- `HASSLEOFF_URL`
- `HASSLEOFF_CONTROLLER_TOKEN`
- `HASSLEOFF_CONTROLLER_ID`
- `HASSLEOFF_REQUEST_TIMEOUT_SECONDS` (default `5`)
- `HASSLEOFF_FAILSAFE_TEST_TARGET_ID` (default `hassleoff-failsafe-test`)

Target protection is opt-in through `hassleOff.protected` or
`CAPACITY_TARGET_<KEY>_HASSLEOFF_PROTECTED=true`. Unprotected targets retain
their previous behavior. For a protected target, ordinary activation,
discovery bootstrap, explicit provisioning, and replacement provisioning all
require an accepted exact lease first. Missing config, authentication failure,
unreachability, an unarmed watchdog, or a mismatched response produces an
explicit target failure; NeurOn never silently bypasses the interlock.

## Service Configuration

- `PORT` (default `8091`)
- `HASSLEOFF_CONTROLLER_TOKEN` (required, at least 16 characters)
- exactly one of `HASSLEOFF_TARGETS_FILE` or `HASSLEOFF_TARGETS_JSON`
- `HASSLEOFF_SQLITE_PATH` (default `./data/hassleoff.db`)
- `HASSLEOFF_CHECK_INTERVAL_MS` (default `5000`)
- `HASSLEOFF_MAX_CLOCK_SKEW_MS` (default `10000`)
- `HASSLEOFF_MIN_LEASE_MS` (default `15000`)
- `HASSLEOFF_MAX_LEASE_MS` (default `300000`)
- `HASSLEOFF_MAX_MAINTENANCE_HOLD_MS` (default `3600000`)
- `HASSLEOFF_FAILED_ACTION_RETRY_MS` (default `15000`)

## Published Container Image

The dedicated GitHub Actions workflow publishes HassleOff to
`ghcr.io/cvalusek/hassleoff`. It does not overwrite the NeurOn
control-plane image. Default-branch publications receive `latest`, `main`, and
an immutable `sha-<full-commit-sha>` tag. Prefer the full-SHA tag for external
failure-domain deployments.

The workflow leaves package visibility repository-inherited. This repository
is public, so the inherited package can be pulled without changing package
visibility. Pull a pinned image with:

```bash
docker pull ghcr.io/cvalusek/hassleoff:sha-<full-commit-sha>
```

Mount durable storage at `/app/data` (or set another writable
`HASSLEOFF_SQLITE_PATH`) and inject controller authentication and target
registrations through the deployment's secret/configuration mechanism. Do not
bake either value into the image.

## Normal Local Compose Operation

HassleOff is an optional `hassleoff` profile in the normal root Compose file.
The default command remains NeurOn-only and does not fail when HassleOff has
not been configured or launched:

```bash
docker compose up -d neuron
```

The optional service uses `ghcr.io/cvalusek/hassleoff:latest` by default,
publishes port `8091` unless overridden, stores SQLite in the named
`hassleoff-data` volume, mounts a target-registration file read-only, and has a
readiness healthcheck. It has no Compose dependency on NeurOn in either
direction.

Use this enablement order:

1. Leave every real target's `hassleOff.protected` policy false. Copy
   `hassleoff/examples/targets.local.json` to the ignored file
   `hassleoff/targets.local.private.json`. Keep its
   `hassleoff-failsafe-test` registration unchanged. Add any real registration
   only after verifying its exact `targetId`, resource ID, and action.
2. Set the following values in the operator's local configuration. Generate a
   unique shared token of at least 16 characters; the same value is supplied to
   NeurOn and HassleOff. Do not commit either credential.

   ```env
   HASSLEOFF_URL=http://hassleoff:8091
   HASSLEOFF_CONTROLLER_TOKEN=<random-shared-controller-token-at-least-16-characters>
   HASSLEOFF_CONTROLLER_ID=neuron-local
   HASSLEOFF_REQUEST_TIMEOUT_SECONDS=5
   HASSLEOFF_FAILSAFE_TEST_TARGET_ID=hassleoff-failsafe-test
   HASSLEOFF_HOST_PORT=8091
   HASSLEOFF_IMAGE=ghcr.io/cvalusek/hassleoff:latest
   HASSLEOFF_SQLITE_PATH=/app/data/hassleoff.db
   HASSLEOFF_TARGETS_FILE_HOST=./hassleoff/targets.local.private.json
   HASSLEOFF_RUNPOD_API_KEY=<provider-key-referenced-by-apiKeyEnv>
   ```

   A real RunPod registration references the credential by variable name; it
   never contains the credential itself:

   ```json
   {
     "targetId": "the-exact-neuron-target-id",
     "registrationId": "the-exact-neuron-target-id-v1",
     "action": {
       "type": "runpod-stop",
       "podId": "the-exact-provider-resource-id",
       "apiKeyEnv": "HASSLEOFF_RUNPOD_API_KEY"
     }
   }
   ```

3. Start only the optional watchdog and wait for readiness:

   ```bash
   docker compose --profile hassleoff up -d hassleoff
   curl http://localhost:8091/readyz
   ```

4. Start or recreate NeurOn so it receives the internal URL and controller
   settings:

   ```bash
   docker compose up -d neuron
   ```

5. Sign in to `http://localhost:8090`, open **Admin > HassleOff safety**, and
   confirm configured, reachable, ready, and armed all show `yes`. Select the
   synthetic confirmation checkbox and choose **Run fail-safe test**. Confirm
   that **Last successful fail-safe test** shows the new time.
6. Only after that succeeds, opt in the exact real target with
   `hassleOff.protected: true`, or with its env-expanded settings:

   ```env
   CAPACITY_TARGET_<KEY>_HASSLEOFF_PROTECTED=true
   CAPACITY_TARGET_<KEY>_HASSLEOFF_LEASE_DURATION_SECONDS=120
   CAPACITY_TARGET_<KEY>_HASSLEOFF_SHUTDOWN_ON_STALE_TRIP_TEST=false
   CAPACITY_TARGET_<KEY>_HASSLEOFF_TRIP_TEST_MAX_AGE_SECONDS=86400
   ```

   Recreate NeurOn after changing target configuration. Keep intentional
   stale-test shutdown routing false unless the exact-target behavior described
   above is deliberately required.

The UI controller token is never sent to the browser. The UI issues the
authenticated internal `/trip-test` request server-side and only for the
configured registration when it is both `testOnly` and `fake`.

## Isolated Fake Stack

For verification that must not load a default `.env`, use the standalone
fake-only stack and its explicit empty properties file:

```bash
docker compose --env-file control-plane/examples/compose-hassleoff.properties -f docker-compose.hassleoff.yml up --build
```

Open NeurOn at `http://localhost:18090` and use the local password documented in
the Compose file. HassleOff liveness and readiness are at
`http://localhost:18091/healthz` and `http://localhost:18091/readyz`. Both
registered actions are fake, so this stack contains no provider resource ID or
credential.

The authenticated direct-HTTP fallback for the same safe test is:

```bash
curl -H "Authorization: Bearer local-development-controller-token" \
  -H "Content-Type: application/json" \
  -d '{"protocolVersion":"1","targetId":"hassleoff-failsafe-test"}' \
  http://localhost:18091/v1/targets/hassleoff-failsafe-test/trip-test
```
