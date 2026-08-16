import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CapacityProvider, ReservationRepository, TargetActivationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, CapacityTarget, Reservation, ReservationProfile, TargetActivation, TargetActivationReservation } from "../domain/types.js";
import { HealthChecker } from "../reconciler/HealthChecker.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { ApiKeyService } from "../services/ApiKeyService.js";
import { CostEstimationService } from "../services/CostEstimationService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ModelSelectionService } from "../services/ModelSelectionService.js";
import { ModelFavoriteService } from "../services/ModelFavoriteService.js";
import { UsageAnalyticsService } from "../services/UsageAnalyticsService.js";
import { litellmAliases } from "../litellm/modelRouting.js";
import { ProfileAssistantRequestConflictError, type ProfileAdvisorService, type ProfileAssistantContext } from "../services/ProfileAdvisorService.js";
import { ReservationService } from "../services/ReservationService.js";
import { ReservationProfileService } from "../services/ReservationProfileService.js";
import { RuntimeModelDiscovery } from "../services/RuntimeModelDiscovery.js";
import { shouldBootstrapRuntimeModels } from "../services/RuntimeModelDiscovery.js";
import { TargetProvisioningService } from "../services/TargetProvisioningService.js";
import { TargetOperationConflictError, TargetOperationCoordinator } from "../services/TargetOperationCoordinator.js";
import { TargetService } from "../services/TargetService.js";
import { TrafficKeepaliveService } from "../services/TrafficKeepaliveService.js";
import { apiKeyJson, requireUser, reservationDisplayUsername, reservationJson, sendError, targetJson } from "../utils/http.js";

const assistantRequestBodySchema = z.object({
  request: z.string().trim().min(3).max(2_000),
  currentDraft: z.object({
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    defaultDurationMinutes: z.number().int().min(1).max(720).optional(),
    defaultKeepaliveMinutes: z.number().int().min(1).max(60).optional(),
    selections: z.array(z.object({ targetId: z.string().min(1), modelIds: z.array(z.string().min(1)).max(20) })).max(20)
  }).strict().optional(),
  screen: z.object({
    path: z.string().min(1).max(500),
    title: z.string().max(200).optional(),
    surface: z.enum(["home", "profiles", "profile_create", "profile_edit", "guide", "client_setup", "api_keys", "admin_model_data", "admin_assistant", "admin_targets", "admin_other", "other"]),
    startControls: z.object({
      selectedProfileId: z.string().max(200).optional(),
      durationMinutes: z.number().int().min(1).max(720).optional(),
      keepaliveMinutes: z.number().int().min(1).max(60).optional()
    }).strict().optional(),
    profileRequirements: z.object({
      minimumContextTokens: z.number().int().min(0).max(10_000_000).optional(),
      maximumHourlyUsd: z.number().min(0).max(1_000_000).optional(),
      hostingMode: z.enum(["dedicated", "multi-model"]).optional(),
      domains: z.array(z.string().min(1).max(80)).max(20).optional(),
      technicalCapabilities: z.array(z.string().min(1).max(80)).max(20).optional(),
      weights: z.object({ intelligence: z.number().min(0).max(1), speed: z.number().min(0).max(1), cost: z.number().min(0).max(1) }).strict().optional()
    }).strict().optional(),
    clientProfileId: z.string().max(200).optional()
  }).strict().optional()
}).strict();

type AssistantRequestBody = z.infer<typeof assistantRequestBodySchema>;

async function assistantContext(
  body: AssistantRequestBody,
  user: AuthenticatedUser,
  reservationProfiles: ReservationProfileService,
  reservationService: ReservationService
): Promise<ProfileAssistantContext> {
  const savedProfiles = (await reservationProfiles.listForUser(user)).map((profile) => ({ id: profile.id, name: profile.name }));
  const activeReservations = (await reservationService.listActiveOwned(user)).map((reservation) => ({
    id: reservation.id,
    profileId: reservation.profileId,
    profileName: reservation.profileName,
    targetIds: reservation.targetIds,
    modelIds: reservation.modelIds,
    expiresAt: reservation.expiresAt.toISOString()
  }));
  return { currentDraft: body.currentDraft, savedProfiles, screen: body.screen, activeReservations };
}

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
  targetActivations: TargetActivationRepository,
  targetOperations: TargetOperationCoordinator,
  healthInfo: { storageDriver: string; maintenanceMode: boolean },
  modelSelection: ModelSelectionService,
  profileAdvisor: ProfileAdvisorService,
  modelFavorites: ModelFavoriteService,
  usageAnalytics: UsageAnalyticsService
) {
  app.get("/healthz", async () => ({ ok: true, ...healthInfo }));
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

  app.post("/api/profile-advisor/requests", async (request, reply) => {
    if (healthInfo.maintenanceMode) return reply.code(503).send({ error: "AI profile guidance is unavailable while NeurOn is in maintenance mode" });
    if (!(await profileAdvisor.isConfigured())) return reply.code(503).send({ error: "AI profile guidance is not configured" });
    try {
      const body = assistantRequestBodySchema.parse(request.body);
      const user = requireUser(request);
      const context = await assistantContext(body, user, reservationProfileService, reservationService);
      return reply.code(202).send(await profileAdvisor.startInterpret(body.request, context, user));
    } catch (error) {
      const invalidRequest = error instanceof z.ZodError;
      return reply.code(invalidRequest ? 400 : error instanceof ProfileAssistantRequestConflictError ? 409 : 502).send({
        error: invalidRequest ? "Describe the workload in 3 to 2,000 characters" : error instanceof Error ? error.message : "Assistant failed"
      });
    }
  });

  app.get("/api/profile-advisor/requests/:id", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const status = profileAdvisor.getInterpretRequest(id, requireUser(request));
      return status ? status : reply.code(404).send({ error: "Assistant request not found" });
    } catch (error) { return sendError(reply, error); }
  });

  app.get(
    "/api/model-selection",
    {
      schema: {
        tags: ["models"],
        summary: "List target-specific model selection facts",
        security: authSecurity()
      }
    },
    async (request) => {
      const user = requireUser(request);
      const [usage, favorites, costs] = await Promise.all([
        usageAnalytics.deploymentUsage(), modelFavorites.listForUser(user), selectionCostEstimates(catalog.listTargets(), costEstimation)
      ]);
      const usageByKey = new Map(usage.map((value) => [`${value.targetId}::${value.modelId}`, value]));
      const favoriteKeys = new Set(favorites.map((value) => `${value.targetId}::${value.modelId}`));
      return {
        domains: modelSelection.availableDomains(),
        technicalCapabilities: modelSelection.availableTechnicalCapabilities(),
        deployments: modelSelection.listDeployments(costs).map((deployment) => ({ ...deployment, ...usageByKey.get(deployment.key), favorite: favoriteKeys.has(deployment.key) })),
        advisorEnabled: await profileAdvisor.isConfigured()
      };
    }
  );

  app.get("/api/client-models", async (request) => {
    const user = requireUser(request);
    const profiles = await reservationProfileService.listForUser(user);
    const targets = new Map(catalog.listTargets().map((target) => [target.id, target]));
    return {
      models: modelSelection.listDeployments().flatMap((deployment) => {
        const target = targets.get(deployment.targetId);
        if (!target) return [];
        return [{
          targetId: target.id,
          targetDisplayName: target.displayName,
          modelId: deployment.modelId,
          modelDisplayName: deployment.modelDisplayName,
          aliases: litellmAliases(target, deployment.modelId, deployment.aliases),
          aliasPriority: target.aliasPriority ?? 100,
          contextWindowTokens: deployment.contextWindowTokens,
          profileIds: profiles.filter((profile) => profile.selections.some((selection) => selection.targetId === target.id && selection.modelIds.includes(deployment.modelId))).map((profile) => profile.id)
        }];
      }),
      profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name }))
    };
  });

  app.get("/api/profile-advisor/status", async () => {
    try {
      const backend = await profileAdvisor.configuration();
      return {
        enabled: Boolean(backend) && !healthInfo.maintenanceMode,
        reason: healthInfo.maintenanceMode ? "maintenance_mode" : backend ? undefined : "not_configured",
        backend: backend ? {
          targetId: backend.target.id,
          targetDisplayName: backend.target.displayName,
          modelId: backend.config.modelId,
          observed: statuses.get(backend.target.id)?.observed ?? "stopped"
        } : null
      };
    } catch (error) {
      return { enabled: false, error: error instanceof Error ? error.message : "Assistant configuration is invalid" };
    }
  });

  app.post("/api/model-favorites", async (request, reply) => {
    try {
      const body = z.object({ targetId: z.string().min(1), modelId: z.string().min(1) }).parse(request.body);
      return reply.code(201).send(await modelFavorites.add(requireUser(request), body.targetId, body.modelId));
    } catch (error) { return sendError(reply, error); }
  });
  app.delete("/api/model-favorites/:targetId/:modelId", async (request, reply) => {
    try {
      const params = z.object({ targetId: z.string().min(1), modelId: z.string().min(1) }).parse(request.params);
      return { removed: await modelFavorites.remove(requireUser(request), params.targetId, params.modelId) };
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/api/admin/model-metadata", async () => ({ catalog: modelSelection.catalogConfig() }));
  app.put("/api/admin/model-metadata/models/:modelId", async (request, reply) => {
    try {
      const { modelId } = z.object({ modelId: z.string().min(1) }).parse(request.params);
      const body = z.object({
        intelligence: z.number().min(0).max(100).optional(),
        domains: z.record(z.number().min(0).max(100)).optional(),
        quantization: z.object({ format: z.string().min(1), qualityRetentionPercent: z.number().min(0).max(100).optional(), reference: z.string().optional() }).optional(),
        provenance: z.object({ source: z.string().min(1), sourceUrl: z.string().url().optional(), sourceModelId: z.string().optional(), retrievedAt: z.string().datetime().optional(), version: z.string().optional(), notes: z.string().optional() }).optional()
      }).parse(request.body);
      if ((body.intelligence !== undefined || Object.keys(body.domains ?? {}).length > 0 || body.quantization) && !body.provenance) throw new Error("Model ratings and artifact facts require a source");
      await modelSelection.upsertCapability({ modelId, ...body });
      return { ok: true };
    } catch (error) { return sendError(reply, error); }
  });
  app.put("/api/admin/model-metadata/deployments/:targetId/:modelId", async (request, reply) => {
    try {
      const params = z.object({ targetId: z.string().min(1), modelId: z.string().min(1) }).parse(request.params);
      const body = z.object({
        performance: z.object({ decodeTokensPerSecond: z.number().positive().optional(), prefillTokensPerSecond: z.number().positive().optional(), timeToFirstTokenSeconds: z.number().positive().optional(), measuredAt: z.string().datetime().optional(), sampleCount: z.number().int().positive().optional() }).optional(),
        provenance: z.object({ source: z.string().min(1), sourceUrl: z.string().url().optional(), sourceModelId: z.string().optional(), retrievedAt: z.string().datetime().optional(), version: z.string().optional(), notes: z.string().optional() }).optional()
      }).parse(request.body);
      if (body.performance && !body.provenance) throw new Error("Deployment measurements require a source");
      await modelSelection.upsertDeployment({ ...params, ...body });
      return { ok: true };
    } catch (error) { return sendError(reply, error); }
  });
  app.put("/api/admin/targets/:targetId/models/:modelId/aliases", async (request, reply) => {
    try {
      const params = z.object({ targetId: z.string().min(1), modelId: z.string().min(1) }).parse(request.params);
      const { aliases } = z.object({ aliases: z.array(z.string().trim().min(1)).max(50) }).parse(request.body);
      const target = await targetService.updateModelAliases(params.targetId, params.modelId, aliases);
      return { ok: true, targetId: target.id, modelId: params.modelId, aliases };
    } catch (error) { return sendError(reply, error); }
  });
  app.get("/api/admin/assistant-config", async (_request, reply) => {
    try {
      const backend = await profileAdvisor.configuration();
      return { backend: backend ? { ...backend.config, targetDisplayName: backend.target.displayName } : null };
    } catch (error) { return sendError(reply, error); }
  });
  app.put("/api/admin/assistant-config", async (request, reply) => {
    try {
      const body = z.object({
        targetId: z.string().min(1).nullable(),
        modelId: z.string().min(1).nullable(),
        reservationMinutes: z.number().int().min(1).max(720),
        keepaliveMinutes: z.number().int().min(1).max(60),
        requestTimeoutSeconds: z.number().int().min(1).max(600),
        additionalInstructions: z.string().max(8_000).optional()
      }).strict().parse(request.body);
      if ((body.targetId === null) !== (body.modelId === null)) throw new Error("Target and model must both be selected or both be cleared");
      const backend = await profileAdvisor.saveConfiguration(body.targetId && body.modelId ? {
        targetId: body.targetId,
        modelId: body.modelId,
        reservationMinutes: body.reservationMinutes,
        keepaliveMinutes: body.keepaliveMinutes,
        requestTimeoutSeconds: body.requestTimeoutSeconds,
        additionalInstructions: body.additionalInstructions
      } : undefined);
      return { ok: true, backend: backend ? { targetId: backend.targetId, modelId: backend.modelId } : null };
    } catch (error) { return sendError(reply, error); }
  });
  app.get("/api/admin/usage", async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }).parse(request.query);
    return usageAnalytics.report(days);
  });

  app.post(
    "/api/profile-advisor",
    {
      schema: {
        tags: ["models"],
        summary: "Ask the NeurOn assistant for a validated UI or confirmation-gated action proposal",
        security: authSecurity(),
        body: {
          type: "object",
          properties: {
            request: { type: "string", minLength: 3, maxLength: 2_000 },
            currentDraft: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", maxLength: 120 },
                description: { type: "string", maxLength: 500 },
                defaultDurationMinutes: { type: "integer", minimum: 1, maximum: 720 },
                defaultKeepaliveMinutes: { type: "integer", minimum: 1, maximum: 60 },
                selections: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["targetId", "modelIds"], properties: { targetId: { type: "string" }, modelIds: { type: "array", maxItems: 20, items: { type: "string" } } } } }
              }
            },
            screen: {
              type: "object",
              additionalProperties: false,
              required: ["path", "surface"],
              properties: {
                path: { type: "string", maxLength: 500 },
                title: { type: "string", maxLength: 200 },
                surface: { type: "string", enum: ["home", "profiles", "profile_create", "profile_edit", "guide", "client_setup", "api_keys", "admin_model_data", "admin_assistant", "admin_targets", "admin_other", "other"] },
                startControls: { type: "object" },
                profileRequirements: { type: "object" },
                clientProfileId: { type: "string", maxLength: 200 }
              }
            }
          },
          required: ["request"]
        },
        response: { 400: errorSchema, 502: errorSchema, 503: errorSchema }
      }
    },
    async (request, reply) => {
      if (!(await profileAdvisor.isConfigured())) return reply.code(503).send({ error: "AI profile guidance is not configured" });
      try {
        const body = assistantRequestBodySchema.parse(request.body);
        const user = requireUser(request);
        const context = await assistantContext(body, user, reservationProfileService, reservationService);
        return { result: await profileAdvisor.interpret(body.request, context, user.isAdmin) };
      } catch (error) {
        const invalidRequest = error instanceof z.ZodError;
        const message = invalidRequest
          ? "Describe the workload in 3 to 2,000 characters"
          : error instanceof Error ? error.message : "Assistant failed";
        return reply.code(invalidRequest ? 400 : 502).send({ error: message });
      }
    }
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
    async () => statusPayload(catalog, reservations, statuses, costEstimation, runtimeModelDiscovery)
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
  app.get("/api/admin/targets", async () => ({ capacityTargets: await targetsPayload(catalog, reservations, statuses, runtimeModelDiscovery) }));
  app.get("/api/admin/activations", async () => activationPayload(catalog, reservations, targetActivations));
  app.get("/api/admin/status", async () => statusPayload(catalog, reservations, statuses, costEstimation, runtimeModelDiscovery, { includeReservationHistory: true }));

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
      const patch = await targetOperations.withLifecycleTransition(target.id, () => capacityProvider.provisionTarget(target));
      const updatedTarget = await targetService.applyProvisioningPatch(id, patch) ?? target;
      await targetProvisioningService.completeProvision(updatedTarget, patch);
      const providerStatus = await capacityProvider.getTargetStatus(updatedTarget);
      statuses.set({ targetId: id, desired: "off", observed: providerStatus.observed, message: providerStatus.message, lastCheckedAt: new Date() });
      if (shouldBootstrapRuntimeModels(updatedTarget)) {
        runDiscoveryBootstrapInBackground(updatedTarget, capacityProvider, runtimeModelDiscovery, healthChecker);
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
      await runtimeModelDiscovery.bootstrapTarget(target, capacityProvider, healthChecker, { benchmark: true });
      return { ok: true, models: catalog.listModelsForTarget(id) };
    } catch (error) {
      return sendError(reply, error, operationStatusCode(error));
    }
  });

  app.post("/api/admin/targets/rediscover-all", async () => {
    const results: Array<{ targetId: string; ok: boolean; error?: string }> = [];
    for (const target of catalog.listTargets()) {
      try {
        await runtimeModelDiscovery.bootstrapTarget(target, capacityProvider, healthChecker, { benchmark: true });
        results.push({ targetId: target.id, ok: true });
      } catch (error) {
        results.push({ targetId: target.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: results.every((result) => result.ok), results };
  });

  app.post("/api/admin/targets/:id/force-stop", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const target = catalog.getTarget(id);
      if (!target) throw new Error("Target not found");
      await targetOperations.runForceStop(id, () => capacityProvider.forceStopTarget(target));
      statuses.set({ targetId: id, desired: "off", observed: "stopped", message: "Force stopped", lastCheckedAt: new Date() });
      return { ok: true };
    } catch (error) {
      return sendError(reply, error, operationStatusCode(error));
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
  healthChecker: HealthChecker
): void {
  void runtimeModelDiscovery
    .bootstrapTarget(target, capacityProvider, healthChecker)
    .catch(() => undefined);
}

function operationStatusCode(error: unknown): number {
  return error instanceof TargetOperationConflictError ? 409 : 400;
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

async function statusPayload(
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  costEstimation: CostEstimationService,
  runtimeModelDiscovery: RuntimeModelDiscovery,
  options: { includeReservationHistory?: boolean } = {}
) {
  const activeReservations = await reservations.listActive(new Date());
  const visibleReservations = options.includeReservationHistory ? await reservations.list() : activeReservations;
  return {
    reservations: await reservationPayloads(visibleReservations, statuses, costEstimation, catalog),
    activeReservations: await reservationPayloads(activeReservations, statuses, costEstimation, catalog),
    capacityTargets: await targetsPayload(catalog, reservations, statuses, runtimeModelDiscovery)
  };
}

async function reservationPayloads(reservations: Reservation[], statuses: TargetStatusRepository, costEstimation: CostEstimationService, catalog?: ModelCatalog) {
  return Promise.all(reservations.map((reservation) => reservationPayload(reservation, statuses, costEstimation, catalog)));
}

async function reservationPayload(reservation: Reservation, statuses: TargetStatusRepository, costEstimation: CostEstimationService, catalog?: ModelCatalog) {
  const targets = catalog ? reservation.targetIds.map((targetId) => catalog.getTarget(targetId)).filter((target): target is CapacityTarget => Boolean(target)) : [];
  return reservationJson(reservation, statuses.list(), await costEstimation.estimateForReservation(reservation, targets));
}

async function targetsPayload(
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  runtimeModelDiscovery: RuntimeModelDiscovery
) {
  const active = await reservations.listActive(new Date());
  const history = await reservations.list();
  return catalog.listTargets().map((target) =>
    targetJson(
      target,
      statuses.get(target.id),
      Array.from(new Set(active.filter((reservation) => reservation.targetIds.includes(target.id)).map(reservationDisplayUsername))),
      runtimeModelDiscovery.cachedDiscoveryAt(target.id),
      runtimeModelDiscovery.startupOutcome(target.id),
      lastUsedAtForTarget(history, target.id)
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

function lastUsedAtForTarget(reservations: Reservation[], targetId: string): Date | undefined {
  const matching = reservations.filter((reservation) => reservation.targetIds.includes(targetId));
  const preferred = matching.some((reservation) => !reservation.synthetic) ? matching.filter((reservation) => !reservation.synthetic) : matching;
  const now = Date.now();
  const timestamp = Math.max(...preferred.map((reservation) => reservation.endedAt?.getTime() ?? Math.min(reservation.expiresAt.getTime(), now)));
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

async function selectionCostEstimates(
  targets: CapacityTarget[],
  costEstimation: CostEstimationService
): Promise<Record<string, { hourlyUsd: number }>> {
  const entries = await Promise.all(targets.map(async (target) => {
    const estimate = await costEstimation.resolveTargetCostEstimate(target);
    return estimate?.hourlyUsd === undefined ? undefined : [target.id, { hourlyUsd: estimate.hourlyUsd }] as const;
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, { hourlyUsd: number }] => Boolean(entry)));
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
    synthetic: { type: "boolean" },
    endedAt: { type: "string", format: "date-time" },
    modelIds: { type: "array", items: { type: "string" } },
    targetSelections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          targetId: { type: "string" },
          modelIds: { type: "array", items: { type: "string" } }
        },
        required: ["targetId", "modelIds"]
      }
    },
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
    hostingMode: { type: "string", enum: ["dedicated", "multi-model"] },
    trafficModelPrefixes: { type: "array", items: { type: "string" } },
    litellmDisplayPrefix: { type: "string" },
    aliasPriority: { type: "number" },
    litellm: {
      type: "object",
      properties: {
        backendName: { type: "string" },
        apiBaseUrl: { type: "string" },
        credentialName: { type: "string" },
        apiKeyEnv: { type: "string" },
        syncDiscoveredModels: { type: "boolean" }
      }
    },
    healthUrl: { type: "string" },
    apiUrl: { type: "string" },
    desired: { type: "string" },
    observed: { type: "string" },
    message: { type: "string" },
    lastUsedAt: { type: "string" },
    startupEstimate: {
      type: "object",
      properties: {
        minSeconds: { type: "number" },
        maxSeconds: { type: "number" },
        avgSeconds: { type: "number" },
        sampleCount: { type: "number" }
      }
    },
    runtimeModelDiscovery: {
      type: "object",
      properties: {
        cached: { type: "boolean" },
        discoveredAt: { type: "string", format: "date-time" },
        startupOutcome: {
          type: "object",
          properties: {
            targetId: { type: "string" },
            outcome: { type: "string", enum: ["skipped-cached", "discovered", "failed"] },
            reason: { type: "string" },
            cachedDiscoveredAt: { type: "string", format: "date-time" }
          },
          required: ["targetId", "outcome", "reason"]
        }
      },
      required: ["cached"]
    },
    activeUsers: { type: "array", items: { type: "string" } }
  },
  required: ["id", "displayName", "provider", "modelIds", "desired", "observed", "message", "runtimeModelDiscovery", "activeUsers"]
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
