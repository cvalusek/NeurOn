import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig, CapacityProviderDefinition, CapacityTarget, RuntimeProfile } from "../domain/types.js";
import { SharedPasswordAuthProvider } from "../auth/SharedPasswordAuthProvider.js";
import { ApiKeyService } from "../services/ApiKeyService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ProviderService } from "../services/ProviderService.js";
import { ReservationService } from "../services/ReservationService.js";
import { TargetService } from "../services/TargetService.js";
import { TargetProvisioningService } from "../services/TargetProvisioningService.js";
import { adminPage, apiKeysPage, loginPage, providerAdminPage, reservationPage, startPage, targetAdminPage } from "../ui/html.js";
import { requireUser } from "../utils/http.js";

export function registerUiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authProvider: SharedPasswordAuthProvider,
  catalog: ModelCatalog,
  apiKeyService: ApiKeyService,
  reservationService: ReservationService,
  providerService: ProviderService,
  targetService: TargetService,
  targetProvisioningService: TargetProvisioningService
) {
  app.get("/login", async (_request, reply) => reply.type("text/html").send(loginPage()));
  app.post("/login", async (request, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string() }).parse(request.body);
    if (body.password !== config.sharedPassword || !config.cookieSecret) return reply.code(401).type("text/html").send(loginPage("Invalid credentials"));
    reply.setCookie("llm_control_auth", authProvider.createCookie(body.username), { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/");
  });

  app.get("/", async (request, reply) => {
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    const targets = catalog.listTargets().map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    return reply.type("text/html").send(startPage(requireUser(request), targets, query.error));
  });
  app.get("/api-keys", async (request, reply) => {
    const user = requireUser(request);
    return reply.type("text/html").send(apiKeysPage(user, await apiKeyService.listForUser(user)));
  });
  app.post("/api-keys", async (request, reply) => {
    const user = requireUser(request);
    const body = z.object({ name: z.string().default("Plugin key") }).parse(request.body ?? {});
    const created = await apiKeyService.createForUser(user, body);
    return reply.type("text/html").send(apiKeysPage(user, await apiKeyService.listForUser(user), created.token));
  });
  app.post("/api-keys/:id/revoke", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await apiKeyService.revokeForUser(requireUser(request), id);
    return reply.redirect("/api-keys");
  });
  app.post("/reservations", async (request, reply) => {
    try {
      const raw = z
        .object({
          modelIds: z.union([z.string(), z.array(z.string())]).optional(),
          targetId: z.string(),
          durationMinutes: z.coerce.number(),
          keepaliveMinutes: z.coerce.number().optional()
        })
        .parse(request.body);
      const modelIds = raw.modelIds ? (Array.isArray(raw.modelIds) ? raw.modelIds : [raw.modelIds]) : [];
      await reservationService.createForUser(requireUser(request), { modelIds, targetIds: [raw.targetId], durationMinutes: raw.durationMinutes, keepaliveMinutes: raw.keepaliveMinutes });
      return reply.redirect("/");
    } catch (error) {
      const message = reservationFormErrorMessage(error);
      return reply.redirect(`/?error=${encodeURIComponent(message)}`);
    }
  });
  app.get("/reservations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await reservationService.getOwned(id, requireUser(request));
    return reply.type("text/html").send(reservationPage(requireUser(request), reservation, config));
  });
  app.post("/reservations/:id/done", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await reservationService.markDone(id, requireUser(request));
    return reply.redirect("/");
  });
  app.post("/reservations/:id/extend", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ durationMinutes: z.coerce.number() }).parse(request.body);
    await reservationService.extend(id, requireUser(request), body.durationMinutes);
    return reply.redirect("/");
  });
  app.get("/admin", async (request, reply) => reply.type("text/html").send(adminPage(requireUser(request), config)));
  app.get("/admin/providers", async (request, reply) => {
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    return reply.type("text/html").send(providerAdminPage(requireUser(request), await providerService.list(), await targetService.list(), config.runtimeProfiles, query.error));
  });
  app.post("/admin/providers", async (request, reply) => {
    try {
      const body = providerFormSchema.parse(request.body ?? {});
      await providerService.create({
        id: body.id,
        displayName: body.displayName || body.id,
        type: body.type,
        provisioning: { enabled: body.provisioningEnabled === "on" }
      });
      return reply.redirect("/admin/providers");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create provider";
      return reply.redirect(`/admin/providers?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/providers/:id/update", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = providerFormSchema.parse(request.body ?? {});
      await providerService.update(id, {
        id: body.id,
        displayName: body.displayName || body.id,
        type: body.type,
        provisioning: { enabled: body.provisioningEnabled === "on" }
      });
      return reply.redirect("/admin/providers");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update provider";
      return reply.redirect(`/admin/providers?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/providers/:id/delete", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ confirmName: z.string().optional() }).parse(request.body ?? {});
      if (body.confirmName !== id) throw new Error(`Type ${id} to delete this provider`);
      await providerService.delete(id);
      return reply.redirect("/admin/providers");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete provider";
      return reply.redirect(`/admin/providers?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/providers/:id/copy-to-db", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await providerService.copyConfiguredToPersistence(id);
      return reply.redirect("/admin/providers");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not copy provider";
      return reply.redirect(`/admin/providers?error=${encodeURIComponent(message)}`);
    }
  });
  app.get("/admin/targets", async (request, reply) => {
    const query = z.object({ error: z.string().optional(), created: z.string().optional() }).parse(request.query);
    return reply.type("text/html").send(targetAdminPage(requireUser(request), await targetService.list(), await providerService.list(), config.runtimeProfiles, query.error, query.created));
  });
  app.post("/admin/targets", async (request, reply) => {
    try {
      const body = targetFormSchema.parse(request.body ?? {});
      const provider = await providerFromForm(body.providerId, providerService);
      const target = await targetService.create(targetFromForm(body, provider, config));
      await targetProvisioningService.createDraft({
        providerId: target.providerId ?? target.provider,
        providerType: target.provider,
        runtimeProfileId: body.runtimeProfileId,
        target
      });
      return reply.redirect(`/admin/targets?created=${encodeURIComponent(target.id)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create target";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/targets/:id/update", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = targetFormSchema.parse(request.body ?? {});
      const provider = await providerFromForm(body.providerId, providerService);
      await targetService.update(id, targetFromForm(body, provider, config));
      return reply.redirect("/admin/targets");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update target";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/targets/:id/delete", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ confirmName: z.string().optional() }).parse(request.body ?? {});
      if (body.confirmName !== id) throw new Error(`Type ${id} to delete this target`);
      await targetService.delete(id);
      return reply.redirect("/admin/targets");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete target";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/targets/:id/copy-to-db", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await targetService.copyConfiguredToPersistence(id);
      return reply.redirect("/admin/targets");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not copy target";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/targets/:id/abort-provisioning", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await targetProvisioningService.abort(id);
      return reply.redirect("/admin/targets");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not abort target provisioning";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
}

const providerFormSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  type: z.string().min(1),
  provisioningEnabled: z.string().optional()
});

const optionalNumber = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().optional());

const targetFormSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  providerId: z.string().min(1),
  modelIds: z.string().optional(),
  runtimeProfileId: z.string().optional(),
  healthUrl: z.string().optional(),
  apiUrl: z.string().optional(),
  runpodPodId: z.string().optional(),
  runpodRuntimePort: optionalNumber,
  awsCluster: z.string().optional(),
  awsService: z.string().optional(),
  awsAsgName: z.string().optional(),
  dockerContainerName: z.string().optional(),
  dockerModelVolume: z.string().optional(),
  neuronTargetId: z.string().optional()
});

async function providerFromForm(providerId: string, providerService: ProviderService): Promise<CapacityProviderDefinition> {
  const provider = (await providerService.list()).find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  return provider;
}

function targetFromForm(body: z.infer<typeof targetFormSchema>, provider: CapacityProviderDefinition, config?: AppConfig): CapacityTarget {
  const profile = config?.runtimeProfiles.find((candidate) => candidate.id === body.runtimeProfileId);
  const target: Record<string, unknown> = {};
  target.id = body.id;
  target.displayName = body.displayName || body.id;
  target.provider = provider.type;
  target.providerId = provider.id;
  target.modelIds = listField(body.modelIds);
  if (profileDiscovery(profile)) target.modelDiscovery = { bootstrapOnStartup: true };
  if (body.healthUrl) target.healthUrl = body.healthUrl;
  if (body.apiUrl) target.apiUrl = body.apiUrl;
  if (provider.type === "runpod" && (body.runpodPodId || body.runpodRuntimePort)) {
    const create = runpodCreateFromProfile(profile);
    target.runpod = {
      ...(typeof target.runpod === "object" && target.runpod !== null && !Array.isArray(target.runpod) ? target.runpod : {}),
      ...(body.runpodPodId ? { podId: body.runpodPodId } : {}),
      runtimePort: body.runpodRuntimePort ?? profilePort(profile),
      ...(create ? { create } : {})
    };
  }
  if (provider.type === "runpod" && !target.runpod && profile) {
    const create = runpodCreateFromProfile(profile);
    target.runpod = {
      runtimePort: profilePort(profile),
      ...(create ? { create } : {})
    };
  }
  if ((provider.type === "aws-ecs" || provider.type === "aws-ecs-asg") && body.awsCluster && body.awsService && body.awsAsgName) {
    target.aws = {
      ...(typeof target.aws === "object" && target.aws !== null && !Array.isArray(target.aws) ? target.aws : {}),
      cluster: body.awsCluster,
      service: body.awsService,
      autoScalingGroupName: body.awsAsgName
    };
  }
  if (provider.type === "docker" && body.dockerContainerName) {
    const port = profilePort(profile);
    const profileVolumes = profileDockerVolumes(profile);
    const modelMountPath = profileVolumes[0]?.containerPath;
    const modelVolume = (body.dockerModelVolume || profileVolumes[0]?.volumeName || "").trim();
    target.docker = {
      ...(typeof target.docker === "object" && target.docker !== null && !Array.isArray(target.docker) ? target.docker : {}),
      containerName: body.dockerContainerName,
      ...(profile?.image ? { image: profile.image } : {}),
      ...(profile ? { ports: [`${port}:${port}`] } : {}),
      ...(modelVolume && modelMountPath ? { volumes: [`${modelVolume}:${modelMountPath}`] } : {}),
      ...(profile?.env ? { environment: profile.env } : {})
    };
    target.healthUrl ??= dockerUrl(port, profileHealth(profile));
    target.apiUrl ??= dockerUrl(port, profileApi(profile));
  }
  if (provider.type === "neuron" && body.neuronTargetId) {
    target.neuron = { targetId: body.neuronTargetId };
  }
  return target as unknown as CapacityTarget;
}

function profilePort(profile: RuntimeProfile | undefined): number {
  return profile?.port ?? 8080;
}

function profileHealth(profile: RuntimeProfile | undefined): string {
  return profile?.health ?? "/health";
}

function profileApi(profile: RuntimeProfile | undefined): string {
  return profile?.api ?? "/v1";
}

function profileDockerVolumes(profile: RuntimeProfile | undefined): Array<{ containerPath: string; volumeName: string }> {
  return Object.entries(profile?.volumes ?? {}).map(([containerPath, volumeName]) => ({ containerPath, volumeName }));
}

function dockerUrl(port: number, path: string): string {
  return `http://host.docker.internal:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

function profileDiscovery(profile: RuntimeProfile | undefined): boolean {
  return profile ? profile.discovery ?? true : false;
}

function runpodCreateFromProfile(profile: RuntimeProfile | undefined): Record<string, unknown> | undefined {
  if (!profile?.image || profile.type !== "docker") return undefined;
  return { imageName: profile.image };
}

function listField(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function reservationFormErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError && error.issues.some((issue) => issue.path.includes("modelIds"))) {
    return "Select at least one model";
  }
  if (error instanceof Error && error.message.includes("At least one model")) {
    return "Select at least one model";
  }
  if (error instanceof Error && error.message.includes("At least one target")) {
    return "Select a target";
  }
  if (error instanceof Error && error.message.includes("Duration")) {
    return error.message;
  }
  if (error instanceof Error && error.message.includes("Keepalive")) {
    return error.message;
  }
  return "Could not create reservation";
}
