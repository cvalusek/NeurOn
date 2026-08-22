import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { IdentityAuthProvider } from "./auth/IdentityAuthProvider.js";
import { AuthSecretResolver } from "./auth/AuthSecretResolver.js";
import { OidcAuthService } from "./auth/OidcAuthService.js";
import { AwsEc2CapacityProvider } from "./capacity/AwsEc2CapacityProvider.js";
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
import { ModelSelectionService } from "./services/ModelSelectionService.js";
import { ModelFavoriteService } from "./services/ModelFavoriteService.js";
import { UsageAnalyticsService } from "./services/UsageAnalyticsService.js";
import { IdentityService } from "./services/IdentityService.js";
import { ModelBenchmarkService } from "./services/ModelBenchmarkService.js";
import { ProfileAdvisorService } from "./services/ProfileAdvisorService.js";
import { ProviderCatalog } from "./services/ProviderCatalog.js";
import { ProviderService } from "./services/ProviderService.js";
import { CostEstimationService } from "./services/CostEstimationService.js";
import { ReservationService } from "./services/ReservationService.js";
import { ReservationProfileService } from "./services/ReservationProfileService.js";
import { RuntimeModelDiscovery, shouldBootstrapRuntimeModels, type StartupRuntimeModelDiscoveryOutcome } from "./services/RuntimeModelDiscovery.js";
import { TargetOperationCoordinator } from "./services/TargetOperationCoordinator.js";
import { TargetProvisioningService } from "./services/TargetProvisioningService.js";
import { TargetService } from "./services/TargetService.js";
import { TrafficKeepaliveService } from "./services/TrafficKeepaliveService.js";
import { TrafficPoller } from "./services/TrafficPoller.js";
import { ShutdownCoordinator } from "./services/ShutdownCoordinator.js";
import { UpdateChecker } from "./services/UpdateChecker.js";
import { HassleOffCapacityProvider } from "./safety/HassleOffCapacityProvider.js";
import { HassleOffClient } from "./safety/HassleOffClient.js";

export interface BuildAppOptions {
  requestShutdown?: (reason: string) => void | Promise<void>;
  /** Programmatic test/documentation fixture only. Production bootstrapping uses the explicit users command. */
  developmentLocalAccounts?: Array<{ username: string; password: string; owner?: boolean }>;
}

export async function buildApp(config: AppConfig, models: ModelDefinition[], options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const reservationRepository = await createReservationRepository(config.storage);
  const identityService = new IdentityService(reservationRepository.identities);
  await identityService.initialize(config.adminUsers);
  for (const account of options.developmentLocalAccounts ?? []) {
    let user = await reservationRepository.identities.getUserByUsername(account.username);
    if (!user) user = await reservationRepository.identities.createUser({ username: account.username, status: "active" });
    await identityService.setPassword(user.id, account.password);
    if (account.owner || config.adminUsers.some((username) => username.toLocaleLowerCase("en-US") === account.username.toLocaleLowerCase("en-US"))) {
      await reservationRepository.identities.assignGlobalRole(user.id, "role_owner");
    }
  }
  const apiKeys = reservationRepository.apiKeys;
  const authMethodService = new AuthMethodService(config.authMethods, reservationRepository.authMethods, reservationRepository.identities);
  await authMethodService.initialize();
  const providerCatalog = new ProviderCatalog(config.capacityProviders);
  const providerService = new ProviderService(config.capacityProviders, reservationRepository.capacityProviders, providerCatalog);
  await providerService.initialize();
  const authProvider = new IdentityAuthProvider(identityService, config.cookieSecret, apiKeys, () => authMethodService.localEnabled());
  const oidcAuthService = new OidcAuthService(new AuthSecretResolver(config.awsRegion));
  const catalog = new ModelCatalog(models, config.capacityTargets);
  const targetService = new TargetService([...config.capacityTargets], reservationRepository.capacityTargets, catalog, config.capacityTargets, reservationRepository.targetModelDiscoveries);
  await targetService.initialize();
  identityService.onUsersMerged((sourceUserId, targetUserId) => {
    for (const target of catalog.listTargets()) {
      if (target.audience?.scope !== "users" || !target.audience.userIds.includes(sourceUserId)) continue;
      catalog.upsertTarget({
        ...target,
        audience: { scope: "users", userIds: Array.from(new Set(target.audience.userIds.map((id) => id === sourceUserId ? targetUserId : id))) }
      });
    }
  });
  const targetProvisioningService = new TargetProvisioningService(reservationRepository.targetProvisioningJobs);
  const reservations = reservationRepository.repository;
  const statuses = new InMemoryTargetStatusRepository();
  const providerAdapter =
    process.env.USE_FAKE_PROVIDER === "true"
      ? new FakeCapacityProvider()
        : new CompositeCapacityProvider({
          "aws-ec2": new AwsEc2CapacityProvider(config.awsRegion),
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
  const reservationProfileService = new ReservationProfileService(reservationRepository.reservationProfiles, catalog, identityService);
  const apiKeyService = new ApiKeyService(apiKeys, identityService);
  const trafficKeepalive = new TrafficKeepaliveService(reservations, statuses);
  const healthChecker = new HealthChecker(config.healthCheckTimeoutSeconds);
  const targetOperations = new TargetOperationCoordinator();
  const runtimeModelDiscovery = new RuntimeModelDiscovery(
    catalog,
    reservationRepository.targetModelDiscoveries,
    targetOperations,
    statuses,
    backendConfigSync,
    (target, error) => app.log.warn(
      { targetId: target.id, error: errorForLog(error) },
      "LiteLLM discovered-model synchronization failed"
    )
  );
  const startupDiscoveryRequestedTargetIds = new Set(
    catalog.listTargets().filter(shouldBootstrapRuntimeModels).map((target) => target.id)
  );
  await runtimeModelDiscovery.hydrateCachedTargets();
  const modelSelection = new ModelSelectionService(catalog, config.modelSelectionCatalog, reservationRepository.modelMetadata);
  await modelSelection.initialize();
  runtimeModelDiscovery.setBenchmarkService(new ModelBenchmarkService(catalog, modelSelection));
  const modelFavorites = new ModelFavoriteService(reservationRepository.modelFavorites, catalog, identityService);
  const usageAnalytics = new UsageAnalyticsService(reservations, reservationRepository.reservationProfiles, reservationRepository.targetActivations, catalog);
  const modelWarmup = new ModelWarmupService(catalog);
  const costEstimation = new CostEstimationService(
    reservationRepository.targetActivations,
    config.maintenanceMode ? undefined : capacityProvider,
    reservations
  );
  const trafficPoller =
    config.litellmApiBaseUrl && config.litellmApiKey && config.litellmTrafficPollSeconds > 0
      ? new TrafficPoller(new LiteLlmSpendLogsTrafficSource(config.litellmApiBaseUrl, config.litellmApiKey, config.litellmTrafficLookbackSeconds), catalog, trafficKeepalive, modelSelection, identityService)
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
    costEstimation,
    targetOperations
  );
  const shutdownControl: { current?: ShutdownCoordinator } = {};
  const reservationService = new ReservationService(
    reservations,
    catalog,
    reservationRepository.reservationProfiles,
    config.maintenanceMode
      ? undefined
      : () => {
          void reconciler.requestReconcile().catch((error) =>
            app.log.error(
              { error: errorForLog(error) },
              "Reservation-triggered reconciliation failed"
            )
          );
        },
    () => shutdownControl.current?.acceptingReservations() ?? true,
    identityService
  );
  const profileAdvisor = new ProfileAdvisorService({
    assistantConfig: reservationRepository.assistantConfig,
    catalog,
    reservationService,
    statuses,
    capacityProvider,
    availableDomains: () => modelSelection.availableDomains(),
    availableDeployments: async (user) => {
      const candidateTargets = user
        ? (await Promise.all(catalog.listTargets().map(async (target) => await identityService.canAccessTarget(user, target) ? target : undefined))).filter((target): target is NonNullable<typeof target> => Boolean(target))
        : catalog.listTargets();
      const costs: Record<string, { hourlyUsd: number }> = {};
      await Promise.all(candidateTargets.map(async (target) => {
        const estimate = await costEstimation.resolveTargetCostEstimate(target);
        if (estimate?.hourlyUsd !== undefined) costs[target.id] = { hourlyUsd: estimate.hourlyUsd };
      }));
      const targetIds = new Set(candidateTargets.map((target) => target.id));
      return modelSelection.listDeployments(costs).filter((deployment) => targetIds.has(deployment.targetId));
    }
  });
  targetOperations.setDemandController({
    hasDemand: (targetId) => reconciler.hasDemand(targetId),
    reconcileTarget: (targetId) => reconciler.reconcileTarget(targetId)
  });
  const updateChecker = new UpdateChecker(config.updates ?? {
    enabled: false,
    repository: "cvalusek/NeurOn",
    checkIntervalSeconds: 900
  });
  const shutdownCoordinator = new ShutdownCoordinator({
    reservations,
    targets: () => catalog.listTargets(),
    statuses,
    capacityProvider,
    reconciler,
    targetOperations,
    activeDemandMutations: () => reservationService.activeDemandMutationCount(),
    stopTrafficPolling: () => trafficPoller?.stop(),
    resumeLifecycle: () => {
      if (config.maintenanceMode) return;
      trafficPoller?.start(config.litellmTrafficPollSeconds);
      reconciler.start(config.reconcilerIntervalSeconds);
    },
    requestShutdown: options.requestShutdown ?? (() => undefined)
  });
  shutdownControl.current = shutdownCoordinator;

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
  app.addHook("onClose", async () => {
    shutdownCoordinator?.stop();
    await reservationRepository.close();
  });

  app.addHook("preHandler", async (request, reply) => {
    const mutationAllowedInMaintenance = request.url === "/login" || request.url === "/logout" || request.url.startsWith("/auth/") || request.url.startsWith("/register");
    if (
      config.maintenanceMode &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !mutationAllowedInMaintenance
    ) {
      if (request.url.startsWith("/api/") || request.url === "/mcp") {
        return reply.code(503).send({ error: "NeurOn is in maintenance mode; state changes are disabled" });
      }
      return reply.code(503).type("text/html").send("NeurOn is in maintenance mode; state changes are disabled");
    }
    if (request.url === "/healthz" || request.url === "/login" || request.url === "/logout" || request.url.startsWith("/auth/") || request.url.startsWith("/register") || request.url === "/openapi.json" || request.url.startsWith("/docs")) return;
    const user = await authProvider.authenticate({ headers: request.headers, cookies: request.cookies });
    if (!user) {
      if (request.url.startsWith("/api/")) return reply.code(401).send({ error: "Authentication required" });
      return reply.redirect("/login");
    }
    const permission = adminPermissionFor(request.method, request.url);
    if (permission && !identityService.hasPermission(user, permission)) {
      if (request.url.startsWith("/api/")) return reply.code(403).send({ error: `Permission required: ${permission}` });
      return reply.code(403).type("text/html").send("You do not have permission to use this administrative screen");
    }
    request.user = user;
    if (shutdownCoordinator?.isDraining() && shutdownUnsafeMutation(request.method, request.url)) {
      const message = "NeurOn is draining for restart; operations that can create demand are temporarily disabled";
      if (request.url.startsWith("/api/") || request.url === "/mcp") return reply.code(503).send({ error: message });
      return reply.code(503).type("text/html").send(message);
    }
  });

  registerApiRoutes(
    app,
    catalog,
    reservations,
    statuses,
    apiKeyService,
    reservationService,
    reservationProfileService,
    trafficKeepalive,
    reconciler,
    capacityProvider,
    runtimeModelDiscovery,
    healthChecker,
    targetService,
    targetProvisioningService,
    costEstimation,
    reservationRepository.targetActivations,
    targetOperations,
    { storageDriver: config.storage.driver, maintenanceMode: Boolean(config.maintenanceMode) },
    modelSelection,
    profileAdvisor,
    modelFavorites,
    usageAnalytics,
    identityService
  );
  registerMcpRoutes(app, catalog, reservations, statuses, reservationService, identityService);
  registerUiRoutes(
    app,
    config,
    authProvider,
    authMethodService,
    oidcAuthService,
    updateChecker,
    shutdownCoordinator,
    catalog,
    apiKeyService,
    reservationService,
    reservationProfileService,
    providerService,
    targetService,
    targetProvisioningService,
    costEstimation,
    capacityProvider,
    config.maintenanceMode ? undefined : hassleOffClient,
    modelSelection,
    profileAdvisor,
    modelFavorites,
    usageAnalytics,
    identityService
  );

  const bootstrapRuntimeModels = async (): Promise<StartupRuntimeModelDiscoveryOutcome[]> => {
    const outcomes: StartupRuntimeModelDiscoveryOutcome[] = [];
    const recordOutcome = (outcome: StartupRuntimeModelDiscoveryOutcome) => {
      runtimeModelDiscovery.recordStartupOutcome(outcome);
      outcomes.push(outcome);
    };
    for (const target of catalog.listTargets().filter((candidate) => startupDiscoveryRequestedTargetIds.has(candidate.id))) {
      const cachedDiscoveredAt = runtimeModelDiscovery.cachedDiscoveryAt(target.id);
      if (cachedDiscoveredAt) {
        const discoveredAt = cachedDiscoveredAt.toISOString();
        const reason = `Reused persisted runtime model discovery from ${discoveredAt}; startup discovery did not contact the capacity provider.`;
        recordOutcome({ targetId: target.id, outcome: "skipped-cached", reason, cachedDiscoveredAt: discoveredAt });
        app.log.info(
          { targetId: target.id, outcome: "skipped-cached", cachedDiscoveredAt: discoveredAt, reason },
          "runtime model discovery bootstrap skipped because cached discovery is available"
        );
        continue;
      }
      try {
        await runtimeModelDiscovery.bootstrapTarget(target, capacityProvider, healthChecker);
        recordOutcome({ targetId: target.id, outcome: "discovered", reason: "Runtime model discovery bootstrap completed." });
        app.log.info({ targetId: target.id }, "runtime model discovery bootstrap complete");
      } catch (error) {
        const loggedError = errorForLog(error);
        recordOutcome({ targetId: target.id, outcome: "failed", reason: loggedError.message });
        app.log.warn({ targetId: target.id, error: loggedError }, "runtime model discovery bootstrap failed");
      }
    }
    return outcomes;
  };

  return { app, reconciler, trafficPoller, bootstrapRuntimeModels, runtimeModelDiscovery, targetOperations, updateChecker, shutdownCoordinator, identityService, authProvider };
}

function adminPermissionFor(method: string, url: string): string | undefined {
  if (!url.startsWith("/admin") && !url.startsWith("/api/admin/")) return undefined;
  if (url.startsWith("/api/admin/users/merge") || url.startsWith("/admin/users/merge")) return "users.merge";
  if (url.startsWith("/admin/users") || url.startsWith("/api/admin/users")) return "users.manage";
  if (url.startsWith("/api/admin/external-users")) return "users.manage";
  if (url.startsWith("/admin/roles") || url.startsWith("/api/admin/roles")) return "roles.manage";
  if (url.startsWith("/admin/teams") || url.startsWith("/api/admin/teams")) return "teams.manage";
  if (url.startsWith("/admin/auth")) return "auth.manage";
  if (/^\/api\/admin\/targets\/[^/]+\/discover(?:\?|$)/.test(url)) return "discovery.run";
  if (url.startsWith("/admin/targets") || url.startsWith("/admin/providers") || url.startsWith("/api/admin/targets") || url.startsWith("/api/admin/providers")) return "targets.manage";
  if (url.startsWith("/admin/models") || url.startsWith("/api/admin/model-metadata")) return method === "GET" ? "targets.read_all" : "discovery.run";
  if (url.startsWith("/admin/assistant") || url.startsWith("/api/admin/assistant")) return "assistant.configure";
  if (url.startsWith("/admin/usage") || url.startsWith("/admin/reservations") || url.startsWith("/admin/activations") || url.startsWith("/api/admin/usage") || url.startsWith("/api/admin/status") || url.startsWith("/api/admin/reservations") || url.startsWith("/api/admin/activations")) return "reports.read_all";
  return "system.manage";
}

function errorForLog(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { message: String(error) };
}

function shutdownUnsafeMutation(method: string, url: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (url === "/api/internal/traffic") return true;
  if (url === "/reservations" || url === "/api/reservations") return true;
  if (/^\/(api\/)?reservations\/[^/]+\/extend$/.test(url)) return true;
  if (url.startsWith("/admin/providers")) return true;
  if (url.startsWith("/admin/targets") && !url.endsWith("/abort-provisioning")) return true;
  return /^\/api\/admin\/targets\/[^/]+\/(provision|discover)$/.test(url);
}
