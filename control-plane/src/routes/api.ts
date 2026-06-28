import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CapacityProvider, ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import { HealthChecker } from "../reconciler/HealthChecker.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { ApiKeyService } from "../services/ApiKeyService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";
import { apiKeyJson, requireUser, reservationJson, sendError, targetJson } from "../utils/http.js";

export function registerApiRoutes(
  app: FastifyInstance,
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  apiKeyService: ApiKeyService,
  reservationService: ReservationService,
  trafficKeepalive: TrafficKeepaliveService,
  reconciler: Reconciler,
  capacityProvider: CapacityProvider,
  runtimeModelDiscovery: RuntimeModelDiscovery,
  healthChecker: HealthChecker
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
        const body = z.object({ modelIds: z.array(z.string()).default([]), targetIds: z.array(z.string()).default([]), durationMinutes: z.number(), keepaliveMinutes: z.number().optional() }).parse(request.body);
        const reservation = await reservationService.createForUser(requireUser(request), body);
        return reply.code(201).send(reservationJson(reservation, statuses.list()));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get("/api/reservations/:id", async (request, reply) => reservationEndpoint(request, reply, reservationService, statuses));
  app.get("/api/reservations/:id/status", async (request, reply) => reservationEndpoint(request, reply, reservationService, statuses));

  app.post("/api/reservations/:id/done", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const reservation = await reservationService.markDone(id, requireUser(request));
      return reservationJson(reservation, statuses.list());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/reservations/:id/extend", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { durationMinutes } = z.object({ durationMinutes: z.number() }).parse(request.body);
      const reservation = await reservationService.extend(id, requireUser(request), durationMinutes);
      return reservationJson(reservation, statuses.list());
    } catch (error) {
      return sendError(reply, error);
    }
  });

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
    async () => statusPayload(catalog, reservations, statuses)
  );
  app.get("/api/admin/reservations", async () => ({ reservations: (await reservations.list()).map((reservation) => reservationJson(reservation, statuses.list())) }));
  app.get("/api/admin/targets", async () => ({ capacityTargets: await targetsPayload(catalog, reservations, statuses) }));
  app.get("/api/admin/status", async () => statusPayload(catalog, reservations, statuses, { includeReservationHistory: true }));

  app.post("/api/admin/targets/:id/reconcile", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await reconciler.reconcileTarget(id);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/targets/:id/install", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = catalog.getTarget(id);
      if (!target) throw new Error("Target not found");
      await capacityProvider.installTarget(target);
      const providerStatus = await capacityProvider.getTargetStatus(target);
      statuses.set({ targetId: id, desired: "off", observed: providerStatus.observed, message: providerStatus.message, lastCheckedAt: new Date() });
      return { ok: true };
    } catch (error) {
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

async function reservationEndpoint(request: { params: unknown }, reply: { code: (code: number) => { send: (body: unknown) => unknown } }, service: ReservationService, statuses: TargetStatusRepository) {
  try {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await service.getOwned(id, requireUser(request as never));
    return reservationJson(reservation, statuses.list());
  } catch (error) {
    return sendError(reply as never, error, 404);
  }
}

async function statusPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository, options: { includeReservationHistory?: boolean } = {}) {
  const activeReservations = await reservations.listActive(new Date());
  const visibleReservations = options.includeReservationHistory ? await reservations.list() : activeReservations;
  return {
    reservations: visibleReservations.map((reservation) => reservationJson(reservation, statuses.list())),
    activeReservations: activeReservations.map((reservation) => reservationJson(reservation, statuses.list())),
    capacityTargets: await targetsPayload(catalog, reservations, statuses)
  };
}

async function targetsPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository) {
  const active = await reservations.listActive(new Date());
  return catalog.listTargets().map((target) =>
    targetJson(
      target,
      statuses.get(target.id),
      Array.from(new Set(active.filter((reservation) => reservation.targetIds.includes(target.id)).map((reservation) => reservation.username)))
    )
  );
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
    status: { type: "string", enum: ["active", "done", "expired", "failed"] },
    expiresAt: { type: "string", format: "date-time" },
    keepaliveMinutes: { type: "number" },
    endedAt: { type: "string", format: "date-time" },
    modelIds: { type: "array", items: { type: "string" } },
    targets: { type: "array", items: targetRefSchema },
    failureMessage: { type: "string" }
  },
  required: ["reservationId", "username", "status", "expiresAt", "modelIds", "targets"]
} as const;

const reservationCreateSchema = {
  type: "object",
  properties: {
    modelIds: { type: "array", items: { type: "string" }, default: [] },
    targetIds: { type: "array", items: { type: "string" }, default: [] },
    durationMinutes: { type: "number" },
    keepaliveMinutes: { type: "number" }
  },
  required: ["durationMinutes"]
} as const;

const targetSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    provider: { type: "string" },
    modelIds: { type: "array", items: { type: "string" } },
    modelsMax: { type: "number" },
    healthCheckUrl: { type: "string" },
    runtimeApiBaseUrl: { type: "string" },
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
