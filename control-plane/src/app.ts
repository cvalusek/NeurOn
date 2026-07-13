import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { SharedPasswordAuthProvider } from "./auth/SharedPasswordAuthProvider.js";
import { AwsEcsAsgCapacityProvider } from "./capacity/AwsEcsAsgCapacityProvider.js";
import { ActivateOrReprovisionCapacityProvider } from "./capacity/ActivateOrReprovisionCapacityProvider.js";
import { CompositeCapacityProvider } from "./capacity/CompositeCapacityProvider.js";
import { DockerContainerCapacityProvider } from "./capacity/DockerContainerCapacityProvider.js";
import { DockerComposeCapacityProvider } from "./capacity/DockerComposeCapacityProvider.js";
import { FakeCapacityProvider } from "./capacity/FakeCapacityProvider.js";
import { NeuronCapacityProvider } from "./capacity/NeuronCapacityProvider.js";
import { RunPodCapacityProvider } from "./capacity/RunPodCapacityProvider.js";
import type { AppConfig, ModelDefinition } from "./domain/types.js";
import { LiteLlmSpendLogsTrafficSource } from "./litellm/LiteLlmSpendLogsTrafficSource.js";
import { LiteLlmBackendConfigSync, NoopBackendConfigSync } from "./litellm/LiteLlmBackendConfigSync.js";
import { HealthChecker } from "./reconciler/HealthChecker.js";
import { Reconciler } from "./reconciler/Reconciler.js";
import { InMemoryTargetStatusRepository } from "./repository/InMemoryTargetStatusRepository.js";
import { createReservationRepository } from "./repository/createReservationRepository.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerUiRoutes } from "./routes/ui.js";
import { ApiKeyService } from "./services/ApiKeyService.js";
import { AuthMethodService } from "./services/AuthMethodService.js";
import { ModelCatalog } from "./services/ModelCatalog.js";
import { ModelWarmupService } from "./services/ModelWarmupService.js";
import { ProviderCatalog } from "./services/ProviderCatalog.js";
import { ProviderService } from "./services/ProviderService.js";
import { CostEstimationService } from "./services/CostEstimationService.js";
import { ReservationService } from "./services/ReservationService.js";
import { ReservationProfileService } from "./services/ReservationProfileService.js";
import { RuntimeModelDiscovery, shouldBootstrapRuntimeModels } from "./services/RuntimeModelDiscovery.js";
import { TargetProvisioningService } from "./services/TargetProvisioningService.js";
import { TargetService } from "./services/TargetService.js";
import { TrafficKeepaliveService } from "./services/TrafficKeepaliveService.js";
import { TrafficPoller } from "./services/TrafficPoller.js";
import { HassleOffCapacityProvider } from "./safety/HassleOffCapacityProvider.js";
import { HassleOffClient } from "./safety/HassleOffClient.js";

export async function buildApp(config: AppConfig, models: ModelDefinition[]) {
  const app = Fastify({ logger: true });
  const reservationRepository = await createReservationRepository(config.storage);
  const apiKeys = reservationRepository.apiKeys;
  const authMethodService = new AuthMethodService(config.authMethods, reservationRepository.authMethods);
  const providerCatalog = new ProviderCatalog(config.capacityProviders);
  const providerService = new ProviderService(config.capacityProviders, reservationRepository.capacityProviders, providerCatalog);
  await providerService.initialize();
  const authProvider = new SharedPasswordAuthProvider(config.sharedPassword, config.adminUsers, config.cookieSecret, apiKeys);
  const catalog = new ModelCatalog(models, config.capacityTargets);
  const targetService = new TargetService([...config.capacityTargets], reservationRepository.capacityTargets, catalog, config.capacityTargets, reservationRepository.targetModelDiscoveries);
  await targetService.initialize();
  const targetProvisioningService = new TargetProvisioningService(reservationRepository.targetProvisioningJobs);
  const reservations = reservationRepository.repository;
  const statuses = new InMemoryTargetStatusRepository();
  const providerAdapter =
    process.env.USE_FAKE_PROVIDER === "true"
      ? new FakeCapacityProvider()
        : new CompositeCapacityProvider({
          "aws-ecs": new AwsEcsAsgCapacityProvider(config.awsRegion),
          docker: new DockerContainerCapacityProvider(),
          "docker-compose": new DockerComposeCapacityProvider(),
          neuron: new NeuronCapacityProvider(),
          runpod: new RunPodCapacityProvider()
        }, providerCatalog);
  const hassleOffClient = config.hassleOff ? new HassleOffClient(config.hassleOff) : undefined;
  const interlockedProvider = new HassleOffCapacityProvider(providerAdapter, hassleOffClient);
  const capacityProvider = new ActivateOrReprovisionCapacityProvider(interlockedProvider, {
    canPersistReplacement: (targetId) => targetService.canPersistReplacementPatch(targetId),
    applyReplacementPatch: (targetId, patch) => targetService.applyReplacementPatch(targetId, patch)
  });
  const backendConfigSync = config.litellmApiBaseUrl && config.litellmApiKey ? new LiteLlmBackendConfigSync(config.litellmApiBaseUrl, config.litellmApiKey) : new NoopBackendConfigSync();
  const reservationProfileService = new ReservationProfileService(reservationRepository.reservationProfiles, catalog);
  const reservationService = new ReservationService(reservations, catalog, reservationRepository.reservationProfiles);
  const apiKeyService = new ApiKeyService(apiKeys);
  const trafficKeepalive = new TrafficKeepaliveService(reservations, statuses);
  const healthChecker = new HealthChecker(config.healthCheckTimeoutSeconds);
  const runtimeModelDiscovery = new RuntimeModelDiscovery(catalog, reservationRepository.targetModelDiscoveries);
  await runtimeModelDiscovery.hydrateCachedTargets();
  const modelWarmup = new ModelWarmupService(catalog);
  const costEstimation = new CostEstimationService(reservationRepository.targetActivations, capacityProvider);
  const trafficPoller =
    config.litellmApiBaseUrl && config.litellmApiKey && config.litellmTrafficPollSeconds > 0
      ? new TrafficPoller(new LiteLlmSpendLogsTrafficSource(config.litellmApiBaseUrl, config.litellmApiKey, config.litellmTrafficLookbackSeconds), catalog, trafficKeepalive)
      : undefined;
  const reconciler = new Reconciler(
    config.capacityTargets,
    reservations,
    statuses,
    capacityProvider,
    backendConfigSync,
    healthChecker,
    runtimeModelDiscovery,
    modelWarmup,
    trafficPoller,
    costEstimation
  );

  await app.register(cookie);
  await app.register(formbody);
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "NeurOn",
        version: "0.1.0",
        description: "Internal control plane API for reserving shared self-hosted LLM capacity."
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "sk-neuron" },
          basicAuth: { type: "http", scheme: "basic" }
        }
      }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.addHook("onClose", async () => reservationRepository.close());

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/login" || request.url.startsWith("/auth/") || request.url === "/openapi.json" || request.url.startsWith("/docs")) return;
    const user = await authProvider.authenticate({ headers: request.headers, cookies: request.cookies });
    if (!user) {
      if (request.url.startsWith("/api/")) return reply.code(401).send({ error: "Authentication required" });
      return reply.redirect("/login");
    }
    if ((request.url.startsWith("/admin") || request.url.startsWith("/api/admin/")) && !user.isAdmin) {
      if (request.url.startsWith("/api/")) return reply.code(403).send({ error: "Admin access required" });
      return reply.code(403).type("text/html").send("Admin access required");
    }
    request.user = user;
  });

  registerApiRoutes(app, catalog, reservations, statuses, apiKeyService, reservationService, reservationProfileService, trafficKeepalive, reconciler, capacityProvider, runtimeModelDiscovery, healthChecker, targetService, targetProvisioningService, costEstimation, reservationRepository.targetActivations);
  registerMcpRoutes(app, catalog, reservations, statuses, reservationService);
  registerUiRoutes(app, config, authProvider, authMethodService, catalog, apiKeyService, reservationService, reservationProfileService, providerService, targetService, targetProvisioningService, costEstimation);

  const bootstrapRuntimeModels = async () => {
    for (const target of catalog.listTargets().filter(shouldBootstrapRuntimeModels)) {
      try {
        statuses.set({ targetId: target.id, desired: "on", observed: "starting", message: "Runtime model discovery bootstrap starting", lastCheckedAt: new Date() });
        await runtimeModelDiscovery.bootstrapTarget(target, capacityProvider, healthChecker);
        statuses.set({ targetId: target.id, desired: "off", observed: "stopped", message: "Runtime model discovery bootstrap complete", lastCheckedAt: new Date() });
        app.log.info({ targetId: target.id }, "runtime model discovery bootstrap complete");
      } catch (error) {
        const loggedError = errorForLog(error);
        statuses.set({ targetId: target.id, desired: "off", observed: "failed", message: `Runtime model discovery bootstrap failed: ${loggedError.message}`, lastCheckedAt: new Date() });
        app.log.warn({ targetId: target.id, error: loggedError }, "runtime model discovery bootstrap failed");
      }
    }
  };

  return { app, reconciler, trafficPoller, bootstrapRuntimeModels };
}

function errorForLog(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { message: String(error) };
}
