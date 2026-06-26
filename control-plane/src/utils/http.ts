import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticatedUser, CapacityTarget, Reservation, TargetStatus } from "../domain/types.js";

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new Error("Unauthenticated");
  return user;
}

export function reservationJson(reservation: Reservation, statuses: TargetStatus[]) {
  return {
    reservationId: reservation.id,
    username: reservation.username,
    status: reservation.status,
    expiresAt: reservation.expiresAt.toISOString(),
    endedAt: reservation.endedAt?.toISOString(),
    modelIds: reservation.modelIds,
    targets: reservation.targetIds.map((targetId) => {
      const status = statuses.find((candidate) => candidate.targetId === targetId);
      return {
        id: targetId,
        desired: status?.desired ?? "off",
        observed: status?.observed ?? "stopped",
        status: status?.observed ?? "stopped",
        message: status?.message ?? "Not checked"
      };
    }),
    failureMessage: reservation.failureMessage
  };
}

export function sendError(reply: FastifyReply, error: unknown, statusCode = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(statusCode).send({ error: message });
}

export function targetJson(target: CapacityTarget, status?: TargetStatus, activeUsers: string[] = []) {
  return {
    id: target.id,
    displayName: target.displayName,
    provider: target.provider,
    modelIds: target.modelIds,
    modelsMax: target.modelsMax,
    healthCheckUrl: target.healthCheckUrl,
    runtimeApiBaseUrl: target.runtimeApiBaseUrl,
    desired: status?.desired ?? "off",
    observed: status?.observed ?? "stopped",
    message: status?.message ?? "Not checked",
    startupEstimate: status?.startupEstimate,
    activeUsers
  };
}
