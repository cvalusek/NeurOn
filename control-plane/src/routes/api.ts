import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CapacityProvider, ReservationRepository, TargetActivationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget, Reservation, ReservationProfile, TargetActivation, TargetActivationReservation } from "../domain/types.js";
import { HealthChecker } from "../reconciler/HealthChecker.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { ApiKeyService } from "../services/ApiKeyService.js";
import { CostEstimationService } from "../services/CostEstimationService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { ReservationProfileService } from "../services/ReservationProfileService.js";
import { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import { shouldBootstrapRuntimeModels } from "../services/RuntimeModelDiscovery.js";
import { TargetProvisioningService } from "../services/TargetProvisioningService.js";
import { TargetService } from "../services/TargetService.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";
import { apiKeyJson, requireUser, reservationDisplayUsername, reservationJson, sendError, targetJson } from "../utils/http.js";

export function registerApiRoutes(
  app: FastifyInstance,
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  apiKeyService: ApiKeyService,
  reservationService: ReservationService,
  reservationProfileService: ReservationProfileService,
  trafficKeepalive: TrafficKeepaliveService,
  reconciler: Reconciler,
  capacityProvider: CapacityProvider,
  runtimeModelDiscovery: RuntimeModelDiscovery,
  healthChecker: HealthChecker,
  targetService: TargetService,
  targetProvisioningService: TargetProvisioningService,
  costEstimation: CostEstimationService,
  targetActivations: TargetActivationRepository
) {
  app.get("/healthz", async () => ({ ok: true }));
  app.get(
    "/api/models",
    {
      schema: {
        tags: ["models"],
        summary: "List available models",
        security: authSecurity(),
        response: { 200: { type: "object", properties: { models: { type: "array", items: modelSchema } }, required: ["models"] } }
      }
    },
    async () => ({ models: catalog.listModels() })
  );

  app.get(
    "/api/api-keys",
    {
      schema: {
        tags: ["api-keys"],
        summary: "List API keys for the current user",
        security: authSecurity(),
        response: { 200: { type: "object", properties: { apiKeys: { type: "array", items: apiKeySchema } }, required: ["apiKeys"] } }
      }
    },
    async (request) => ({ apiKeys: (await apiKeyService.listForUser(requireUser(request))).map(apiKeyJson) })
  );

  app.post(
    "/api/api-keys",
    {
      schema: {
        tags: ["api-keys"],
        summary: "Generate a new API key",
        description: "Returns the secret token once. Later list responses include only metadata and the display prefix.",
        security: authSecurity(),
        body: { type: "object", properties: { name: { type: "string", default: "Plugin key" } } },
        response: {
          201: {
            type: "object",
            properties: { apiKey: apiKeySchema, token: { type: "string" } },
            required: ["apiKey", "token"]
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const body = z.object({ name: z.string().default("Plugin key") }).parse(request.body ?? {});
        const created = await apiKeyService.createForUser(requireUser(request), body);
        return reply.code(201).send({ apiKey: apiKeyJson(created.key), token: created.token });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete(
    "/api/api-keys/:id",
    {
      schema: {
        tags: ["api-keys"],
        summary: "Revoke an API key",
        security: authSecurity(),
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 204: { type: "null" }, 404: errorSchema }
      }
    },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const deleted = await apiKeyService.revokeForUser(requireUser(request), id);
        return reply.code(deleted ? 204 : 404).send(deleted ? undefined : { error: "API key not found" });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/reservation-profiles",
    {
      schema: {
        tags: ["reservation-profiles"],
        summary: "List reservation profiles for the current user",
        security: authSecurity(),
        response: { 200: { type: "object", properties: { reservationProfiles: { type: "array", items: reservationProfileSchema } }, required: ["reservationProfiles"] } }
      }
    },
    async (request) => ({ reservationProfiles: (await reservationProfileService.listForUser(requireUser(request))).map(reservationProfileJson) })
  );

  app.post(
    "/api/reservation-profiles",
    {
      schema: {
        tags: ["reservation-profiles"],
        summary: "Create a reservation profile",
        security: authSecurity(),
        body: reservationProfileCreateSchema,
        response: { 201: reservationProfileSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      try {
        const body = reservationProfileBodySchema.parse(request.body ?? {});
        const profile = await reservationProfileService.createForUser(requireUser(request), body);
        return reply.code(201).send(reservationProfileJson(profile));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete("/api/reservation-profiles/:id", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const deleted = await reservationProfileService.deleteForUser(id, requireUser(request));
      return reply.code(deleted ? 204 : 404).send(deleted ? undefined : { error: "Reservation profile not found" });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    "/api/reservations",
    {
      schema: {
        tags: ["reservations"],
        summary: "Create a reservation",
        security: authSecurity(),
        body: reservationCreateSchema,
        response: { 201: reservationSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      try {
        const body = z.object({ modelIds: z.array(z.string()).default([]), targetIds: z.array(z.string()).default([]), profileId: z.string().optional(), durationMinutes: z.number().optional(), keepaliveMinutes: z.number().optional() }).parse(request.body);
        const reservation = await reservationService.createForUser(requireUser(request), body);
        return reply.code(201).send(await reservationPayload(reservation, statuses, costEstimation, catalog));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get("/api/reservations/:id", async (request, reply) => reservationEndpoint(request, reply, reservationService, statuses, costEstimation, catalog));
  app.get("/api/reservations/:id/status", async (request, reply) => reservationEndpoint(request, reply, reservationService, statuses, costEstimation, catalog));

  app.post("/api/reservations/:id/done", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const reservation = await reservationService.markDone(id, requireUser(request));
      return reservationPayload(reservation, statuses, costEstimation, catalog);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    "/api/reservations/:id/extend",
    {
      schema: {
        tags: ["reservations"],
        summary: "Extend a reservation",
        security: authSecurity(),
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: reservationExtendSchema,
        response: { 200: reservationSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const { durationMinutes, fromNow } = z.object({ durationMinutes: z.number(), fromNow: z.boolean().optional() }).parse(request.body);
        const reservation = await reservationService.extend(id, requireUser(request), durationMinutes, { fromNow });
        return reservationPayload(reservation, statuses, costEstimation, catalog);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/status",
    {
      schema: {
        tags: ["status"],
        summary: "Get active reservations and target status",
        security: authSecurity(),
        response: { 200: statusSchema }
      }
    },
    async () => statusPayload(catalog, reservations, statuses, costEstimation)
  );
  app.get("/api/admin/reservations", async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        sort: z.enum(["expires_desc", "expires_asc", "created_desc", "created_asc"]).default("expires_desc")
      })
      .parse(request.query);
    const allReservations = await reservations.list();
    const sortedReservations = sortReservations(allReservations, query.sort);
    const offset = (query.page - 1) * query.pageSize;
    const pageReservations = sortedReservations.slice(offset, offset + query.pageSize);
    return {
      reservations: await reservationPayloads(pageReservations, statuses, costEstimation, catalog),
      page: query.page,
      pageSize: query.pageSize,
      total: sortedReservations.length,
      sort: query.sort
    };
  });
  app.get("/api/admin/targets", async () => ({ capacityTargets: await targetsPayload(catalog, reservations, statuses) }));
  app.get("/api/admin/activations", async () => activationPayload(catalog, reservations, targetActivations));
  app.get("/api/admin/status", async () => statusPayload(catalog, reservations, statuses, costEstimation, { includeReservationHistory: true }));

  app.post("/api/admin/targets/:id/reconcile", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await reconciler.reconcileTarget(id);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/targets/:id/provision", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = catalog.getTarget(id);
      if (!target) throw new Error("Target not found");
      await targetProvisioningService.beginProvision(target);
      const patch = await capacityProvider.provisionTarget(target);
      const updatedTarget = await targetService.applyProvisioningPatch(id, patch) ?? target;
      await targetProvisioningService.completeProvision(updatedTarget, patch);
      const providerStatus = await capacityProvider.getTargetStatus(updatedTarget);
      statuses.set({ targetId: id, desired: "off", observed: providerStatus.observed, message: providerStatus.message, lastCheckedAt: new Date() });
      if (shouldBootstrapRuntimeModels(updatedTarget)) {
        runDiscoveryBootstrapInBackground(updatedTarget, capacityProvider, runtimeModelDiscovery, healthChecker, statuses);
      }
      return { ok: true };
    } catch (error) {
      const id = z.object({ id: z.string().optional() }).safeParse(request.params).data?.id;
      if (id) await targetProvisioningService.failProvision(id, error).catch(() => undefined);
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/targets/:id/discover", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = catalog.getTarget(id);
      if (!target) throw new Error("Target not found");
      const previous = statuses.get(id);
      const providerStatus = await capacityProvider.getTargetStatus(target);
      if (providerStatus.observed === "healthy") {
        await runtimeModelDiscovery.refreshTarget(target);
        statuses.set({ targetId: id, desired: previous?.desired ?? "on", observed: "healthy", message: "Runtime model discovery refreshed", lastCheckedAt: new Date(), lastHealthyAt: new Date() });
      } else {
        statuses.set({ targetId: id, desired: "on", observed: "starting", message: "Runtime model discovery starting", lastCheckedAt: new Date() });
        await runtimeModelDiscovery.bootstrapTarget(target, capacityProvider, healthChecker);
        statuses.set({ targetId: id, desired: "off", observed: "stopped", message: "Runtime model discovery complete", lastCheckedAt: new Date() });
      }
      return { ok: true, models: catalog.listModelsForTarget(id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/targets/:id/force-stop", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = catalog.getTarget(id);
      if (!target) throw new Error("Target not found");
      await capacityProvider.forceStopTarget(target);
      statuses.set({ targetId: id, desired: "off", observed: "stopped", message: "Force stopped", lastCheckedAt: new Date() });
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/internal/traffic", async (request, reply) => {
    try {
      const body = z.object({ targetId: z.string(), modelIds: z.array(z.string()).default([]) }).parse(request.body);
      const target = catalog.getTarget(body.targetId);
      if (!target) throw new Error("Target not found");
      return { recorded: await trafficKeepalive.recordTraffic(target, body.modelIds) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function runDiscoveryBootstrapInBackground(
  target: CapacityTarget,
  capacityProvider: CapacityProvider,
  runtimeModelDiscovery: RuntimeModelDiscovery,
  healthChecker: HealthChecker,
  statuses: TargetStatusRepository
): void {
  statuses.set({ targetId: target.id, desired: "on", observed: "starting", message: "Runtime model discovery starting", lastCheckedAt: new Date() });
  void runtimeModelDiscovery
    .bootstrapTarget(target, capacityProvider, healthChecker)
    .then(() => {
      statuses.set({ targetId: target.id, desired: "off", observed: "stopped", message: "Runtime model discovery complete", lastCheckedAt: new Date() });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      statuses.set({ targetId: target.id, desired: "off", observed: "failed", message: `Runtime model discovery failed: ${message}`, lastCheckedAt: new Date() });
    });
}

async function reservationEndpoint(request: { params: unknown }, reply: { code: (code: number) => { send: (body: unknown) => unknown } }, service: ReservationService, statuses: TargetStatusRepository, costEstimation: CostEstimationService, catalog: ModelCatalog) {
  try {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await service.getOwned(id, requireUser(request as never));
    return reservationPayload(reservation, statuses, costEstimation, catalog);
  } catch (error) {
    return sendError(reply as never, error, 404);
  }
}

async function statusPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository, costEstimation: CostEstimationService, options: { includeReservationHistory?: boolean } = {}) {
  const activeReservations = await reservations.listActive(new Date());
  const visibleReservations = options.includeReservationHistory ? await reservations.list() : activeReservations;
  return {
    reservations: await reservationPayloads(visibleReservations, statuses, costEstimation, catalog),
    activeReservations: await reservationPayloads(activeReservations, statuses, costEstimation, catalog),
    capacityTargets: await targetsPayload(catalog, reservations, statuses)
  };
}

async function reservationPayloads(reservations: Reservation[], statuses: TargetStatusRepository, costEstimation: CostEstimationService, catalog?: ModelCatalog) {
  return Promise.all(reservations.map((reservation) => reservationPayload(reservation, statuses, costEstimation, catalog)));
}

async function reservationPayload(reservation: Reservation, statuses: TargetStatusRepository, costEstimation: CostEstimationService, catalog?: ModelCatalog) {
  const targets = catalog ? reservation.targetIds.map((targetId) => catalog.getTarget(targetId)).filter((target): target is CapacityTarget => Boolean(target)) : [];
  return reservationJson(reservation, statuses.list(), await costEstimation.estimateForReservation(reservation, targets));
}

async function targetsPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository) {
  const active = await reservations.listActive(new Date());
  return catalog.listTargets().map((target) =>
    targetJson(
      target,
      statuses.get(target.id),
      Array.from(new Set(active.filter((reservation) => reservation.targetIds.includes(target.id)).map(reservationDisplayUsername)))
    )
  );
}

async function activationPayload(catalog: ModelCatalog, reservations: ReservationRepository, targetActivations: TargetActivationRepository) {
  const allReservations = await reservations.list();
  const reservationById = new Map(allReservations.map((reservation) => [reservation.id, reservation]));
  const targets = await Promise.all(
    catalog.listTargets().map(async (target) => ({
      target,
      activations: await Promise.all((await targetActivations.listActivationsForTarget(target.id)).map((activation) => activationJson(activation, target, reservationById, targetActivations)))
    }))
  );
  return {
    activations: targets.flatMap((entry) => entry.activations).sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime() || left.id.localeCompare(right.id))
  };
}

async function activationJson(activation: TargetActivation, target: CapacityTarget, reservationById: Map<string, Reservation>, targetActivations: TargetActivationRepository) {
  const allocations = await targetActivations.listActivationReservations(activation.id);
  return {
    id: activation.id,
    targetId: activation.targetId,
    targetDisplayName: target.displayName,
    status: activation.status,
    startedAt: activation.startedAt.toISOString(),
    endedAt: activation.endedAt?.toISOString(),
    estimatedHourlyCostUsd: activation.estimatedHourlyCostUsd,
    estimatedCostUsd: activation.estimatedCostUsd,
    reservations: allocations.map((allocation) => activationReservationJson(allocation, reservationById)).filter(Boolean)
  };
}

function activationReservationJson(allocation: TargetActivationReservation, reservationById: Map<string, Reservation>) {
  const reservation = reservationById.get(allocation.reservationId);
  if (!reservation) return undefined;
  return {
    reservationId: allocation.reservationId,
    displayUsername: reservationDisplayUsername(reservation),
    status: reservation.status,
    startedAt: allocation.startedAt.toISOString(),
    endedAt: allocation.endedAt?.toISOString(),
    estimatedCostUsd: allocation.estimatedCostUsd,
    modelIds: reservation.modelIds
  };
}

function sortReservations(reservations: Reservation[], sort: "expires_desc" | "expires_asc" | "created_desc" | "created_asc"): Reservation[] {
  return [...reservations].sort((left, right) => {
    const leftTime = sort.startsWith("expires") ? left.expiresAt.getTime() : left.createdAt.getTime();
    const rightTime = sort.startsWith("expires") ? right.expiresAt.getTime() : right.createdAt.getTime();
    const direction = sort.endsWith("desc") ? -1 : 1;
    const byTime = (leftTime - rightTime) * direction;
    return byTime || left.id.localeCompare(right.id);
  });
}

function reservationProfileJson(profile: ReservationProfile) {
  return {
    id: profile.id,
    username: profile.username,
    name: profile.name,
    description: profile.description,
    selections: profile.selections,
    defaultDurationMinutes: profile.defaultDurationMinutes,
    defaultKeepaliveMinutes: profile.defaultKeepaliveMinutes,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString()
  };
}

function authSecurity(): Array<Record<string, string[]>> {
  return [{ bearerAuth: [] }, { basicAuth: [] }];
}

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"]
} as const;

const apiKeySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    lastUsedAt: { type: "string", format: "date-time" }
  },
  required: ["id", "name", "prefix", "createdAt"]
} as const;

const reservationProfileSelectionSchema = {
  type: "object",
  properties: {
    targetId: { type: "string" },
    modelIds: { type: "array", items: { type: "string" } }
  },
  required: ["targetId", "modelIds"]
} as const;

const reservationProfileSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    username: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    selections: { type: "array", items: reservationProfileSelectionSchema },
    defaultDurationMinutes: { type: "number" },
    defaultKeepaliveMinutes: { type: "number" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  required: ["id", "username", "name", "selections", "createdAt", "updatedAt"]
} as const;

const reservationProfileCreateSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    selections: { type: "array", items: reservationProfileSelectionSchema },
    defaultDurationMinutes: { type: "number" },
    defaultKeepaliveMinutes: { type: "number" }
  },
  required: ["name", "selections"]
} as const;

const reservationProfileBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  selections: z.array(z.object({ targetId: z.string(), modelIds: z.array(z.string()).default([]) })),
  defaultDurationMinutes: z.number().optional(),
  defaultKeepaliveMinutes: z.number().optional()
});

const modelSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    modelFamily: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    targetIds: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    backendModelIds: { type: "array", items: { type: "string" } },
    runtimeModelIds: { type: "array", items: { type: "string" } },
    contextWindowTokens: { type: "number" },
    contextLabel: { type: "string" }
  },
  required: ["id", "displayName", "aliases", "targetIds"]
} as const;

const targetRefSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    desired: { type: "string" },
    observed: { type: "string" },
    status: { type: "string" },
    message: { type: "string" }
  },
  required: ["id", "desired", "observed", "status", "message"]
} as const;

const reservationSchema = {
  type: "object",
  properties: {
    reservationId: { type: "string" },
    username: { type: "string" },
    displayUsername: { type: "string" },
    status: { type: "string", enum: ["active", "done", "expired", "failed"] },
    expiresAt: { type: "string", format: "date-time" },
    keepaliveMinutes: { type: "number" },
    profileId: { type: "string" },
    profileName: { type: "string" },
    endedAt: { type: "string", format: "date-time" },
    modelIds: { type: "array", items: { type: "string" } },
    targets: { type: "array", items: targetRefSchema },
    failureMessage: { type: "string" },
    costEstimate: {
      type: "object",
      properties: {
        estimatedCostUsd: { type: "number" },
        projectedRemainingCostUsd: { type: "number" },
        projectedTotalCostUsd: { type: "number" },
        estimatedHourlyCostUsd: { type: "number" },
        currency: { type: "string" }
      },
      required: ["estimatedCostUsd", "currency"]
    }
  },
  required: ["reservationId", "username", "displayUsername", "status", "expiresAt", "modelIds", "targets"]
} as const;

const reservationCreateSchema = {
  type: "object",
  properties: {
    modelIds: { type: "array", items: { type: "string" }, default: [] },
    targetIds: { type: "array", items: { type: "string" }, default: [] },
    profileId: { type: "string" },
    durationMinutes: { type: "number" },
    keepaliveMinutes: { type: "number" }
  }
} as const;

const reservationExtendSchema = {
  type: "object",
  properties: {
    durationMinutes: { type: "number" },
    fromNow: { type: "boolean" }
  },
  required: ["durationMinutes"]
} as const;

const targetSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    provider: { type: "string" },
    providerId: { type: "string" },
    modelIds: { type: "array", items: { type: "string" } },
    modelsMax: { type: "number" },
    litellmDisplayPrefix: { type: "string" },
    healthUrl: { type: "string" },
    apiUrl: { type: "string" },
    desired: { type: "string" },
    observed: { type: "string" },
    message: { type: "string" },
    startupEstimate: {
      type: "object",
      properties: {
        minSeconds: { type: "number" },
        maxSeconds: { type: "number" },
        avgSeconds: { type: "number" },
        sampleCount: { type: "number" }
      }
    },
    activeUsers: { type: "array", items: { type: "string" } }
  },
  required: ["id", "displayName", "provider", "modelIds", "desired", "observed", "message", "activeUsers"]
} as const;

const statusSchema = {
  type: "object",
  properties: {
    reservations: { type: "array", items: reservationSchema },
    activeReservations: { type: "array", items: reservationSchema },
    capacityTargets: { type: "array", items: targetSchema }
  },
  required: ["reservations", "activeReservations", "capacityTargets"]
} as const;
