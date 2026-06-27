import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { SharedPasswordAuthProvider } from "./auth/SharedPasswordAuthProvider.js";
import { AwsEcsAsgCapacityProvider } from "./capacity/AwsEcsAsgCapacityProvider.js";
import { CompositeCapacityProvider } from "./capacity/CompositeCapacityProvider.js";
import { DockerContainerCapacityProvider } from "./capacity/DockerContainerCapacityProvider.js";
import { DockerComposeCapacityProvider } from "./capacity/DockerComposeCapacityProvider.js";
import { FakeCapacityProvider } from "./capacity/FakeCapacityProvider.js";
import { RunPodCapacityProvider } from "./capacity/RunPodCapacityProvider.js";
import type { AppConfig, ModelDefinition } from "./domain/types.js";
import { LiteLlmSpendLogsTrafficSource } from "./litellm/LiteLlmSpendLogsTrafficSource.js";
import { LiteLlmBackendConfigSync, NoopBackendConfigSync } from "./litellm/LiteLlmBackendConfigSync.js";
import { HealthChecker } from "./reconciler/HealthChecker.js";
import { Reconciler } from "./reconciler/Reconciler.js";
import { InMemoryTargetStatusRepository } from "./repository/InMemoryTargetStatusRepository.js";
import { createReservationRepository } from "./repository/createReservationRepository.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerUiRoutes } from "./routes/ui.js";
import { ModelCatalog } from "./services/ModelCatalog.js";
import { ReservationService } from "./services/ReservationService.js";
import { RuntimeModelDiscovery } from "./services/RuntimeModelDiscovery.js";
import { TrafficKeepaliveService } from "./services/TrafficKeepaliveService.js";
import { TrafficPoller } from "./services/TrafficPoller.js";

export async function buildApp(config: AppConfig, models: ModelDefinition[]) {
  const app = Fastify({ logger: true });
  const authProvider = new SharedPasswordAuthProvider(config.sharedPassword, config.adminUsers, config.cookieSecret);
  const catalog = new ModelCatalog(models, config.capacityTargets);
  const reservationRepository = await createReservationRepository(config.storage);
  const reservations = reservationRepository.repository;
  const statuses = new InMemoryTargetStatusRepository();
  const capacityProvider =
    process.env.USE_FAKE_PROVIDER === "true"
      ? new FakeCapacityProvider()
        : new CompositeCapacityProvider({
          "aws-ecs": new AwsEcsAsgCapacityProvider(config.awsRegion),
          docker: new DockerContainerCapacityProvider(),
          "docker-compose": new DockerComposeCapacityProvider(),
          runpod: new RunPodCapacityProvider()
        });
  const backendConfigSync = config.litellmApiBaseUrl && config.litellmApiKey ? new LiteLlmBackendConfigSync(config.litellmApiBaseUrl, config.litellmApiKey) : new NoopBackendConfigSync();
  const reservationService = new ReservationService(reservations, catalog);
  const trafficKeepalive = new TrafficKeepaliveService(reservations, statuses);
  const healthChecker = new HealthChecker(config.healthCheckTimeoutSeconds);
  const runtimeModelDiscovery = new RuntimeModelDiscovery(catalog);
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
    trafficPoller
  );

  await app.register(cookie);
  await app.register(formbody);
  await app.register(swagger, { openapi: { info: { title: "NeurOn", version: "0.1.0" } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.addHook("onClose", async () => reservationRepository.close());

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/login" || request.url.startsWith("/docs")) return;
    const user = await authProvider.authenticate({ headers: request.headers, cookies: request.cookies });
    if (!user) {
      if (request.url.startsWith("/api/")) return reply.code(401).send({ error: "Authentication required" });
      return reply.redirect("/login");
    }
    request.user = user;
  });

  registerApiRoutes(app, catalog, reservations, statuses, reservationService, trafficKeepalive, reconciler, capacityProvider, runtimeModelDiscovery, healthChecker);
  registerUiRoutes(app, config, authProvider, catalog, reservationService);

  const bootstrapRuntimeModels = async () => {
    for (const target of config.capacityTargets.filter(shouldBootstrapRuntimeModels)) {
      try {
        statuses.set({ targetId: target.id, desired: "on", observed: "provisioning", message: "Runtime model discovery bootstrap starting", lastCheckedAt: new Date() });
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

export function shouldBootstrapRuntimeModels(target: { modelIds: string[]; models?: unknown[]; modelDiscovery?: { bootstrapOnStartup?: boolean } }): boolean {
  if (target.modelDiscovery?.bootstrapOnStartup === false) return false;
  if (target.modelDiscovery?.bootstrapOnStartup === true) return true;
  return target.modelIds.length === 0 && (target.models?.length ?? 0) === 0;
}
