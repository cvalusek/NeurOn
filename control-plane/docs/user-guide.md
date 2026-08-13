---
type: Guide
title: User Guide
description: How profiles, reservations, keepalive, status, and cost work in NeurOn.
tags: [users, profiles, reservations, cost]
timestamp: 2026-08-13T00:00:00Z
---

# User guide

NeurOn helps a team share expensive LLM runtime capacity without leaving it on
all the time. You say what you need and for how long; NeurOn combines your
demand with everyone else's, keeps the required target available, and turns it
off only when nobody or no recent traffic still needs it.

## First login

If you have no reservation profiles, Home takes you through a short explanation
before profile creation. **How NeurOn works** remains available in the
navigation afterward.

![First-login explanation of profiles, duration, and keepalive](images/welcome.png)

## Create a profile

A profile is a reusable reservation shape. Give it a recognizable name, choose
one or more targets, and select the models you expect to use on each target.

Use the profile guide when the model list is unfamiliar:

- Set minimum context first when it is a real workload requirement. An unknown
  context does not pass the filter.
- Add a domain, budget ceiling, or measured quantization-retention minimum only
  when required.
- Move the **quality**, **speed**, and **cost** controls—or the synchronized
  triangle—to express preferences among the remaining choices.
- The quick wizard sets those same controls. If the optional workload advisor
  is available, it also fills only the controls; it does not choose or save for
  you.
- Review the best-fit, smartest, fastest, and cheapest cards, then apply one to
  fill an exact target-model choice.

Speed is target-specific and favors decode throughput while still considering
prefill throughput and first-token latency. Missing measurements reduce displayed data coverage rather
than counting as a poor score. Quantization retention appears only when an
operator supplied a measured result for the exact artifact.

- If a target exposes one model, NeurOn selects it automatically.
- If a target exposes several models, choose at least one. This prevents a
  reservation from waking an expensive target without recording the intended
  models.
- A profile may include several target/model combinations. Use that for a
  workflow that genuinely needs multiple backends together; otherwise keep the
  profile small so its cost and intent stay obvious.

The profile also stores default duration and keepalive values. You can override
both immediately before making any reservation.

![Creating a profile with target-specific model choices](images/profile-create.png)

## Reserve capacity

On Home, select a profile and review the visible duration and keepalive choices.
Changing profiles immediately updates both controls to that profile's defaults.

- **Duration** is how long your reservation contributes demand, even if no
  traffic appears.
- **Keepalive** is how long recent observed traffic may keep an already-needed
  target available after direct demand ends. It is not additional guaranteed
  reservation time.
- **Estimated cost** covers the selected targets for duration plus keepalive at
  their configured or provider-reported hourly estimates. It is an operational
  estimate, not a cloud-provider invoice.

The reserve action stays at the bottom of the reservation panel with the cost
summary. Once submitted, your reservation appears at the top of Home with
extend and end controls.

![Home showing an active reservation, profile controls, and target status](images/home-reservation.png)

## Manage several reservations

Home lists every active reservation you own. Each has its own remaining time,
profile, models, projected cost, quick extensions, and **I'm done** action.
Ending one reservation does not stop capacity still required by another user or
reservation.

The Server status area is grouped by target. It shows aggregate demand and then
the reservations contributing to that target. A multi-target reservation can
therefore appear under more than one target while remaining one reservation.

## Traffic reservation and cost

When LiteLLM traffic polling is configured, recent requests can create a short
synthetic traffic reservation. This signal protects a healthy target from being
stopped between closely spaced requests; it cannot wake a failed target on its
own and is not attributed as a user reservation.

During a traffic-only tail, estimated cost remains allocated to the real
reservations that participated in that target activation. New real demand
becomes the owner of subsequent allocation. Until user identity is available in
the traffic source, the activation participants are the fairest durable link.

## When capacity is not ready yet

Reservation creation records intent; it does not promise the runtime is already
healthy. Watch Server status for `starting`, `healthy`, or a failure message.
For a pre-created EC2 target that AWS is still stopping, NeurOn keeps the
reservation active, waits for `stopped`, and starts it on a later reconciliation
pass. It does not repeatedly issue an invalid start request.

If a target reports a provider failure, NeurOn fails the affected reservations
rather than pretending the capacity is usable. Contact an operator with the
target name and visible status message; never share an API key.
