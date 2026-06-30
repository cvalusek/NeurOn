import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKey, AuthenticatedUser, CapacityTarget, Reservation, TargetStatus } from "../domain/types.js";

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new Error("Unauthenticated");
  return user;
}

export function reservationJson(reservation: Reservation, statuses: TargetStatus[]) {
  return {
    reservationId: reservation.id,
    username: reservation.username,
    displayUsername: reservationDisplayUsername(reservation),
    status: reservation.status,
    expiresAt: reservation.expiresAt.toISOString(),
    keepaliveMinutes: reservation.keepaliveMinutes,
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

export function reservationDisplayUsername(reservation: Pick<Reservation, "username" | "apiKeyName">): string {
  return reservation.apiKeyName ? `${reservation.username} ( ${reservation.apiKeyName} )` : reservation.username;
}

export function apiKeyJson(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString()
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
    providerId: target.providerId,
    modelIds: target.modelIds,
    modelsMax: target.modelsMax,
    litellmDisplayPrefix: litellmDisplayPrefix(target),
    healthUrl: target.healthUrl,
    apiUrl: target.apiUrl,
    needsProvisioning: needsProvisioning(target, status),
    desired: status?.desired ?? "off",
    observed: status?.observed ?? "stopped",
    message: status?.message ?? "Not checked",
    startupEstimate: status?.startupEstimate,
    activeUsers
  };
}

function needsProvisioning(target: CapacityTarget, status?: TargetStatus): boolean {
  if (target.provider === "runpod") return !target.runpod?.podId && Boolean(target.runpod?.create);
  if (target.provider === "docker") return Boolean(target.docker?.image) && (!status || status.message.toLowerCase().includes("not provisioned"));
  return false;
}

function litellmDisplayPrefix(target: CapacityTarget): string | undefined {
  if (target.litellmDisplayPrefix !== undefined) return target.litellmDisplayPrefix;
  return target.trafficModelPrefixes?.[0];
}
