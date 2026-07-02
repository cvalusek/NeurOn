---
type: Architecture
title: Reconciler
description: Desired-state reconciliation loop and lifecycle rules for capacity targets.
tags: [reconciler, capacity, lifecycle]
timestamp: 2026-06-25T00:00:00Z
---

# Reconciler

The reconciler is the owner of infrastructure lifecycle transitions. Request
handlers mutate reservation state; they do not directly start or stop capacity.

## Loop

On every reconciliation pass:

1. Expire old reservations.
2. List active reservations.
3. Compute desired-on target IDs from active reservation target IDs.
4. Before turning off a previously-on target, poll LiteLLM traffic once when a
   traffic poller is configured.
5. Apply desired state through the `CapacityProvider`.
6. Record or close the target activation and update cost allocation records.
7. Read provider status.
8. Run the target health check when provider status says the target is running.
9. Store simple target status.
10. Sync LiteLLM when a target first becomes healthy.
11. Refresh runtime model IDs when a target is healthy.
12. Mark relevant active reservations failed if target starting fails.

## Desired State

Desired capacity is aggregate state:

- If at least one active reservation references a target, desired state is `on`.
- Otherwise desired state is `off`.

Ending one user's reservation only removes that user's contribution. It must not
stop a target that another active reservation still needs.

## Cost Estimates

When a target has `costEstimate.hourlyUsd`, or a provider can discover an hourly
rate, the reconciler records a `TargetActivation` for each desired-on period.
The activation snapshots the hourly cost when it opens. Manual target config
wins; RunPod targets can otherwise read the Pod's hourly cost from the RunPod
Pod detail API. On each pass, elapsed target cost since the previous pass is
divided evenly across reservations that are active for that target at the
current pass and accumulated on target activation reservations.

This is an estimate for chargeback visibility. It is not a provider billing
record, and it is not used to make scheduling or lifecycle decisions.

## Runtime States

The UI and API expose intentionally simple runtime states:

- `stopped`
- `starting`
- `healthy`
- `stopping`
- `failed`

Do not add detailed startup phases unless they are needed for user decisions.

## Traffic Check Before Shutdown

LiteLLM request-log polling normally runs on an interval. The reconciler also
performs one immediate traffic poll before shutting down a target that was
previously desired-on. This gives last-minute traffic a chance to create or
refresh the synthetic `traffic` reservation before capacity is stopped.

The keepalive still cannot resurrect a failed target by itself. It only extends
capacity that is already healthy or currently needed by a real active
reservation. When real reservations are active, traffic keepalive uses their
configured keepalive window; otherwise an existing synthetic traffic reservation
keeps carrying its previous window.

## Startup Estimates

Target status stores recent starting-to-healthy durations in memory. The UI
uses these samples to show an estimate like:

```text
Start: usually 2m, range 1m-10m
```

The estimate is intentionally observational:

- It uses recent local samples only.
- It resets on NeurOn restart.
- It is not used for scheduling or capacity decisions.

## Error Handling

Provider errors must not crash the app. The reconciler catches provider errors,
marks the target failed, and fails active reservations that need the target.
