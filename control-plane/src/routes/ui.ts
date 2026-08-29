import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig, AuthMethod, CapacityProviderDefinition, CapacityTarget, ReservationProfileSelection, RuntimeDeploymentPlan, RuntimeProfile } from "../domain/types.js";
import type { CapacityProvider } from "../domain/interfaces.js";
import { IdentityAuthProvider, SESSION_MAX_AGE_SECONDS } from "../auth/IdentityAuthProvider.js";
import { OidcAuthService, type OidcLoginState } from "../auth/OidcAuthService.js";
import { ShutdownCoordinator } from "../services/ShutdownCoordinator.js";
import { UpdateChecker } from "../services/UpdateChecker.js";
import { ApiKeyService } from "../services/ApiKeyService.js";
import { AuthMethodService } from "../services/AuthMethodService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import type { ModelSelectionService } from "../services/ModelSelectionService.js";
import type { ModelFavoriteService } from "../services/ModelFavoriteService.js";
import type { UsageAnalyticsService } from "../services/UsageAnalyticsService.js";
import type { ProfileAdvisorService } from "../services/ProfileAdvisorService.js";
import type { IdentityService } from "../services/IdentityService.js";
import type { MaintenanceControl } from "../services/MaintenanceControl.js";
import type { RuntimeCatalogService } from "../services/RuntimeCatalogService.js";
import { ProviderService } from "../services/ProviderService.js";
import { ReservationService } from "../services/ReservationService.js";
import { ReservationProfileService } from "../services/ReservationProfileService.js";
import { CostEstimationService } from "../services/CostEstimationService.js";
import { TargetService } from "../services/TargetService.js";
import { TargetProvisioningService } from "../services/TargetProvisioningService.js";
import type { HassleOffSafetyView } from "../ui/html.js";
import { activationPage, adminAuthPage, apiKeysPage, assistantConfigPage, clientSetupPage, hassleOffSafetyPage, loginPage, modelMetadataPage, profileEditorPage, profilesPage, providerAdminPage, registrationPage, reservationHistoryPage, reservationPage, startPage, targetAdminPage, teamAdminPage, updatesPage, usagePage, userAdminPage, welcomePage } from "../ui/html.js";
import { requireUser } from "../utils/http.js";
import type { HassleOffClient } from "../safety/HassleOffClient.js";

export function registerUiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authProvider: IdentityAuthProvider,
  authMethodService: AuthMethodService,
  oidcAuthService: OidcAuthService,
  updateChecker: UpdateChecker,
  shutdownCoordinator: ShutdownCoordinator,
  catalog: ModelCatalog,
  apiKeyService: ApiKeyService,
  reservationService: ReservationService,
  reservationProfileService: ReservationProfileService,
  providerService: ProviderService,
  targetService: TargetService,
  targetProvisioningService: TargetProvisioningService,
  costEstimation: CostEstimationService,
  capacityProvider: CapacityProvider,
  hassleOffClient: HassleOffClient | undefined,
  modelSelection: ModelSelectionService,
  profileAdvisor: ProfileAdvisorService,
  modelFavorites: ModelFavoriteService,
  usageAnalytics: UsageAnalyticsService,
  identityService: IdentityService,
  maintenanceControl: MaintenanceControl,
  runtimeCatalogs: RuntimeCatalogService
) {
  const localLoginAttempts = new Map<string, { failures: number; resetAt: number }>();
  const recordLocalLoginFailure = (attemptKey: string, now: number) => {
    if (localLoginAttempts.size >= 10_000) {
      for (const [key, attempt] of localLoginAttempts) if (attempt.resetAt <= now) localLoginAttempts.delete(key);
      if (localLoginAttempts.size >= 10_000) {
        const oldest = localLoginAttempts.keys().next().value as string | undefined;
        if (oldest) localLoginAttempts.delete(oldest);
      }
    }
    const current = localLoginAttempts.get(attemptKey);
    localLoginAttempts.set(attemptKey, { failures: (current?.failures ?? 0) + 1, resetAt: current?.resetAt ?? now + 10 * 60_000 });
  };
  const renderLoginPage = async (error = "") => {
    const [methods, localEnabled] = await Promise.all([authMethodService.listEnabled(), authMethodService.localEnabled()]);
    return loginPage(error, methods.filter((method) => method.type !== "local"), localEnabled);
  };
  const visibleTargetsFor = async (user: ReturnType<typeof requireUser>) => {
    const visible: CapacityTarget[] = [];
    for (const target of catalog.listTargets()) if (await identityService.canAccessTarget(user, target)) visible.push(target);
    return visible;
  };
  const selectionDeploymentsForUser = async (user: ReturnType<typeof requireUser>, costs: Record<string, { hourlyUsd: number }>) => {
    const [favorites, usage, visibleTargets] = await Promise.all([modelFavorites.listForUser(user), usageAnalytics.deploymentUsage(), visibleTargetsFor(user)]);
    const visibleTargetIds = new Set(visibleTargets.map((target) => target.id));
    const favoriteKeys = new Set(favorites.map((value) => `${value.targetId}::${value.modelId}`));
    const usageByKey = new Map(usage.map((value) => [`${value.targetId}::${value.modelId}`, value]));
    return modelSelection.listDeployments(costs).filter((deployment) => visibleTargetIds.has(deployment.targetId)).map((deployment) => ({ ...deployment, ...usageByKey.get(deployment.key), favorite: favoriteKeys.has(deployment.key) }));
  };
  app.get("/login", async (_request, reply) => reply.type("text/html").send(await renderLoginPage()));
  app.post("/login", async (request, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string() }).parse(request.body);
    if (!await authMethodService.localEnabled()) return reply.code(404).type("text/html").send(await renderLoginPage("Username and password sign-in is disabled"));
    const attemptKey = `${request.ip}\0${body.username.trim().toLocaleLowerCase("en-US")}`;
    const now = Date.now();
    const attempt = localLoginAttempts.get(attemptKey);
    if (attempt && attempt.resetAt > now && attempt.failures >= 8) return reply.code(429).type("text/html").send(await renderLoginPage("Too many sign-in attempts. Try again in a few minutes."));
    if (attempt?.resetAt && attempt.resetAt <= now) localLoginAttempts.delete(attemptKey);
    const user = await identityService.authenticateLocal(body.username, body.password);
    if (!user || !config.cookieSecret) {
      recordLocalLoginFailure(attemptKey, now);
      return reply.code(401).type("text/html").send(await renderLoginPage("Invalid username or password"));
    }
    localLoginAttempts.delete(attemptKey);
    reply.setCookie("llm_control_auth", authProvider.createCookie(user), sessionCookieOptions(request, config.publicBaseUrl));
    return reply.redirect("/");
  });
  app.get("/register", async (_request, reply) => reply.type("text/html").send(registrationPage(
    await authMethodService.localRegistrationEnabled() ? "" : "Local account registration is disabled. Only a one-time Owner recovery link can be used."
  )));
  app.post("/register", async (request, reply) => {
    let submittedToken = "";
    try {
      const body = z.object({ token: z.string().min(20), username: z.string().trim().min(1).max(120), displayName: z.string().trim().max(160).optional(), password: z.string(), confirmPassword: z.string() }).parse(request.body);
      submittedToken = body.token;
      if (!await authMethodService.localRegistrationEnabled() && !await identityService.isOwnerRecoveryInvitation(body.token)) throw new Error("Local account registration is disabled");
      if (body.password !== body.confirmPassword) throw new Error("Passwords do not match");
      if (!config.cookieSecret) throw new Error("Local account registration requires COOKIE_SECRET to be configured");
      const user = await identityService.register(body.token, body);
      reply.setCookie("llm_control_auth", authProvider.createCookie(user), sessionCookieOptions(request, config.publicBaseUrl));
      return reply.redirect("/");
    } catch (error) {
      return reply.code(400).type("text/html").send(registrationPage(error instanceof Error ? error.message : "Registration failed", submittedToken));
    }
  });
  app.post("/logout", async (_request, reply) => {
    reply.clearCookie("llm_control_auth", { path: "/" });
    return reply.redirect("/login");
  });
  app.get("/auth/github/start", async (request, reply) => {
    try {
      const query = z.object({ method: z.string().optional() }).parse(request.query);
      const methods = await authMethodService.listEnabled("github");
      const method = query.method ? methods.find((candidate) => candidate.id === query.method) : methods[0];
      if (!method?.config.github) throw new Error("GitHub authentication is not configured");
      const nonce = crypto.randomBytes(16).toString("base64url");
      const state = authProvider.createState({ methodId: method.id, nonce });
      reply.setCookie("llm_control_oauth_state", state, oauthCookieOptions("/auth/github", absoluteUrl(request, "/auth/github/callback", config.publicBaseUrl)));
      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", method.config.github.clientId);
      authorizeUrl.searchParams.set("redirect_uri", absoluteUrl(request, "/auth/github/callback", config.publicBaseUrl));
      authorizeUrl.searchParams.set("scope", "read:user user:email read:org");
      authorizeUrl.searchParams.set("state", state);
      return reply.redirect(authorizeUrl.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start GitHub sign in";
      return reply.code(400).type("text/html").send(await renderLoginPage(message));
    }
  });
  app.get("/auth/github/callback", async (request, reply) => {
    try {
      const query = z.object({ code: z.string(), state: z.string() }).parse(request.query);
      const cookieState = request.cookies.llm_control_oauth_state;
      if (!cookieState || cookieState !== query.state) throw new Error("GitHub sign in state did not match");
      const state = authProvider.verifyState<{ methodId?: string; nonce?: string }>(query.state);
      if (!state?.methodId) throw new Error("GitHub sign in state was invalid");
      const method = await authMethodService.get(state.methodId);
      if (!method?.enabled || !method.config.github) throw new Error("GitHub authentication is not enabled");
      const principal = await authenticateGitHub(method, query.code, absoluteUrl(request, "/auth/github/callback", config.publicBaseUrl));
      const user = await identityService.signInExternal("github", method.id, principal);
      reply.clearCookie("llm_control_oauth_state", { path: "/auth/github" });
      reply.setCookie("llm_control_auth", authProvider.createCookie(user), sessionCookieOptions(request, config.publicBaseUrl));
      return reply.redirect("/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub sign in failed";
      return reply.code(401).type("text/html").send(await renderLoginPage(message));
    }
  });
  app.get("/auth/oidc/start", async (request, reply) => {
    try {
      const query = z.object({ method: z.string().optional() }).parse(request.query);
      const methods = await authMethodService.listEnabled("oidc");
      const method = query.method ? methods.find((candidate) => candidate.id === query.method) : methods[0];
      if (!method?.config.oidc) throw new Error("OIDC authentication is not configured");
      const redirectUri = absoluteUrl(request, "/auth/oidc/callback", config.publicBaseUrl);
      const { url, loginState } = await oidcAuthService.createAuthorizationRequest(method.id, method.config.oidc, redirectUri);
      const cookieState = authProvider.createState(loginState);
      reply.setCookie("llm_control_oidc_state", cookieState, oauthCookieOptions("/auth/oidc", redirectUri));
      return reply.redirect(url.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start OIDC sign in";
      return reply.code(400).type("text/html").send(await renderLoginPage(message));
    }
  });
  app.get("/auth/oidc/callback", async (request, reply) => {
    try {
      const query = z.object({ state: z.string() }).passthrough().parse(request.query);
      const cookieState = request.cookies.llm_control_oidc_state;
      const state = cookieState ? authProvider.verifyState<OidcLoginState>(cookieState) : undefined;
      if (!state?.methodId || state.state !== query.state) throw new Error("OIDC sign in state did not match");
      const method = await authMethodService.get(state.methodId);
      if (!method?.enabled || !method.config.oidc) throw new Error("OIDC authentication is not enabled");
      const callbackUrl = absoluteUrl(request, request.url, config.publicBaseUrl);
      const principal = await oidcAuthService.authenticate(method.config.oidc, callbackUrl, state);
      const user = await identityService.signInExternal("oidc", method.id, principal, method.config.oidc.teamMembershipRules);
      reply.clearCookie("llm_control_oidc_state", { path: "/auth/oidc" });
      reply.setCookie("llm_control_auth", authProvider.createCookie(user), sessionCookieOptions(request, config.publicBaseUrl));
      return reply.redirect("/");
    } catch (error) {
      reply.clearCookie("llm_control_oidc_state", { path: "/auth/oidc" });
      const message = error instanceof Error ? error.message : "OIDC sign in failed";
      return reply.code(401).type("text/html").send(await renderLoginPage(message));
    }
  });

  app.get("/", async (request, reply) => {
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    const user = requireUser(request);
    const profiles = await reservationProfileService.listForUser(user);
    if (profiles.length === 0 && (await reservationService.listActiveOwned(user)).length === 0) return reply.redirect("/welcome");
    const targets = (await visibleTargetsFor(user)).map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    const costEstimates = await startCostEstimates(targets.map(({ target }) => target), costEstimation);
    return reply.type("text/html").send(startPage(user, targets, profiles, query.error, costEstimates, config.adminStatusPollSeconds, await selectionDeploymentsForUser(user, costEstimates), await reservationProfileService.listAssignableTeams(user), config.litellmUiUrl));
  });
  app.get("/welcome", async (request, reply) => {
    const user = requireUser(request);
    const hasProfiles = (await reservationProfileService.listForUser(user)).length > 0;
    return reply.type("text/html").send(welcomePage(user, hasProfiles, false));
  });
  app.get("/help", async (request, reply) => {
    const user = requireUser(request);
    const hasProfiles = (await reservationProfileService.listForUser(user)).length > 0;
    return reply.type("text/html").send(welcomePage(user, hasProfiles, true));
  });
  app.get("/api-keys", async (request, reply) => {
    const user = requireUser(request);
    return reply.type("text/html").send(apiKeysPage(user, await apiKeyService.listForUser(user)));
  });
  app.get("/profiles", async (request, reply) => {
    const query = z.object({ create: z.string().optional(), onboarding: z.string().optional(), error: z.string().optional() }).parse(request.query);
    if (query.create === "1") return reply.redirect(`/profiles/new${query.onboarding === "1" ? "?onboarding=1" : ""}`);
    const user = requireUser(request);
    const profiles = await reservationProfileService.listForUser(user);
    const targets = (await visibleTargetsFor(user)).map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    const costEstimates = await startCostEstimates(targets.map(({ target }) => target), costEstimation);
    const manageable = await Promise.all(profiles.map(async (profile) => await reservationProfileService.canManage(user, profile) ? profile.id : undefined));
    return reply.type("text/html").send(profilesPage(user, profiles, targets, { openCreate: query.create === "1", onboarding: query.onboarding === "1", error: query.error }, await selectionDeploymentsForUser(user, costEstimates), costEstimates, await identityService.listProfileTeams(user, "use"), manageable.filter((id): id is string => Boolean(id))));
  });
  app.get("/client-setup", async (request, reply) => {
    const user = requireUser(request);
    const targets = await visibleTargetsFor(user);
    return reply.type("text/html").send(clientSetupPage(
      user,
      await reservationProfileService.listForUser(user),
      targets,
      await selectionDeploymentsForUser(user, await startCostEstimates(targets, costEstimation))
    ));
  });
  app.get("/profiles/new", async (request, reply) => {
    const query = z.object({ onboarding: z.string().optional(), error: z.string().optional() }).parse(request.query);
    const user = requireUser(request);
    const targets = (await visibleTargetsFor(user)).map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    const costEstimates = await startCostEstimates(targets.map(({ target }) => target), costEstimation);
    return reply.type("text/html").send(profileEditorPage(user, targets, await selectionDeploymentsForUser(user, costEstimates), costEstimates, { onboarding: query.onboarding === "1", error: query.error, teams: await reservationProfileService.listAssignableTeams(user) }));
  });
  app.get("/profiles/:id/edit", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    const user = requireUser(request);
    const profile = await reservationProfileService.getManageable(id, user);
    const targets = (await visibleTargetsFor(user)).map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    const costEstimates = await startCostEstimates(targets.map(({ target }) => target), costEstimation);
    return reply.type("text/html").send(profileEditorPage(user, targets, await selectionDeploymentsForUser(user, costEstimates), costEstimates, { profile, error: query.error, teams: await reservationProfileService.listAssignableTeams(user) }));
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
          targetId: z.string().optional(),
          profileId: z.string().optional(),
          durationMinutes: z.coerce.number(),
          keepaliveMinutes: z.coerce.number().optional()
        })
        .parse(request.body);
      const modelIds = raw.modelIds ? (Array.isArray(raw.modelIds) ? raw.modelIds : [raw.modelIds]) : [];
      await reservationService.createForUser(requireUser(request), { modelIds, targetIds: raw.targetId ? [raw.targetId] : [], profileId: raw.profileId || undefined, durationMinutes: raw.durationMinutes, keepaliveMinutes: raw.keepaliveMinutes });
      return reply.redirect("/");
    } catch (error) {
      const message = reservationFormErrorMessage(error);
      return reply.redirect(`/?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/reservation-profiles", async (request, reply) => {
    try {
      const raw = z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          sharingScope: z.enum(["personal", "everyone", "team"]).optional(),
          teamId: z.string().optional(),
          profileAudience: z.string().optional(),
          modelIds: z.union([z.string(), z.array(z.string())]).optional(),
          targetId: z.string().optional(),
          selectionTargetIds: z.union([z.string(), z.array(z.string())]).optional(),
          selectionModels: z.union([z.string(), z.array(z.string())]).optional(),
          returnTo: z.enum(["/", "/profiles"]).default("/"),
          defaultDurationMinutes: z.coerce.number().optional(),
          defaultKeepaliveMinutes: z.coerce.number().optional()
        })
        .parse(request.body);
      const selections = profileSelectionsFromForm(raw);
      const sharing = profileSharingFromForm(raw);
      await reservationProfileService.createForUser(requireUser(request), {
        name: raw.name,
        description: raw.description,
        ...sharing,
        selections,
        defaultDurationMinutes: raw.defaultDurationMinutes,
        defaultKeepaliveMinutes: raw.defaultKeepaliveMinutes
      });
      return reply.redirect(raw.returnTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save reservation profile";
      const onboarding = (request.body as { returnTo?: unknown } | undefined)?.returnTo === "/";
      return reply.redirect(`/profiles/new?${onboarding ? "onboarding=1&" : ""}error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/reservation-profiles/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      const raw = z.object({
        name: z.string().min(1), description: z.string().optional(), sharingScope: z.enum(["personal", "everyone", "team"]).optional(), teamId: z.string().optional(), profileAudience: z.string().optional(),
        modelIds: z.union([z.string(), z.array(z.string())]).optional(), targetId: z.string().optional(),
        selectionTargetIds: z.union([z.string(), z.array(z.string())]).optional(),
        selectionModels: z.union([z.string(), z.array(z.string())]).optional(),
        returnTo: z.enum(["/", "/profiles"]).default("/profiles"),
        defaultDurationMinutes: z.coerce.number().optional(), defaultKeepaliveMinutes: z.coerce.number().optional()
      }).parse(request.body);
      await reservationProfileService.updateForUser(id, requireUser(request), {
        name: raw.name, description: raw.description, ...profileSharingFromForm(raw), selections: profileSelectionsFromForm(raw),
        defaultDurationMinutes: raw.defaultDurationMinutes, defaultKeepaliveMinutes: raw.defaultKeepaliveMinutes
      });
      return reply.redirect(raw.returnTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update reservation profile";
      return reply.redirect(`/profiles/${encodeURIComponent(id)}/edit?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/reservation-profiles/:id/delete", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await reservationProfileService.deleteForUser(id, requireUser(request));
    return reply.redirect("/profiles");
  });
  app.get("/reservations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await reservationService.getOwned(id, requireUser(request));
    const targets = reservation.targetIds
      .map((targetId) => catalog.getTarget(targetId))
      .filter((target): target is CapacityTarget => Boolean(target))
      .map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    return reply.type("text/html").send(reservationPage(requireUser(request), reservation, config, targets));
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
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/auth"));
  const renderUserAdmin = async (request: Parameters<typeof requireUser>[0], notice: { error?: string; registrationUrl?: string; mergePreview?: Awaited<ReturnType<IdentityService["previewMerge"]>>; activeTab?: "accounts" | "invitations" | "merge" } = {}) => userAdminPage(
    requireUser(request), await identityService.listUsers(), await identityService.listRoles(), await identityService.listInvitations(), notice
  );
  app.get("/admin/users", async (request, reply) => {
    const { tab } = z.object({ tab: z.enum(["accounts", "invitations", "merge"]).optional() }).parse(request.query);
    return reply.type("text/html").send(await renderUserAdmin(request, { activeTab: tab }));
  });
  app.post("/admin/users/invitations", async (request, reply) => {
    try {
      const body = z.object({ userId: z.string().optional(), intendedUsername: z.string().optional(), initialRoleId: z.string().optional(), expiresInMinutes: z.coerce.number().int().min(5).max(43_200).default(1_440) }).parse(request.body);
      const created = await identityService.createInvitation(requireUser(request), {
        userId: body.userId || undefined, intendedUsername: body.intendedUsername || undefined, initialRoleId: body.initialRoleId || undefined, expiresInMinutes: body.expiresInMinutes, maxUses: 1
      });
      const registrationUrl = `${absoluteUrl(request, "/register", config.publicBaseUrl)}#token=${encodeURIComponent(created.token)}`;
      return reply.type("text/html").send(await renderUserAdmin(request, { registrationUrl, activeTab: "invitations" }));
    } catch (error) { return reply.code(400).type("text/html").send(await renderUserAdmin(request, { error: error instanceof Error ? error.message : "Could not create invitation", activeTab: "invitations" })); }
  });
  app.post("/admin/users/invitations/:id/revoke", async (request, reply) => {
    try { const { id } = z.object({ id: z.string() }).parse(request.params); await identityService.revokeInvitation(requireUser(request), id); return reply.redirect("/admin/users?tab=invitations"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderUserAdmin(request, { error: error instanceof Error ? error.message : "Could not revoke invitation", activeTab: "invitations" })); }
  });
  app.post("/admin/users/:id/status", async (request, reply) => {
    try { const {id}=z.object({id:z.string()}).parse(request.params); const {status}=z.object({status:z.enum(["active","disabled"])}).parse(request.body); await identityService.setUserStatus(requireUser(request),id,status); return reply.redirect("/admin/users"); }
    catch(error){return reply.code(400).type("text/html").send(await renderUserAdmin(request,{error:error instanceof Error?error.message:"Could not update user",activeTab:"accounts"}));}
  });
  app.post("/admin/users/:id/name", async (request, reply) => {
    try { const {id}=z.object({id:z.string()}).parse(request.params); const body=z.object({username:z.string().trim().min(1).max(200),displayName:z.string().trim().max(200).optional()}).parse(request.body); await identityService.renameUser(requireUser(request),id,{username:body.username,displayName:body.displayName||undefined}); return reply.redirect("/admin/users"); }
    catch(error){return reply.code(400).type("text/html").send(await renderUserAdmin(request,{error:error instanceof Error?error.message:"Could not rename user",activeTab:"accounts"}));}
  });
  app.post("/admin/users/:id/roles", async (request, reply) => {
    try { const {id}=z.object({id:z.string()}).parse(request.params); const {roleId}=z.object({roleId:z.string()}).parse(request.body); await identityService.assignRole(requireUser(request),id,roleId); return reply.redirect("/admin/users"); }
    catch(error){return reply.code(400).type("text/html").send(await renderUserAdmin(request,{error:error instanceof Error?error.message:"Could not assign role",activeTab:"accounts"}));}
  });
  app.post("/admin/users/merge", async (request, reply) => {
    try { const body=z.object({sourceUserId:z.string(),targetUserId:z.string(),confirm:z.string().optional()}).parse(request.body); if(body.confirm==="MERGE"){await identityService.mergeUsers(requireUser(request),body.sourceUserId,body.targetUserId);return reply.redirect("/admin/users");} const preview=await identityService.previewMerge(requireUser(request),body.sourceUserId,body.targetUserId); return reply.type("text/html").send(await renderUserAdmin(request,{mergePreview:preview,activeTab:"merge"})); }
    catch(error){return reply.code(400).type("text/html").send(await renderUserAdmin(request,{error:error instanceof Error?error.message:"Could not merge users",activeTab:"merge"}));}
  });
  const renderTeamAdmin = async (request: Parameters<typeof requireUser>[0], error = "") => {
    const teams = await identityService.listTeams();
    const memberships = await Promise.all(teams.map(async (team) => [team.id, await identityService.listTeamMemberships(team.id)] as const));
    return teamAdminPage(requireUser(request), teams, await identityService.listUsers(), await identityService.listRoles("team"), Object.fromEntries(memberships), error);
  };
  const teamForm = z.object({ name: z.string().trim().min(1), description: z.string().optional(), parentTeamId: z.string().optional() });
  app.get("/admin/teams", async (request, reply) => reply.type("text/html").send(await renderTeamAdmin(request)));
  app.post("/admin/teams", async (request, reply) => {
    try { const body = teamForm.parse(request.body); await identityService.createTeam(requireUser(request), { name: body.name, description: body.description?.trim() || undefined, parentTeamId: body.parentTeamId || undefined }); return reply.redirect("/admin/teams"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderTeamAdmin(request, error instanceof Error ? error.message : "Could not create team")); }
  });
  app.post("/admin/teams/:id/update", async (request, reply) => {
    try { const { id } = z.object({ id: z.string() }).parse(request.params); const body = teamForm.parse(request.body); await identityService.updateTeam(requireUser(request), id, { name: body.name, description: body.description?.trim() || undefined, parentTeamId: body.parentTeamId || undefined }); return reply.redirect("/admin/teams"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderTeamAdmin(request, error instanceof Error ? error.message : "Could not update team")); }
  });
  app.post("/admin/teams/:id/delete", async (request, reply) => {
    try { const { id } = z.object({ id: z.string() }).parse(request.params); const { confirmName } = z.object({ confirmName: z.string() }).parse(request.body); const team = (await identityService.listTeams()).find((candidate) => candidate.id === id); if (!team) throw new Error("Team not found"); if (confirmName !== team.name) throw new Error(`Type ${team.name} to delete this team`); await identityService.deleteTeam(requireUser(request), id); return reply.redirect("/admin/teams"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderTeamAdmin(request, error instanceof Error ? error.message : "Could not delete team")); }
  });
  app.post("/admin/teams/:id/members", async (request, reply) => {
    try { const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ userId: z.string(), roleId: z.string() }).parse(request.body); await identityService.setTeamMembership(requireUser(request), { teamId: id, userId: body.userId, roleId: body.roleId, source: "manual" }); return reply.redirect("/admin/teams"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderTeamAdmin(request, error instanceof Error ? error.message : "Could not add team member")); }
  });
  app.post("/admin/teams/:id/members/:userId/remove", async (request, reply) => {
    try { const { id, userId } = z.object({ id: z.string(), userId: z.string() }).parse(request.params); await identityService.removeTeamMembership(requireUser(request), id, userId, "manual"); return reply.redirect("/admin/teams"); }
    catch (error) { return reply.code(400).type("text/html").send(await renderTeamAdmin(request, error instanceof Error ? error.message : "Could not remove team member")); }
  });
  app.get("/admin/reservations", async (request, reply) => reply.type("text/html").send(reservationHistoryPage(requireUser(request))));
  app.get("/admin/activations", async (request, reply) => reply.type("text/html").send(activationPage(requireUser(request))));
  app.get("/admin/usage", async (request, reply) => reply.type("text/html").send(usagePage(requireUser(request))));
  app.get("/admin/models", async (request, reply) => {
    const targets = catalog.listTargets();
    const costs = await startCostEstimates(targets, costEstimation);
    return reply.type("text/html").send(modelMetadataPage(requireUser(request), modelSelection.listDeployments(costs), modelSelection.catalogConfig()));
  });
  app.get("/admin/assistant", async (request, reply) => {
    const targets = catalog.listTargets();
    const costs = await startCostEstimates(targets, costEstimation);
    let current: Awaited<ReturnType<ProfileAdvisorService["configuration"]>> = undefined;
    let error: string | undefined;
    try { current = await profileAdvisor.configuration(); }
    catch (caught) { error = caught instanceof Error ? caught.message : "Assistant configuration is invalid"; }
    return reply.type("text/html").send(assistantConfigPage(requireUser(request), modelSelection.listDeployments(costs), current?.config, error));
  });
  app.get("/admin/hassleoff", async (request, reply) => {
    const query = z.object({ error: z.string().optional(), success: z.string().optional() }).parse(request.query);
    const user = requireUser(request);
    const targets = await targetService.list();
    let status: Awaited<ReturnType<HassleOffClient["getStatus"]>> | undefined;
    let diagnostic: string | undefined;
    if (hassleOffClient) {
      try {
        status = await hassleOffClient.getStatus();
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : "HassleOff status request failed";
      }
    }
    const configuredTargetId = hassleOffClient?.failSafeTestTargetId ?? config.hassleOff?.failSafeTestTargetId ?? "hassleoff-failsafe-test";
    const registration = status?.targets.find((target) => target.targetId === configuredTargetId);
    const failSafeTest = status?.tripTests?.find((result) => result.targetId === configuredTargetId);
    const eligible = Boolean(registration?.testOnly && registration.actionType === "fake");
    const canRun = Boolean(status?.service.ready && status.service.armed && eligible && config.cookieSecret);
    const csrfToken = canRun
      ? authProvider.createState({
          purpose: "hassleoff-fail-safe-test",
          username: user.username,
          targetId: configuredTargetId,
          expiresAt: Date.now() + 10 * 60 * 1000,
          nonce: crypto.randomBytes(16).toString("base64url")
        })
      : undefined;
    const registrations = new Map(status?.targets.map((target) => [target.targetId, target]) ?? []);
    const view: HassleOffSafetyView = {
      configured: Boolean(hassleOffClient),
      baseUrl: hassleOffClient?.baseUrl,
      reachable: Boolean(status),
      healthy: status?.service.healthy,
      ready: status?.service.ready,
      armed: status?.service.armed,
      registrationIssues: status?.service.registrationIssues ?? [],
      credentialIssues: status?.service.credentialIssues ?? [],
      diagnostic,
      lastSuccessfulFailSafeTestAt: failSafeTest?.lastSucceededAt,
      lastSuccessfulFailSafeTestAuditEventId: failSafeTest?.auditEventId,
      failSafeTestTarget: {
        targetId: configuredTargetId,
        registered: Boolean(registration),
        eligible,
        actionType: registration?.actionType,
        testOnly: registration?.testOnly,
        armed: registration?.armed
      },
      targets: targets.map((target) => {
        const registered = registrations.get(target.id);
        return {
          id: target.id,
          displayName: target.displayName,
          protected: target.hassleOff?.protected === true,
          leaseDurationSeconds: target.hassleOff?.leaseDurationSeconds,
          registered: Boolean(registered),
          registrationActionType: registered?.actionType,
          registrationTestOnly: registered?.testOnly,
          registrationArmed: registered?.armed,
          credentialRequired: registered?.credential?.required,
          credentialAvailable: registered?.credential?.available,
          credentialId: registered?.credential?.credentialId,
          credentialStorage: registered?.credential?.storage
        };
      }),
      csrfToken,
      success: query.success,
      error: query.error
    };
    return reply.type("text/html").send(hassleOffSafetyPage(user, view));
  });
  app.post("/admin/hassleoff/fail-safe-test", async (request, reply) => {
    try {
      const user = requireUser(request);
      if (!hassleOffClient || !config.hassleOff) throw new Error("HassleOff is not configured in NeurOn");
      const body = z.object({ csrfToken: z.string().min(1), confirm: z.string().optional() }).parse(request.body ?? {});
      if (body.confirm !== "yes") throw new Error("Confirm the synthetic fail-safe test before running it");
      const state = authProvider.verifyState<{
        purpose?: string;
        username?: string;
        targetId?: string;
        expiresAt?: number;
      }>(body.csrfToken);
      if (
        state?.purpose !== "hassleoff-fail-safe-test" ||
        state?.username !== user.username ||
        state?.targetId !== hassleOffClient.failSafeTestTargetId ||
        !Number.isSafeInteger(state?.expiresAt) ||
        (state?.expiresAt ?? 0) <= Date.now()
      ) {
        throw new Error("The fail-safe test confirmation is invalid or expired; reload the page and try again");
      }
      const result = await hassleOffClient.runFailSafeTest();
      const message = `HassleOff fail-safe test succeeded for ${result.targetId} at ${result.lastFullTripTestSucceededAt}`;
      return reply.redirect(`/admin/hassleoff?success=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "HassleOff fail-safe test failed";
      return reply.redirect(`/admin/hassleoff?error=${encodeURIComponent(message)}`);
    }
  });
  app.get("/admin/auth", async (request, reply) => {
    const query = z.object({ error: z.string().optional(), tab: z.enum(["methods", "oidc", "github"]).optional() }).parse(request.query);
    return reply.type("text/html").send(adminAuthPage(requireUser(request), await authMethodService.list(), query.error, query.tab));
  });
  app.post("/admin/auth", async (request, reply) => {
    let tab: "oidc" | "github" = "github";
    try {
      const body = authMethodFormSchema.parse(request.body ?? {});
      tab = body.type === "oidc" ? "oidc" : "github";
      await authMethodService.create(authMethodFromForm(body));
      return reply.redirect("/admin/auth");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create auth method";
      return reply.redirect(`/admin/auth?tab=${tab}&error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/auth/:id/update", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = authMethodFormSchema.parse(request.body ?? {});
      const existing = await authMethodService.get(id);
      await authMethodService.update(id, authMethodFromForm(body, existing));
      return reply.redirect("/admin/auth");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update auth method";
      return reply.redirect(`/admin/auth?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/auth/:id/delete", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ confirmName: z.string().optional() }).parse(request.body ?? {});
      if (body.confirmName !== id) throw new Error(`Type ${id} to delete this auth method`);
      await authMethodService.delete(id);
      return reply.redirect("/admin/auth");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete auth method";
      return reply.redirect(`/admin/auth?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/auth/:id/copy-to-db", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await authMethodService.copyConfiguredToPersistence(id);
      return reply.redirect("/admin/auth");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not copy auth method";
      return reply.redirect(`/admin/auth?error=${encodeURIComponent(message)}`);
    }
  });
  app.get("/admin/providers", async (request, reply) => {
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    return reply.type("text/html").send(providerAdminPage(requireUser(request), await providerService.list(), await targetService.list(), config.runtimeProfiles, query.error));
  });
  app.get("/api/admin/update-status", async () => ({
    update: await updateChecker.check(),
    shutdown: await shutdownCoordinator.status(),
    maintenance: maintenanceControl.status(),
    safety: updateSafetySummary(config, catalog)
  }));
  app.get("/admin/updates", async (request, reply) => {
    const query = z.object({ error: z.string().optional(), success: z.string().optional() }).parse(request.query);
    return reply.type("text/html").send(updatesPage(
      requireUser(request),
      await updateChecker.check(),
      await shutdownCoordinator.status(),
      maintenanceControl.status(),
      updateSafetySummary(config, catalog),
      query.error,
      query.success
    ));
  });
  app.post("/admin/updates/check", async (_request, reply) => {
    await updateChecker.check(true);
    return reply.redirect("/admin/updates");
  });
  app.post("/admin/updates/maintenance/enter", async (request, reply) => {
    try {
      const user = requireUser(request);
      const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
      if (confirm !== "MAINTENANCE") throw new Error("Type MAINTENANCE to confirm");
      if (maintenanceControl.status().effectiveMode) throw new Error("NeurOn is already in maintenance mode");
      shutdownCoordinator.scheduleMaintenanceWhenSafe(user.username, async () => {
        await maintenanceControl.requestMode(true, user.username);
      });
      return reply.redirect("/admin/updates?success=Maintenance%20mode%20scheduled%20through%20the%20safe%20drain");
    } catch (error) {
      return reply.redirect(`/admin/updates?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });
  app.post("/admin/updates/maintenance/resume", async (request, reply) => {
    try {
      const user = requireUser(request);
      const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
      if (confirm !== "RESUME") throw new Error("Type RESUME to confirm");
      if (!maintenanceControl.status().effectiveMode) throw new Error("NeurOn is already in normal operation");
      shutdownCoordinator.resumeNormalOperation(user.username, async () => {
        await maintenanceControl.requestMode(false, user.username);
      });
      return reply.redirect("/admin/updates?success=Normal%20operation%20requested");
    } catch (error) {
      return reply.redirect(`/admin/updates?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });
  app.post("/admin/updates/schedule", async (request, reply) => {
    try {
      shutdownCoordinator.scheduleWhenSafe(requireUser(request).username);
      return reply.redirect("/admin/updates?success=Safe%20restart%20scheduled");
    } catch (error) {
      return reply.redirect(`/admin/updates?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });
  app.post("/admin/updates/cancel", async (_request, reply) => {
    try {
      shutdownCoordinator.cancel();
      return reply.redirect("/admin/updates?success=Scheduled%20restart%20cancelled");
    } catch (error) {
      return reply.redirect(`/admin/updates?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });
  app.post("/admin/updates/force", async (request, reply) => {
    try {
      const body = z.object({ stopTargets: z.enum(["yes", "no"]), confirm: z.string(), acknowledgeRisk: z.string().optional() }).parse(request.body ?? {});
      if (body.confirm !== "RESTART") throw new Error("Type RESTART to confirm the forced restart");
      if (body.stopTargets === "no" && body.acknowledgeRisk !== "on") throw new Error("Acknowledge the unmanaged-capacity risk before restarting without stopping targets");
      shutdownCoordinator.force(requireUser(request).username, body.stopTargets === "yes");
      return reply.redirect("/admin/updates?success=Forced%20restart%20started");
    } catch (error) {
      return reply.redirect(`/admin/updates?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });
  app.get("/api/admin/providers/:id/resources", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z.object({ includeConfigured: z.enum(["true", "false"]).optional() }).parse(request.query);
      const includeConfigured = query.includeConfigured === "true";
      const provider = (await providerService.list()).find((candidate) => candidate.id === id);
      if (!provider) throw new Error(`Provider not found: ${id}`);
      if (!capacityProvider.discoverResources) throw new Error(`Provider ${id} does not support resource discovery`);
      const resources = await capacityProvider.discoverResources(provider);
      const configuredIds = new Set(catalog.listTargets().filter((target) => target.providerId === id && target.aws?.instanceId).map((target) => target.aws!.instanceId!));
      return { resources: resources.filter((resource) => includeConfigured || !configuredIds.has(resource.id)).map((resource) => ({ ...resource, configured: configuredIds.has(resource.id) })), configuredCount: resources.filter((resource) => configuredIds.has(resource.id)).length };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not discover provider resources";
      return reply.code(400).send({ error: message });
    }
  });
  app.get("/api/admin/runtime-catalog", async (request, reply) => {
    try {
      const query = z.object({
        profileId: z.string().min(1),
        providerId: z.string().min(1),
        revision: z.string().min(7).max(40)
      }).parse(request.query);
      const profile = config.runtimeProfiles.find((candidate) => candidate.id === query.profileId);
      if (!profile?.catalog) throw new Error("Choose a runtime that publishes a provisioning catalog");
      const provider = await providerFromForm(query.providerId, providerService);
      if (!provider.provisioning?.enabled) throw new Error(`Provider ${provider.displayName} does not allow resource provisioning`);
      const options = await runtimeCatalogs.list(profile, query.revision, provider.type);
      return { profile: { id: profile.id, name: profile.name, engine: profile.catalog.engine }, revision: query.revision.toLowerCase(), options };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not load the runtime catalog" });
    }
  });
  app.post("/admin/providers", async (request, reply) => {
    try {
      const body = providerFormSchema.parse(request.body ?? {});
      await providerService.create({
        id: body.id,
        displayName: body.displayName || body.id,
        type: body.type,
        provisioning: { enabled: body.provisioningEnabled === "on" },
        config: providerConfigFromForm(body)
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
        provisioning: { enabled: body.provisioningEnabled === "on" },
        config: providerConfigFromForm(body)
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
    const query = z.object({ error: z.string().optional(), created: z.string().optional(), provision: z.enum(["true"]).optional() }).parse(request.query);
    const [targets, providers, teams, users] = await Promise.all([
      targetService.list(),
      providerService.list(),
      identityService.listTeams(),
      identityService.listUsers()
    ]);
    return reply.type("text/html").send(targetAdminPage(requireUser(request), targets, providers, config.runtimeProfiles, teams, users, query.error, query.created, config.adminStatusPollSeconds, query.provision === "true"));
  });
  app.post("/admin/targets", async (request, reply) => {
    try {
      const body = targetFormSchema.parse(request.body ?? {});
      await validateTargetAudienceSelection(body, identityService);
      const provider = await providerFromForm(body.providerId, providerService);
      const runtimeProfile = config.runtimeProfiles.find((candidate) => candidate.id === body.runtimeProfileId);
      let runtimeDeployment: RuntimeDeploymentPlan | undefined;
      if (body.connectionMode === "provision") {
        if (!provider.provisioning?.enabled) throw new Error(`Provider ${provider.displayName} does not allow resource provisioning`);
        if (!runtimeProfile?.catalog) throw new Error("Provision new requires a catalog-backed runtime");
        if (!body.runtimeCatalogRevision || !body.runtimeDeploymentId) throw new Error("Load a PreFer release and choose a deployment configuration");
        runtimeDeployment = await runtimeCatalogs.resolve(runtimeProfile, body.runtimeCatalogRevision, provider.type, body.runtimeDeploymentId);
      }
      const target = await targetService.create(targetFromForm(body, provider, config, runtimeDeployment));
      if (runtimeDeployment) {
        try {
          await targetProvisioningService.createDraft({
            providerId: target.providerId ?? target.provider,
            providerType: target.provider,
            runtimeProfileId: body.runtimeProfileId,
            target
          });
        } catch (error) {
          try { await targetService.delete(target.id); }
          catch { throw new Error(`Could not create provisioning draft for ${target.id}; its target record also could not be removed safely`); }
          throw error;
        }
      }
      return reply.redirect(`/admin/targets?created=${encodeURIComponent(target.id)}${runtimeDeployment ? "&provision=true" : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create target";
      return reply.redirect(`/admin/targets?error=${encodeURIComponent(message)}`);
    }
  });
  app.post("/admin/targets/:id/update", async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = targetFormSchema.parse(request.body ?? {});
      await validateTargetAudienceSelection(body, identityService);
      const provider = await providerFromForm(body.providerId, providerService);
      const existing = (await targetService.list()).find((candidate) => candidate.id === id);
      const retainedPlan = existing?.runtimeDeployment?.providerType === provider.type ? existing.runtimeDeployment : undefined;
      const update = targetFromForm(body, provider, config, retainedPlan);
      if (existing && retainedPlan) {
        update.modelIds = body.modelIds === undefined ? [...existing.modelIds] : listField(body.modelIds);
        const configuredModels = existing.models ?? retainedPlan.models;
        update.models = configuredModels.filter((model) => update.modelIds.includes(model.id));
        if (provider.type === "runpod") {
          update.runpod = {
            ...(existing.runpod ?? {}),
            ...(update.runpod ?? {}),
            ...(existing.runpod?.create ? { create: existing.runpod.create } : {})
          };
        }
        if (provider.type === "aws-ec2") update.aws = { ...(existing.aws ?? {}), ...(update.aws ?? {}) };
        if (body.estimatedHourlyCostUsd === undefined && existing.costEstimate) update.costEstimate = existing.costEstimate;
      }
      await targetService.update(id, update);
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

function profileSelectionsFromForm(raw: {
  targetId?: string;
  modelIds?: string | string[];
  selectionTargetIds?: string | string[];
  selectionModels?: string | string[];
}): ReservationProfileSelection[] {
  const selectedTargets = listFormValues(raw.selectionTargetIds);
  if (selectedTargets.length === 0) {
    if (!raw.targetId) return [];
    return [{ targetId: raw.targetId, modelIds: listFormValues(raw.modelIds) }];
  }
  const modelsByTarget = new Map<string, string[]>();
  for (const encoded of listFormValues(raw.selectionModels)) {
    const parsed = z.object({ targetId: z.string(), modelId: z.string() }).parse(JSON.parse(encoded));
    modelsByTarget.set(parsed.targetId, [...(modelsByTarget.get(parsed.targetId) ?? []), parsed.modelId]);
  }
  return selectedTargets.map((targetId) => ({ targetId, modelIds: modelsByTarget.get(targetId) ?? [] }));
}

function profileSharingFromForm(raw: { profileAudience?: string; sharingScope?: "personal" | "everyone" | "team"; teamId?: string }): { sharingScope: "personal" | "everyone" | "team"; teamId?: string } {
  if (!raw.profileAudience) {
    const sharingScope = raw.sharingScope ?? (raw.teamId ? "team" : "personal");
    return { sharingScope, ...(sharingScope === "team" && raw.teamId ? { teamId: raw.teamId } : {}) };
  }
  if (raw.profileAudience === "personal" || raw.profileAudience === "everyone") return { sharingScope: raw.profileAudience };
  if (raw.profileAudience.startsWith("team:") && raw.profileAudience.length > 5) return { sharingScope: "team", teamId: raw.profileAudience.slice(5) };
  throw new Error("Choose a valid profile audience");
}

function listFormValues(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

const providerFormSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  type: z.string().min(1),
  provisioningEnabled: z.string().optional(),
  awsEc2InstanceNamePattern: z.string().optional(),
  awsEc2LaunchTemplateId: z.string().optional(),
  awsEc2LaunchTemplateName: z.string().optional(),
  awsEc2LaunchTemplateVersion: z.string().optional(),
  awsEc2UserDataBeginMarker: z.string().optional(),
  awsEc2UserDataEndMarker: z.string().optional(),
  awsEc2DeploymentEnvironmentJson: z.string().optional()
});

function providerConfigFromForm(body: z.infer<typeof providerFormSchema>): CapacityProviderDefinition["config"] {
  if (body.type !== "aws-ec2") return undefined;
  const instanceNamePattern = body.awsEc2InstanceNamePattern?.trim();
  const launchTemplateId = body.awsEc2LaunchTemplateId?.trim();
  const launchTemplateName = body.awsEc2LaunchTemplateName?.trim();
  if (launchTemplateId && launchTemplateName) throw new Error("Choose an EC2 launch template ID or name, not both");
  if (body.provisioningEnabled === "on" && !launchTemplateId && !launchTemplateName) throw new Error("Provisioning-enabled AWS EC2 providers require a launch template ID or name");
  const launchTemplateVersion = body.awsEc2LaunchTemplateVersion?.trim();
  const userDataBeginMarker = body.awsEc2UserDataBeginMarker?.trim();
  const userDataEndMarker = body.awsEc2UserDataEndMarker?.trim();
  if ((userDataBeginMarker && !userDataEndMarker) || (!userDataBeginMarker && userDataEndMarker)) throw new Error("Both EC2 user-data markers are required when either is customized");
  if (userDataBeginMarker && userDataBeginMarker === userDataEndMarker) throw new Error("EC2 user-data markers must be distinct");
  if ([userDataBeginMarker, userDataEndMarker].some((value) => value && (value.length > 200 || /[\r\n\0]/u.test(value)))) {
    throw new Error("EC2 user-data markers must be one line and at most 200 characters");
  }
  let deploymentEnvironment: Record<string, string> | undefined;
  if (body.awsEc2DeploymentEnvironmentJson?.trim()) {
    deploymentEnvironment = z.record(z.string()).parse(JSON.parse(body.awsEc2DeploymentEnvironmentJson));
    for (const [key, value] of Object.entries(deploymentEnvironment)) {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid EC2 deployment environment key: ${key}`);
      if (secretBearingEnvironmentKey(key)) throw new Error(`Do not store secret-bearing value ${key} in provider configuration`);
      if (value.length > 4_000 || /[\r\n\0]/u.test(value)) throw new Error(`EC2 deployment environment value ${key} must be one line and at most 4,000 characters`);
    }
  }
  const awsEc2 = {
    ...(instanceNamePattern ? { instanceNamePattern } : {}),
    ...(launchTemplateId ? { launchTemplateId } : {}),
    ...(launchTemplateName ? { launchTemplateName } : {}),
    ...(launchTemplateVersion ? { launchTemplateVersion } : {}),
    ...(userDataBeginMarker ? { userDataBeginMarker } : {}),
    ...(userDataEndMarker ? { userDataEndMarker } : {}),
    ...(deploymentEnvironment ? { deploymentEnvironment } : {})
  };
  return Object.keys(awsEc2).length > 0 ? { awsEc2 } : undefined;
}

const authMethodFormSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  type: z.enum(["local", "github", "oidc"]).default("github"),
  enabled: z.string().optional(),
  registrationEnabled: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  clientSecretSource: z.enum(["environment", "aws-secrets-manager", "stored"]).optional(),
  clientSecretEnvironmentVariable: z.string().optional(),
  clientSecretId: z.string().optional(),
  clientSecretJsonKey: z.string().optional(),
  issuer: z.string().optional(),
  scopes: z.string().optional(),
  usernameClaim: z.string().optional(),
  groupsClaim: z.string().optional(),
  allowedUsers: z.string().optional(),
  allowedOrganizations: z.string().optional(),
  allowedGroups: z.string().optional(),
  teamMembershipRulesJson: z.string().optional()
});

const optionalNumber = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().optional());
const optionalNonnegativeNumber = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().nonnegative().optional());
const optionalPort = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().positive().max(65_535).optional());
const optionalPositiveInteger = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().positive().optional());

const targetFormSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  providerId: z.string().min(1),
  connectionMode: z.enum(["existing", "provision"]).default("existing"),
  modelIds: z.string().optional(),
  trafficModelPrefixes: z.string().optional(),
  aliasPriority: optionalPositiveInteger,
  audienceScope: z.enum(["global", "teams", "users"]).default("global"),
  audienceTeamIds: z.union([z.string(), z.array(z.string())]).optional(),
  audienceUserIds: z.union([z.string(), z.array(z.string())]).optional(),
  litellmCredentialName: z.string().optional(),
  litellmApiKeyEnv: z.string().optional(),
  litellmSyncDisabled: z.string().optional(),
  runtimeProfileId: z.string().optional(),
  runtimeProfileVariantId: z.string().optional(),
  runtimeCatalogRevision: z.string().optional(),
  runtimeDeploymentId: z.string().optional(),
  healthUrl: z.string().optional(),
  apiUrl: z.string().optional(),
  runpodPodId: z.string().optional(),
  runpodRuntimePort: optionalNumber,
  runpodVolumeGb: optionalPositiveInteger,
  runpodContainerDiskGb: optionalPositiveInteger,
  runpodCloudType: z.enum(["SECURE", "COMMUNITY"]).optional(),
  runpodInterruptible: z.string().optional(),
  awsCluster: z.string().optional(),
  awsService: z.string().optional(),
  awsAsgName: z.string().optional(),
  awsInstanceId: z.string().optional(),
  awsRuntimePort: optionalPort,
  estimatedHourlyCostUsd: optionalNonnegativeNumber,
  dockerContainerName: z.string().optional(),
  dockerModelVolume: z.string().optional(),
  neuronTargetId: z.string().optional()
});

async function providerFromForm(providerId: string, providerService: ProviderService): Promise<CapacityProviderDefinition> {
  const provider = (await providerService.list()).find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  return provider;
}

async function validateTargetAudienceSelection(body: z.infer<typeof targetFormSchema>, identityService: IdentityService): Promise<void> {
  if (body.audienceScope === "teams") {
    const requested = listField(body.audienceTeamIds);
    const known = new Set((await identityService.listTeams()).map((team) => team.id));
    if (requested.some((id) => !known.has(id))) throw new Error("Choose valid teams for the target audience");
  }
  if (body.audienceScope === "users") {
    const requested = listField(body.audienceUserIds);
    const known = new Set((await identityService.listUsers()).filter((user) => !user.mergedIntoUserId).map((user) => user.id));
    if (requested.some((id) => !known.has(id))) throw new Error("Choose valid people for the target audience");
  }
}

function targetFromForm(body: z.infer<typeof targetFormSchema>, provider: CapacityProviderDefinition, config?: AppConfig, runtimeDeployment?: RuntimeDeploymentPlan): CapacityTarget {
  const profile = effectiveRuntimeProfile(config?.runtimeProfiles, body.runtimeProfileId, body.runtimeProfileVariantId);
  const target: Record<string, unknown> = {};
  target.id = body.id;
  target.displayName = body.displayName || body.id;
  target.provider = provider.type;
  target.providerId = provider.id;
  target.modelIds = runtimeDeployment ? runtimeDeployment.models.map((model) => model.id) : listField(body.modelIds);
  if (runtimeDeployment) {
    target.runtimeDeployment = runtimeDeployment;
    target.models = runtimeDeployment.models;
  }
  const trafficModelPrefixes = listField(body.trafficModelPrefixes);
  if (trafficModelPrefixes.length > 0) target.trafficModelPrefixes = trafficModelPrefixes;
  if (body.aliasPriority !== undefined) target.aliasPriority = body.aliasPriority;
  if (body.audienceScope === "teams") {
    const teamIds = listField(body.audienceTeamIds);
    if (teamIds.length === 0) throw new Error("At least one team is required for a team target");
    target.audience = { scope: "teams", teamIds };
  } else if (body.audienceScope === "users") {
    const userIds = listField(body.audienceUserIds);
    if (userIds.length === 0) throw new Error("At least one user is required for a private target");
    target.audience = { scope: "users", userIds };
  } else target.audience = { scope: "global" };
  const litellmCredentialName = body.litellmCredentialName?.trim();
  const litellmApiKeyEnv = body.litellmApiKeyEnv?.trim();
  if (litellmCredentialName || litellmApiKeyEnv || body.litellmSyncDisabled === "on") {
    target.litellm = {
      ...(litellmCredentialName ? { credentialName: litellmCredentialName } : {}),
      ...(litellmApiKeyEnv ? { apiKeyEnv: litellmApiKeyEnv } : {}),
      ...(body.litellmSyncDisabled === "on" ? { syncDiscoveredModels: false } : {})
    };
  }
  if (profileDiscovery(profile)) target.modelDiscovery = { bootstrapOnStartup: true };
  if (body.healthUrl) target.healthUrl = body.healthUrl;
  if (body.apiUrl) target.apiUrl = body.apiUrl;
  if (body.estimatedHourlyCostUsd !== undefined) target.costEstimate = { hourlyUsd: body.estimatedHourlyCostUsd };
  else if (runtimeDeployment?.hardware?.advertisedHourlyUsd !== undefined) {
    target.costEstimate = { hourlyUsd: runtimeDeployment.hardware.advertisedHourlyUsd * (runtimeDeployment.hardware.gpuCount ?? 1) };
  }
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
  if (provider.type === "runpod" && runtimeDeployment) {
    target.runpod = {
      ...(body.runpodPodId?.trim() ? { podId: body.runpodPodId.trim() } : {}),
      runtimePort: runtimeDeployment.port,
      create: runpodCreateFromDeployment(body, runtimeDeployment)
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
  if (provider.type === "aws-ec2") {
    const instanceId = body.awsInstanceId?.trim();
    if (!instanceId && !runtimeDeployment) throw new Error("AWS EC2 instance ID is required when connecting existing capacity");
    target.aws = {
      ...(instanceId ? { instanceId } : {}),
      runtimePort: body.awsRuntimePort ?? runtimeDeployment?.port ?? profilePort(profile),
      runtimeProtocol: "http",
      healthPath: runtimeDeployment?.healthPath ?? profileHealth(profile),
      apiPath: runtimeDeployment?.apiPath ?? profileApi(profile)
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

function effectiveRuntimeProfile(runtimeProfiles: RuntimeProfile[] | undefined, profileId: string | undefined, variantId: string | undefined): RuntimeProfile | undefined {
  const profile = runtimeProfiles?.find((candidate) => candidate.id === profileId);
  if (!profile) {
    if (variantId) throw new Error(`Runtime profile not found for variant: ${variantId}`);
    return undefined;
  }
  if (!variantId) return profile;
  const variant = profile.variants?.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Runtime profile variant not found: ${variantId}`);
  return {
    ...profile,
    image: variant.image ?? profile.image,
    port: variant.port ?? profile.port,
    health: variant.health ?? profile.health,
    api: variant.api ?? profile.api,
    volumes: variant.volumes ?? profile.volumes,
    env: { ...(profile.env ?? {}), ...(variant.env ?? {}) },
    discovery: variant.discovery ?? profile.discovery
  };
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

function runpodCreateFromDeployment(body: z.infer<typeof targetFormSchema>, plan: RuntimeDeploymentPlan): Record<string, unknown> {
  const gpuTypeId = plan.hardware?.providerGpuTypeId;
  if (!gpuTypeId) throw new Error(`Runtime deployment ${plan.deploymentId} does not declare a RunPod GPU type`);
  return {
    name: (body.displayName || body.id).trim(),
    computeType: "GPU",
    cloudType: body.runpodCloudType ?? "SECURE",
    imageName: plan.image,
    gpuTypeIds: [gpuTypeId],
    gpuTypePriority: "availability",
    gpuCount: plan.hardware?.gpuCount ?? 1,
    interruptible: body.runpodInterruptible === "on",
    containerDiskInGb: body.runpodContainerDiskGb ?? 50,
    volumeInGb: body.runpodVolumeGb ?? 100,
    volumeMountPath: "/models",
    ports: [`${plan.port}/http`],
    env: plan.environment
  };
}

function listField(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : [value ?? ""])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function reservationFormErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("draining for restart")) return error.message;
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

async function startCostEstimates(targets: CapacityTarget[], costEstimation: CostEstimationService): Promise<Record<string, { hourlyUsd: number }>> {
  const estimates = await Promise.all(
    targets.map(async (target) => {
      const estimate = await costEstimation.resolveTargetCostEstimate(target);
      return estimate?.hourlyUsd === undefined ? undefined : [target.id, { hourlyUsd: estimate.hourlyUsd }] as const;
    })
  );
  return Object.fromEntries(estimates.filter((estimate): estimate is [string, { hourlyUsd: number }] => Boolean(estimate)));
}

function authMethodFromForm(body: z.infer<typeof authMethodFormSchema>, existing?: AuthMethod): AuthMethod {
  if (body.type === "local") {
    return {
      id: body.id,
      displayName: body.displayName || "Username and password",
      type: "local",
      enabled: body.enabled === "on",
      config: { local: { registrationEnabled: body.registrationEnabled === "on" } }
    };
  }
  if (body.type === "oidc") {
    const clientId = body.clientId?.trim();
    const issuer = body.issuer?.trim().replace(/\/$/, "");
    if (!clientId) throw new Error("OIDC client ID is required");
    if (!issuer) throw new Error("OIDC issuer is required");
    try {
      const issuerUrl = new URL(issuer);
      if (!["http:", "https:"].includes(issuerUrl.protocol)) throw new Error("unsupported protocol");
    } catch {
      throw new Error("OIDC issuer must be a valid HTTP or HTTPS URL");
    }
    const previousSecret = existing?.config.oidc?.clientSecret;
    const source = body.clientSecretSource ?? previousSecret?.source ?? "environment";
    const clientSecret = oidcSecretFromForm(body, source, previousSecret);
    return {
      id: body.id,
      displayName: body.displayName || "OIDC",
      type: "oidc",
      enabled: body.enabled === "on",
      config: {
        oidc: {
          issuer,
          clientId,
          clientSecret,
          scopes: listField(body.scopes || "openid,profile,email"),
          usernameClaim: body.usernameClaim?.trim() || "preferred_username",
          groupsClaim: body.groupsClaim?.trim() || "groups",
          allowedUsers: listField(body.allowedUsers),
          allowedGroups: listField(body.allowedGroups),
          teamMembershipRules: parseOidcTeamMembershipRules(body.teamMembershipRulesJson)
        }
      }
    };
  }
  const clientId = body.clientId?.trim();
  if (!clientId) throw new Error("GitHub client ID is required");
  const clientSecret = body.clientSecret || existing?.config.github?.clientSecret;
  if (!clientSecret) throw new Error("GitHub client secret is required");
  return {
    id: body.id,
    displayName: body.displayName || "GitHub",
    type: "github",
    enabled: body.enabled === "on",
    config: {
      github: {
        clientId,
        clientSecret,
        allowedUsers: listField(body.allowedUsers),
        allowedOrganizations: listField(body.allowedOrganizations)
      }
    }
  };
}

function oidcSecretFromForm(
  body: z.infer<typeof authMethodFormSchema>,
  source: "environment" | "aws-secrets-manager" | "stored",
  previous?: NonNullable<AuthMethod["config"]["oidc"]>["clientSecret"]
): NonNullable<AuthMethod["config"]["oidc"]>["clientSecret"] {
  if (source === "environment") {
    const environmentVariable = body.clientSecretEnvironmentVariable?.trim()
      || (previous?.source === source ? previous.environmentVariable : "")
      || `AUTH_METHOD_${environmentKey(body.id)}_CLIENT_SECRET`;
    return { source, environmentVariable };
  }
  if (source === "aws-secrets-manager") {
    const secretId = body.clientSecretId?.trim() || (previous?.source === source ? previous.secretId : "");
    if (!secretId) throw new Error("AWS Secrets Manager secret name or ARN is required");
    const jsonKey = body.clientSecretJsonKey?.trim() || (previous?.source === source ? previous.jsonKey : undefined);
    return { source, secretId, ...(jsonKey ? { jsonKey } : {}) };
  }
  const value = body.clientSecret || (previous?.source === source ? previous.value : "");
  if (!value) throw new Error("Stored OIDC client secret is required");
  return { source, value };
}

function environmentKey(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function absoluteUrl(request: { headers: Record<string, string | string[] | undefined> }, path: string, publicBaseUrl?: string): string {
  if (publicBaseUrl) return `${publicBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protoHeader = request.headers["x-forwarded-proto"];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  return `${proto ?? "http"}://${host ?? "localhost"}${path}`;
}

function oauthCookieOptions(path: string, redirectUri: string) {
  return { path, httpOnly: true, sameSite: "lax" as const, maxAge: 600, secure: redirectUri.startsWith("https:") };
}

function sessionCookieOptions(request: Parameters<typeof absoluteUrl>[0], publicBaseUrl?: string) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: SESSION_MAX_AGE_SECONDS, secure: absoluteUrl(request, "/", publicBaseUrl).startsWith("https:") };
}

async function authenticateGitHub(method: AuthMethod, code: string, redirectUri: string): Promise<{ subject: string; username: string; email?: string }> {
  const github = method.config.github;
  if (!github) throw new Error("GitHub authentication is not configured");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: github.clientId,
      client_secret: github.clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description ?? tokenBody.error ?? "GitHub did not return an access token");
  const user = await githubRequest<{ id?: number; login?: string; email?: string | null }>("https://api.github.com/user", tokenBody.access_token);
  const login = user.login;
  if (!user.id || !login) throw new Error("GitHub did not return a stable user identity");
  if (github.allowedUsers?.length && !github.allowedUsers.includes(login)) throw new Error("This GitHub user is not allowed");
  if (github.allowedOrganizations?.length) {
    const orgs = await githubRequest<Array<{ login?: string }>>("https://api.github.com/user/orgs?per_page=100", tokenBody.access_token);
    const orgLogins = new Set(orgs.map((org) => org.login).filter(Boolean));
    if (!github.allowedOrganizations.some((org) => orgLogins.has(org))) throw new Error("This GitHub user is not in an allowed organization");
  }
  return { subject: String(user.id), username: login, email: user.email ?? undefined };
}

function parseOidcTeamMembershipRules(value: string | undefined) {
  if (!value?.trim()) return [];
  return z.array(z.object({ id: z.string().min(1), claim: z.string().min(1), match: z.enum(["exact", "regex"]), value: z.string(), teamId: z.string().min(1), roleId: z.string().min(1), enabled: z.boolean().optional() }).strict()).parse(JSON.parse(value));
}

async function githubRequest<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "NeurOn"
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API returned ${response.status}${body ? `: ${body}` : ""}`);
  }
  return response.json() as Promise<T>;
}

function updateSafetySummary(config: AppConfig, catalog: ModelCatalog) {
  const targets = catalog.listTargets();
  const protectedTargets = targets.filter((target) => target.hassleOff?.protected === true).length;
  return {
    hassleOffConfigured: Boolean(config.hassleOff),
    protectedTargets,
    totalTargets: targets.length
  };
}

function secretBearingEnvironmentKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|(?:^|_)(?:API_|ACCESS_)?KEY(?:_|$)/u.test(key);
}
