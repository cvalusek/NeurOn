import type { TargetActivation, TargetActivationReservation } from "../domain/types.js";

export function cloneTargetActivation(activation: TargetActivation): TargetActivation {
  return {
    ...activation,
    startedAt: new Date(activation.startedAt),
    endedAt: activation.endedAt ? new Date(activation.endedAt) : undefined,
    lastCostedAt: new Date(activation.lastCostedAt)
  };
}

export function cloneTargetActivationReservation(link: TargetActivationReservation): TargetActivationReservation {
  return {
    ...link,
    startedAt: new Date(link.startedAt),
    endedAt: link.endedAt ? new Date(link.endedAt) : undefined
  };
}
