import { describe, expect, it, vi } from "vitest";
import { buildApp as buildProductionApp, type BuildAppOptions } from "../app.js";
import type { AppConfig, ModelDefinition } from "../domain/types.js";
import { shouldBootstrapRuntimeModels } from "../services/RuntimeModelDiscovery.js";

const config: AppConfig = {
  port: 0,
  storage: { driver: "memory" },
  awsRegion: "us-east-1",
  litellmTrafficPollSeconds: 0,
  litellmTrafficLookbackSeconds: 300,
  runtimeProfiles: [
    {
      id: "prefer",
      name: "PreFer",
      type: "docker",
      image: "ghcr.io/cvalusek/prefer:latest",
      volumes: { "/models": "prefer-model-cache" },
      variants: [{ id: "smol", name: "Smol", env: { LLAMA_ARG_MODELS_PRESET: "/presets/smol.ini" } }]
    }
  ],
  capacityProviders: [
    { id: "aws-ecs", displayName: "AWS ECS", type: "aws-ecs", config: {} },
    { id: "runpod", displayName: "RunPod", type: "runpod", config: {} },
    { id: "docker", displayName: "Docker", type: "docker", config: {} }
  ],
  capacityTargets: [{ id: "t1", displayName: "T1", provider: "aws-ecs", modelIds: ["m1"], healthUrl: "http://example.test" }],
  reconcilerIntervalSeconds: 15,
  reservationStatusPollSeconds: 5,
  adminStatusPollSeconds: 10,
  healthCheckTimeoutSeconds: 1,
  healthCheckIntervalSeconds: 15,
  adminUsers: [],
  authMethods: []
};

const models: ModelDefinition[] = [{ id: "m1", displayName: "M1", aliases: ["m1"], targetIds: ["t1"], contextWindowTokens: 64_000, technicalCapabilities: [{ label: "tools" }] }];

async function buildApp(appConfig: AppConfig, appModels: ModelDefinition[], options: BuildAppOptions = {}) {
  const ownerByDefault = appConfig.adminUsers.length === 0;
  return buildProductionApp(appConfig, appModels, {
    ...options,
    developmentLocalAccounts: options.developmentLocalAccounts ?? [
      { username: "actual", password: "local-test-secret", owner: ownerByDefault || appConfig.adminUsers.includes("actual") },
      { username: "other", password: "local-test-secret", owner: ownerByDefault || appConfig.adminUsers.includes("other") }
    ]
  });
}

describe("model selection guidance", () => {
  it("returns authenticated deployment facts with target cost and explicit unknowns", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({
      ...config,
      capacityTargets: [{ ...config.capacityTargets[0], costEstimate: { hourlyUsd: 2.5 } }],
      modelSelectionCatalog: {
        schemaVersion: 1,
        models: [{ modelId: "m1", intelligence: 80, domains: { coding: 91 }, provenance: { source: "private fixture" } }],
        deployments: [{ targetId: "t1", modelId: "m1", contextWindowTokens: 64_000 }]
      }
    }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/api/model-selection" });
      const response = await app.inject({ method: "GET", url: "/api/model-selection", headers: auth });
      expect(unauthenticated.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        domains: ["coding"],
        technicalCapabilities: ["tools"],
        advisorEnabled: false,
        deployments: [{ key: "t1::m1", hourlyUsd: 2.5, contextWindowTokens: 64_000, intelligence: 80, domains: { coding: 91 } }]
      });
      expect(response.json().deployments[0].performance).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("does not let profile guidance create advisor demand during maintenance", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = await buildApp({
      ...config,
      maintenanceMode: true,
      modelSelectionCatalog: { schemaVersion: 1, models: [{ modelId: "m1", domains: { coding: 90 } }], deployments: [] }
    }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      expect((await app.inject({ method: "GET", url: "/api/profile-advisor/status", headers: auth })).json()).toMatchObject({ enabled: false, reason: "maintenance_mode" });
      const response = await app.inject({ method: "POST", url: "/api/profile-advisor", headers: auth, payload: { request: "Long coding sessions with 128K context" } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatch(/maintenance mode/);
      const asyncResponse = await app.inject({ method: "POST", url: "/api/profile-advisor/requests", headers: auth, payload: { request: "Long coding sessions with 128K context" } });
      expect(asyncResponse.statusCode).toBe(503);
      expect(asyncResponse.json().error).toMatch(/maintenance mode/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("stores independent assistant configuration and exposes its own screen plus the global drawer", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({ ...config, adminUsers: ["actual"] }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      expect((await app.inject({ method: "GET", url: "/api/profile-advisor/status", headers: auth })).json()).toMatchObject({ enabled: false, backend: null });
      const saved = await app.inject({ method: "PUT", url: "/api/admin/assistant-config", headers: auth, payload: { targetId: "t1", modelId: "m1", reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90, additionalInstructions: "Use our internal team terminology." } });
      expect(saved.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/assistant-config", headers: auth })).json()).toMatchObject({ backend: { additionalInstructions: "Use our internal team terminology." } });
      expect((await app.inject({ method: "GET", url: "/api/profile-advisor/status", headers: auth })).json()).toMatchObject({ enabled: true, backend: { targetId: "t1", modelId: "m1" } });
      const modelPage = await app.inject({ method: "GET", url: "/admin/models", headers: auth });
      expect(modelPage.body).not.toContain("Profile assistant backend");
      const assistantPage = await app.inject({ method: "GET", url: "/admin/assistant", headers: auth });
      expect(assistantPage.body).toContain("Save assistant settings");
      expect(assistantPage.body).toContain("Reservation duration");
      expect(assistantPage.body).toContain("Keepalive");
      expect(assistantPage.body).toContain("Additional system guidance");
      expect(assistantPage.body).toContain("Use our internal team terminology.");
      expect(assistantPage.body).toContain('data-assistant-timeout="90"');
      expect(assistantPage.body).toContain("Warm-model response timeout");
      expect(assistantPage.body).toContain("data-assistant-config-toast");
      expect(assistantPage.body).not.toContain("data-assistant-config-status");
      expect(modelPage.body).toContain("Confirm save profile");
      expect(modelPage.body).toContain("Confirm start reservation");

      expect((await app.inject({ method: "PUT", url: "/api/admin/assistant-config", headers: auth, payload: { targetId: null, modelId: null, reservationMinutes: 12, keepaliveMinutes: 5, requestTimeoutSeconds: 90 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/profile-advisor/status", headers: auth })).json().enabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("persists model facts and favorites and publishes priority-aware client routes", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({
      ...config,
      litellmApiBaseUrl: "https://litellm.example.test/v1",
      litellmUiUrl: "https://console.example.test/playground",
      capacityTargets: [{
        ...config.capacityTargets[0],
        aliasPriority: 10,
        models: [{ id: "m1", displayName: "M1", aliases: ["fast"], contextWindowTokens: 65_536 }]
      }]
    }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const profile = await app.inject({
        method: "POST",
        url: "/api/reservation-profiles",
        headers: auth,
        payload: { name: "Coding", selections: [{ targetId: "t1", modelIds: ["m1"] }] }
      });
      expect(profile.statusCode).toBe(201);

      expect((await app.inject({
        method: "PUT",
        url: "/api/admin/model-metadata/models/m1",
        headers: auth,
        payload: { intelligence: 82, domains: { coding: 91 }, quantization: { format: "Q6_K", qualityRetentionPercent: 99 }, provenance: { source: "test fixture", version: "2026-08" } }
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "PUT",
        url: "/api/admin/model-metadata/deployments/t1/m1",
        headers: auth,
        payload: { performance: { decodeTokensPerSecond: 42 }, provenance: { source: "test fixture", version: "2026-08" } }
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "POST",
        url: "/api/model-favorites",
        headers: auth,
        payload: { targetId: "t1", modelId: "m1" }
      })).statusCode).toBe(201);

      const selection = await app.inject({ method: "GET", url: "/api/model-selection", headers: auth });
      expect(selection.json().deployments).toMatchObject([{
        key: "t1::m1",
        intelligence: 82,
        domains: { coding: 91 },
        contextWindowTokens: 65_536,
        quantization: { format: "Q6_K", qualityRetentionPercent: 99 },
        favorite: true,
        aliases: ["fast"]
      }]);

      const clientModels = await app.inject({ method: "GET", url: "/api/client-models", headers: auth });
      expect(clientModels.json()).toMatchObject({
        profiles: [{ id: profile.json().id, name: "Coding" }],
        models: [{
          targetId: "t1",
          modelId: "m1",
          aliases: { global: ["fast"], scoped: ["t1/fast"] },
          aliasPriority: 10,
          profileIds: [profile.json().id]
        }]
      });
      const clientPage = await app.inject({ method: "GET", url: "/client-setup", headers: auth });
      expect(clientPage.statusCode).toBe(200);
      expect(clientPage.body).toContain("Use the target-scoped alias");
      expect(clientPage.body).toContain("<th>Use</th><th>Fallback</th>");
      expect(clientPage.body).toContain("t1/fast");
      expect(clientPage.body).not.toContain("sk-neuron-test");

      const removed = await app.inject({ method: "DELETE", url: "/api/model-favorites/t1/m1", headers: auth });
      expect(removed.json()).toEqual({ removed: true });
      const refreshed = await app.inject({ method: "GET", url: "/api/model-selection", headers: auth });
      expect(refreshed.json().deployments[0].favorite).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("maintenance mode", () => {
  it("blocks capacity mutations, permits identity repairs, and avoids HassleOff status calls", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app, identityService } = await buildApp({
      ...config,
      maintenanceMode: true,
      adminUsers: ["actual"],
      capacityTargets: [{ id: "t1", displayName: "T1", provider: "runpod", providerId: "runpod", modelIds: ["m1"] }],
      hassleOff: {
        baseUrl: "http://hassleoff.invalid",
        controllerToken: "not-used",
        controllerId: "neuron-test",
        requestTimeoutSeconds: 1,
        failSafeTestTargetId: "test",
        allowInsecureHttp: true
      }
    }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const health = await app.inject({ method: "GET", url: "/healthz" });
    const mutation = await app.inject({ method: "POST", url: "/api/reservations", headers: auth, payload: { modelIds: ["m1"] } });
    const profile = await app.inject({
      method: "POST",
      url: "/api/reservation-profiles",
      headers: auth,
      payload: { name: "Maintenance profile", selections: [{ targetId: "t1", modelIds: ["m1"] }] }
    });
    const team = await app.inject({ method: "POST", url: "/api/admin/teams", headers: auth, payload: { name: "Maintenance administrators" } });
    const users = await identityService.listUsers();
    const source = users.find((user) => user.username === "other")!;
    const target = users.find((user) => user.username === "actual")!;
    const merge = await app.inject({ method: "POST", url: "/api/admin/users/merge", headers: auth, payload: { sourceUserId: source.id, targetUserId: target.id, confirm: "MERGE" } });
    const home = await app.inject({ method: "GET", url: "/", headers: auth });
    const hassleOff = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: auth });
    await app.close();
    vi.unstubAllGlobals();

    expect(health.json()).toEqual({ ok: true, storageDriver: "memory", maintenanceMode: true });
    expect(mutation.statusCode).toBe(503);
    expect(profile.statusCode).toBe(201);
    expect(team.statusCode).toBe(201);
    expect(merge.statusCode).toBe(200);
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("Maintenance profile");
    expect(hassleOff.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a system administrator request a coherent return to normal operation", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const requestShutdown = vi.fn(async () => undefined);
    const { app } = await buildApp({
      ...config,
      maintenanceMode: true,
      adminUsers: ["actual"]
    }, models, { requestShutdown });
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const page = await app.inject({ method: "GET", url: "/admin/updates", headers: auth });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("Resume normal operation");

      const rejected = await app.inject({
        method: "POST",
        url: "/admin/updates/maintenance/resume",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ confirm: "no" }).toString()
      });
      expect(rejected.headers.location).toContain("Type%20RESUME%20to%20confirm");

      const resumed = await app.inject({
        method: "POST",
        url: "/admin/updates/maintenance/resume",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ confirm: "RESUME" }).toString()
      });
      expect(resumed.statusCode).toBe(302);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(requestShutdown).toHaveBeenCalledWith("resume-normal-operation");
      const status = await app.inject({ method: "GET", url: "/api/admin/update-status", headers: auth });
      expect(status.json()).toMatchObject({
        maintenance: { effectiveMode: true, overrideMode: false, restartRequired: true },
        shutdown: { purpose: "resume-normal", mode: "shutting-down" }
      });
    } finally {
      await app.close();
    }
  });
});

describe("API authentication context", () => {
  it("does not render admin navigation for non-admin users", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({ ...config, adminUsers: ["actual"] }, models);
    const auth = { authorization: `Basic ${Buffer.from("other:local-test-secret").toString("base64")}` };

    const response = await app.inject({ method: "GET", url: "/welcome", headers: auth });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<summary>Workspace</summary>");
    expect(response.body).not.toContain("<summary>Admin</summary>");
    expect(response.body).not.toContain("<summary>Configuration</summary>");
    expect(response.body).not.toContain("<summary>History</summary>");
    expect(response.body).not.toContain('href="/admin/');
    expect(response.body).toContain('<form method="post" action="/logout">');
    expect(response.body).toContain('class="nav-drawer" aria-hidden="true"');
    expect(response.body).toContain("body.drawer-open .system-banner");
    expect(response.body).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(response.body).not.toContain('class="nav-drawer" hidden');
  });

  it("clears the local session cookie on logout", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);

    const response = await app.inject({ method: "POST", url: "/logout" });
    await app.close();

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
    expect(String(response.headers["set-cookie"])).toContain("llm_control_auth=;");
    expect(String(response.headers["set-cookie"])).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("uses per-user local credentials and preserves signed sessions", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const localConfig = { ...config, cookieSecret: "test-cookie-secret", adminUsers: ["actual"] };
    const { app } = await buildApp(localConfig, models);

    const login = await app.inject({ method: "GET", url: "/login" });
    const invalidPassword = await app.inject({ method: "POST", url: "/login", payload: { username: "actual", password: "wrong-password" } });
    const passwordAttempt = await app.inject({ method: "POST", url: "/login", payload: { username: "actual", password: "local-test-secret" } });
    const basicAttempt = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` }
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await app.inject({
        method: "GET",
        url: "/api/models",
        headers: { authorization: `Basic ${Buffer.from("actual:wrong-password").toString("base64")}` }
      })).statusCode).toBe(401);
    }
    const throttledBasicAttempt = await app.inject({
      method: "GET",
      url: "/api/models",
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` }
    });
    const sessionCookie = String(passwordAttempt.headers["set-cookie"]).split(";")[0];
    const sessionRequest = await app.inject({ method: "GET", url: "/welcome", headers: { cookie: sessionCookie } });
    await app.close();

    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('<form method="post" action="/login">');
    expect(invalidPassword.statusCode).toBe(401);
    expect(passwordAttempt.statusCode).toBe(302);
    expect(basicAttempt.statusCode).not.toBe(401);
    expect(throttledBasicAttempt.statusCode).toBe(401);
    expect(sessionRequest.statusCode).toBe(200);
  });

  it("can disable local password login and invitation registration without disabling external auth", async () => {
    const { app, identityService } = await buildApp({ ...config, cookieSecret: "test-cookie-secret", adminUsers: ["actual"] }, models, { developmentLocalAccounts: [{ username: "actual", password: "local-test-secret", owner: true }] });
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const recovery = await identityService.createInvitation(undefined, { intendedUsername: "recovery-owner", initialRoleId: "role_owner" });
      const update = await app.inject({ method: "POST", url: "/admin/auth/local/update", headers: auth, payload: { id: "local", type: "local", displayName: "Username and password" } });
      expect(update.statusCode).toBe(302);

      const login = await app.inject({ method: "GET", url: "/login" });
      expect(login.body).toContain("Username and password sign-in is disabled");
      expect(login.body).not.toContain('action="/login"');
      expect((await app.inject({ method: "GET", url: "/api/model-selection", headers: auth })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/register" })).body).toContain("Only a one-time Owner recovery link can be used");
      const recovered = await app.inject({ method: "POST", url: "/register", payload: { token: recovery.token, username: "recovery-owner", password: "recovery-password", confirmPassword: "recovery-password" } });
      expect(recovered.statusCode).toBe(302);
      const recoveredCookie = String(recovered.headers["set-cookie"]).split(";")[0];
      expect((await app.inject({ method: "GET", url: "/admin/users", headers: { cookie: recoveredCookie } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("registers invited users and merges duplicate accounts through the admin API", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const accountConfig = { ...config, cookieSecret: "test-cookie-secret", adminUsers: ["actual"] };
    const { app } = await buildApp(accountConfig, models);
    const adminAuth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const nonAdminAuth = { authorization: `Basic ${Buffer.from("other:local-test-secret").toString("base64")}` };

    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: nonAdminAuth })).statusCode).toBe(403);

      for (const username of ["duplicate-github", "duplicate-oidc"]) {
        const invitationResponse = await app.inject({
          method: "POST",
          url: "/api/admin/users/invitations",
          headers: adminAuth,
          payload: { intendedUsername: username, initialRoleId: "role_member", expiresInMinutes: 30 }
        });
        expect(invitationResponse.statusCode).toBe(201);
        expect(invitationResponse.json().invitation).not.toHaveProperty("tokenHash");
        const registration = await app.inject({
          method: "POST",
          url: "/register",
          payload: { token: invitationResponse.json().token, username, password: `${username}-password`, confirmPassword: `${username}-password` }
        });
        expect(registration.statusCode).toBe(302);
      }

      const sourceAuth = { authorization: `Basic ${Buffer.from("duplicate-github:duplicate-github-password").toString("base64")}` };
      const targetAuth = { authorization: `Basic ${Buffer.from("duplicate-oidc:duplicate-oidc-password").toString("base64")}` };
      const profile = await app.inject({
        method: "POST",
        url: "/api/reservation-profiles",
        headers: sourceAuth,
        payload: { name: "Preserved profile", selections: [{ targetId: "t1", modelIds: ["m1"] }] }
      });
      expect(profile.statusCode).toBe(201);

      const users = (await app.inject({ method: "GET", url: "/api/admin/users", headers: adminAuth })).json().users as Array<{ id: string; username: string }>;
      const source = users.find((user) => user.username === "duplicate-github")!;
      const targetUser = users.find((user) => user.username === "duplicate-oidc")!;
      const preview = await app.inject({ method: "POST", url: "/api/admin/users/merge/preview", headers: adminAuth, payload: { sourceUserId: source.id, targetUserId: targetUser.id } });
      expect(preview.json()).toMatchObject({ counts: { profiles: 1 } });
      const merged = await app.inject({ method: "POST", url: "/api/admin/users/merge", headers: adminAuth, payload: { sourceUserId: source.id, targetUserId: targetUser.id, confirm: "MERGE" } });
      expect(merged.statusCode).toBe(200);

      expect((await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: sourceAuth })).statusCode).toBe(401);
      const targetProfiles = await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: targetAuth });
      expect(targetProfiles.statusCode).toBe(200);
      expect(targetProfiles.json().reservationProfiles).toMatchObject([{ name: "Preserved profile", userId: targetUser.id }]);

      const renamed = await app.inject({ method: "PUT", url: `/api/admin/users/${targetUser.id}/name`, headers: adminAuth, payload: { username: source.username, displayName: "Canonical duplicate" } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ id: targetUser.id, username: source.username, displayName: "Canonical duplicate" });
      expect((await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: targetAuth })).statusCode).toBe(401);
      const renamedAuth = { authorization: `Basic ${Buffer.from(`${source.username}:duplicate-oidc-password`).toString("base64")}` };
      expect((await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: renamedAuth })).json().reservationProfiles).toMatchObject([{ username: source.username, userId: targetUser.id }]);
      const renamedUsers = (await app.inject({ method: "GET", url: "/api/admin/users", headers: adminAuth })).json().users as Array<{ id: string; username: string; mergedIntoUserId?: string }>;
      expect(renamedUsers.find((user) => user.id === source.id)).toMatchObject({ username: expect.stringContaining(`[merged ${source.id}]`), mergedIntoUserId: targetUser.id });
    } finally {
      await app.close();
    }
  });

  it("organizes accounts, invitations, authentication, and teams into focused admin screens", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({ ...config, adminUsers: ["actual"] }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const accounts = await app.inject({ method: "GET", url: "/admin/users", headers: auth });
      expect(accounts.statusCode).toBe(200);
      expect(accounts.body).toContain("<h1>Accounts</h1>");
      expect(accounts.body).toContain("Invite user");
      expect(accounts.body).toContain("Invitations (");
      expect(accounts.body).toContain("Merge users");
      expect(accounts.body).toContain('href="/admin/teams">Teams</a>');
      expect(accounts.body).toContain('href="/admin/hassleoff">HassleOff</a>');
      expect(accounts.body).not.toContain("Users and teams");

      const invitation = await app.inject({ method: "POST", url: "/admin/users/invitations", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ intendedUsername: "invitee", initialRoleId: "role_member", expiresInMinutes: "60" }).toString() });
      expect(invitation.statusCode).toBe(200);
      expect(invitation.body).toContain('href="/admin/users?tab=invitations" role="tab" aria-selected="true"');
      expect(invitation.body).toContain("Copy registration link");
      expect(invitation.body).toContain("data-registration-url");
      expect(invitation.body).toContain("Copy was blocked. The link is selected");

      const createdTeam = await app.inject({ method: "POST", url: "/admin/teams", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ name: "Platform", description: "Platform users" }).toString() });
      expect(createdTeam.statusCode).toBe(302);
      const teams = await app.inject({ method: "GET", url: "/admin/teams", headers: auth });
      expect(teams.statusCode).toBe(200);
      expect(teams.body).toContain("<h1>Teams</h1>");
      expect(teams.body).toContain("Platform users");
      expect(teams.body).toContain("Create team");
      expect(teams.body).toContain('class="subsection-divider"><h3>Add member</h3>');

      const authentication = await app.inject({ method: "GET", url: "/admin/auth", headers: auth });
      expect(authentication.body).toContain('href="/admin/auth?tab=methods"');
      expect(authentication.body).toContain('href="/admin/auth?tab=oidc"');
      expect(authentication.body).toContain('href="/admin/auth?tab=github"');
    } finally {
      await app.close();
    }
  });

  it("uses the authenticated username instead of POST body username", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const response = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` },
      payload: { username: "spoofed", modelIds: ["m1"], durationMinutes: 10 }
    });
    await app.close();
    expect(response.statusCode).toBe(201);
    expect(response.json().username).toBe("actual");
  });

  it("creates reservation profiles and starts reservations from them", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const createdProfile = await app.inject({
      method: "POST",
      url: "/api/reservation-profiles",
      headers: auth,
      payload: {
        name: "Daily coding",
        description: "Small target profile",
        selections: [{ targetId: "t1", modelIds: ["m1"] }],
        defaultDurationMinutes: 10,
        defaultKeepaliveMinutes: 2
      }
    });
    expect(createdProfile.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: auth });
    expect(list.json().reservationProfiles).toMatchObject([{ name: "Daily coding", selections: [{ targetId: "t1", modelIds: ["m1"] }] }]);

    const reservation = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { profileId: createdProfile.json().id }
    });
    await app.close();

    expect(reservation.statusCode).toBe(201);
    expect(reservation.json()).toMatchObject({
      profileId: createdProfile.json().id,
      profileName: "Daily coding",
      modelIds: ["m1"],
      targets: [{ id: "t1" }]
    });
  });

  it("auto-selects a target's only model and preserves multi-target profile mappings on reservations", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const multiConfig: AppConfig = {
      ...config,
      capacityTargets: [
        { id: "t1", displayName: "T1", provider: "aws-ecs", modelIds: ["m1"] },
        { id: "t2", displayName: "T2", provider: "aws-ecs", modelIds: ["m2", "m3"] }
      ]
    };
    const multiModels: ModelDefinition[] = [
      { id: "m1", displayName: "M1", aliases: ["m1"], targetIds: ["t1"] },
      { id: "m2", displayName: "M2", aliases: ["m2"], targetIds: ["t2"] },
      { id: "m3", displayName: "M3", aliases: ["m3"], targetIds: ["t2"] }
    ];
    const { app } = await buildApp(multiConfig, multiModels);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const createdProfile = await app.inject({
      method: "POST",
      url: "/api/reservation-profiles",
      headers: auth,
      payload: { name: "Two targets", selections: [{ targetId: "t1", modelIds: [] }, { targetId: "t2", modelIds: ["m3"] }], defaultDurationMinutes: 10 }
    });
    expect(createdProfile.statusCode).toBe(201);
    expect(createdProfile.json().selections).toEqual([{ targetId: "t1", modelIds: ["m1"] }, { targetId: "t2", modelIds: ["m3"] }]);

    const reservation = await app.inject({ method: "POST", url: "/api/reservations", headers: auth, payload: { profileId: createdProfile.json().id } });
    await app.close();

    expect(reservation.statusCode).toBe(201);
    expect(reservation.json()).toMatchObject({
      modelIds: ["m1", "m3"],
      targetSelections: [{ targetId: "t1", modelIds: ["m1"] }, { targetId: "t2", modelIds: ["m3"] }],
      targets: [{ id: "t1" }, { id: "t2" }]
    });
  });

  it("shares team profiles with members and presents the assignment on the dedicated editor", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app, identityService } = await buildApp({ ...config, adminUsers: ["actual"] }, models);
    const ownerAuth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const memberAuth = { authorization: `Basic ${Buffer.from("other:local-test-secret").toString("base64")}` };
    try {
      const users = await identityService.listUsers();
      const owner = (await identityService.authenticatedUser(users.find((user) => user.username === "actual")!.id))!;
      const member = users.find((user) => user.username === "other")!;
      const team = await identityService.createTeam(owner, { name: "Platform" });
      await identityService.setTeamMembership(owner, { teamId: team.id, userId: member.id, roleId: "role_team_member", source: "manual" });

      const editor = await app.inject({ method: "GET", url: "/profiles/new", headers: ownerAuth });
      expect(editor.statusCode).toBe(200);
      expect(editor.body).toContain('class="button secondary" href="/profiles">← Back to profiles</a>');
      expect(editor.body).toContain('class="profile-audience"');
      expect(editor.body).toContain("Audience");
      expect(editor.body).toContain("Everyone");
      expect(editor.body).toContain(`value="team:${team.id}"`);
      expect(editor.body).toContain("Team: Platform");

      const created = await app.inject({ method: "POST", url: "/api/reservation-profiles", headers: ownerAuth, payload: { teamId: team.id, name: "Shared coding", selections: [{ targetId: "t1", modelIds: ["m1"] }] } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ teamId: team.id, name: "Shared coding" });
      const memberProfiles = await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: memberAuth });
      expect(memberProfiles.json().reservationProfiles).toMatchObject([{ id: created.json().id, teamId: team.id }]);
      const memberPage = await app.inject({ method: "GET", url: "/profiles", headers: memberAuth });
      expect(memberPage.body).toContain("Team: Platform");
      expect(memberPage.body).not.toContain(`/profiles/${created.json().id}/edit`);
      const memberEditor = await app.inject({ method: "GET", url: "/profiles/new", headers: memberAuth });
      expect(memberEditor.body).toContain(`value="team:${team.id}"`);
      const memberShared = await app.inject({ method: "POST", url: "/api/reservation-profiles", headers: memberAuth, payload: { sharingScope: "team", teamId: team.id, name: "Member shared", selections: [{ targetId: "t1", modelIds: ["m1"] }] } });
      expect(memberShared.statusCode).toBe(201);
      expect(memberShared.json()).toMatchObject({ userId: member.id, sharingScope: "team", teamId: team.id });
      const everyone = await app.inject({ method: "POST", url: "/api/reservation-profiles", headers: ownerAuth, payload: { sharingScope: "everyone", name: "For everyone", selections: [{ targetId: "t1", modelIds: ["m1"] }] } });
      expect(everyone.statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: memberAuth })).json().reservationProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: everyone.json().id, sharingScope: "everyone" })]));
      const reservation = await app.inject({ method: "POST", url: "/api/reservations", headers: memberAuth, payload: { profileId: created.json().id, durationMinutes: 5 } });
      expect(reservation.statusCode).toBe(201);
      expect(reservation.json()).toMatchObject({ profileId: created.json().id, username: "other" });
    } finally {
      await app.close();
    }
  });

  it("requires model choices when a selected target exposes multiple models", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const targetWithChoices = { id: "t1", displayName: "T1", provider: "aws-ecs", modelIds: ["m1", "m2"] };
    const choiceModels: ModelDefinition[] = [
      { id: "m1", displayName: "M1", aliases: ["m1"], targetIds: ["t1"] },
      { id: "m2", displayName: "M2", aliases: ["m2"], targetIds: ["t1"] }
    ];
    const { app } = await buildApp({ ...config, capacityTargets: [targetWithChoices] }, choiceModels);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const response = await app.inject({ method: "POST", url: "/api/reservation-profiles", headers: auth, payload: { name: "Incomplete", selections: [{ targetId: "t1", modelIds: [] }] } });
    await app.close();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Choose at least one model");
  });

  it("serves a profiles page for the current user's reservation profiles", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/reservation-profiles",
      headers: auth,
      payload: { name: "Daily coding", selections: [{ targetId: "t1", modelIds: ["m1"] }] }
    });

    const page = await app.inject({ method: "GET", url: "/profiles", headers: auth });
    const newPage = await app.inject({ method: "GET", url: "/profiles/new", headers: auth });
    const onboardingPage = await app.inject({ method: "GET", url: "/profiles/new?onboarding=1", headers: auth });
    const editPage = await app.inject({ method: "GET", url: `/profiles/${created.json().id}/edit`, headers: auth });
    const updated = await app.inject({
      method: "POST",
      url: `/reservation-profiles/${created.json().id}`,
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        name: "Daily coding updated",
        selectionTargetIds: "t1",
        selectionModels: JSON.stringify({ targetId: "t1", modelId: "m1" }),
        defaultDurationMinutes: "15",
        defaultKeepaliveMinutes: "5",
        returnTo: "/profiles"
      }).toString()
    });
    const refreshed = await app.inject({ method: "GET", url: "/api/reservation-profiles", headers: auth });
    await app.close();

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Profiles");
    expect(page.body).toContain("Daily coding");
    expect(page.body).toContain("T1");
    expect(page.body).toContain("m1");
    expect(page.body).toContain("New profile");
    expect(page.body).toContain(`/profiles/${created.json().id}/edit`);
    expect(newPage.statusCode).toBe(200);
    expect(newPage.body).toContain("New reservation profile");
    expect(newPage.body).toContain('class="button secondary" href="/profiles">← Back to profiles</a>');
    expect(newPage.body).toContain('class="profile-audience"');
    expect(newPage.body).toContain("Audience");
    expect(newPage.body).toContain("Everyone");
    expect(newPage.body).toContain("Only me");
    expect(newPage.body).toContain('class="profile-save-bar"');
    expect(newPage.body).toContain('id="profile-save-review-modal"');
    expect(newPage.body).toContain('name="returnTo" value="/profiles"');
    expect(onboardingPage.body).toContain('name="returnTo" value="/"');
    expect(editPage.statusCode).toBe(200);
    expect(editPage.body).toContain("Edit Daily coding");
    expect(editPage.body).toContain(`action="/reservation-profiles/${created.json().id}"`);
    expect(updated.statusCode).toBe(302);
    expect(updated.headers.location).toBe("/profiles");
    expect(refreshed.json().reservationProfiles).toMatchObject([{
      name: "Daily coding updated",
      selections: [{ targetId: "t1", modelIds: ["m1"] }],
      defaultDurationMinutes: 15,
      defaultKeepaliveMinutes: 5
    }]);
  });

  it("creates reservation profiles from the profiles page and returns there", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const response = await app.inject({
      method: "POST",
      url: "/reservation-profiles",
      headers: auth,
      payload: {
        name: "Profiles page profile",
        profileAudience: "everyone",
        targetId: "t1",
        modelIds: "m1",
        defaultDurationMinutes: 15,
        defaultKeepaliveMinutes: 5,
        returnTo: "/profiles"
      }
    });
    const page = await app.inject({ method: "GET", url: "/profiles", headers: auth });
    await app.close();

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/profiles");
    expect(page.body).toContain("Profiles page profile");
    expect(page.body).toContain("Everyone");
  });

  it("keeps direct reservation creation working without a reservation profile", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const routingModels: ModelDefinition[] = [{ ...models[0], aliases: ["fast"], backendModelIds: ["llama-m1"] }];
    const { app } = await buildApp({
      ...config,
      litellmApiBaseUrl: "https://litellm.example.test/v1",
      litellmUiUrl: "https://console.example.test/playground",
      capacityTargets: [{
        ...config.capacityTargets[0],
        apiUrl: "https://runtime.example.test/models/v1?ignored=1",
        models: [{ id: "m1", displayName: "M1", aliases: ["fast"], backendModelIds: ["llama-m1"] }]
      }]
    }, routingModels);
    const response = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` },
      payload: { modelIds: ["m1"], targetIds: ["t1"], durationMinutes: 10 }
    });
    const page = await app.inject({
      method: "GET",
      url: `/reservations/${response.json().reservationId}`,
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` }
    });
    const home = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` }
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      modelIds: ["m1"],
      targets: [{ id: "t1", displayName: "T1", directHostUrl: "https://runtime.example.test/models/" }]
    });
    expect(response.json().profileId).toBeUndefined();
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("Your reservations");
    expect(page.body).toContain("setInterval(updateReservationTime, 1000)");
    expect(page.body).toContain("String(seconds).padStart(2, '0')");
    expect(page.body).toContain("<h2>Connect</h2>");
    expect(page.body).toContain("LiteLLM gateway");
    expect(page.body).toContain("Direct model host");
    expect(page.body).toContain('aria-label="Open LiteLLM"');
    expect(page.body).toContain("https://console.example.test/playground");
    expect(page.body).not.toContain("https://litellm.example.test/ui/");
    expect(page.body).toContain('aria-label="Connect"');
    expect(page.body).toContain("<strong>Use</strong> pins this deployment");
    expect(page.body).toContain("<strong>Fallback</strong> may route to another target");
    expect(page.body).toContain('data-copy="fast"');
    expect(page.body).toContain('data-copy="t1/fast"');
    expect(page.body).not.toContain('data-copy="m1"');
    expect(page.body).toContain('data-copy="llama-m1"');
    expect(page.body).toContain('aria-label="Open direct model host"');
    expect(page.body).toContain('data-direct-host-target="t1" hidden');
    expect(page.body).toContain("https://runtime.example.test/models/");
    expect(page.body).not.toContain("ignored=1");
  });

  it("hides expired reservations from the default status payload", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const active = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 10 }
    });
    const expired = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 10 }
    });
    await app.inject({ method: "POST", url: `/api/reservations/${expired.json().reservationId}/done`, headers: auth });

    const status = await app.inject({ method: "GET", url: "/api/status", headers: auth });
    const adminStatus = await app.inject({ method: "GET", url: "/api/admin/status", headers: auth });
    await app.close();

    expect(status.json().reservations.map((reservation: { reservationId: string }) => reservation.reservationId)).toEqual([active.json().reservationId]);
    expect(adminStatus.json().reservations.map((reservation: { reservationId: string }) => reservation.reservationId)).toContain(expired.json().reservationId);
  });

  it("paginates admin reservation history by expiration descending", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const shorter = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 5 }
    });
    const longer = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 30 }
    });

    const firstPage = await app.inject({ method: "GET", url: "/api/admin/reservations?page=1&pageSize=1", headers: auth });
    const secondPage = await app.inject({ method: "GET", url: "/api/admin/reservations?page=2&pageSize=1", headers: auth });
    const page = await app.inject({ method: "GET", url: "/admin/reservations", headers: auth });
    await app.close();

    expect(firstPage.json()).toMatchObject({ page: 1, pageSize: 1, total: 2, sort: "expires_desc" });
    expect(firstPage.json().reservations.map((reservation: { reservationId: string }) => reservation.reservationId)).toEqual([longer.json().reservationId]);
    expect(secondPage.json().reservations.map((reservation: { reservationId: string }) => reservation.reservationId)).toEqual([shorter.json().reservationId]);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Reservations");
    expect(page.body).toContain("expires newest first");
  });

  it("includes reservation cost estimates after reconciler allocation", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app, reconciler } = await buildApp({
      ...config,
      capacityTargets: [{ ...config.capacityTargets[0], costEstimate: { hourlyUsd: 12 } }]
    }, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 60 }
    });
    await reconciler.requestReconcile();
    await reconciler.reconcile(new Date(Date.now() + 15 * 60_000));

    const response = await app.inject({ method: "GET", url: `/api/reservations/${created.json().reservationId}`, headers: auth });
    await app.close();

    expect(response.json().costEstimate.currency).toBe("USD");
    expect(response.json().costEstimate.estimatedCostUsd).toBeCloseTo(3, 2);
    expect(response.json().costEstimate.projectedTotalCostUsd).toBeGreaterThanOrEqual(3);
  });

  it("creates API keys, authenticates bearer requests, and revokes keys", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: auth,
      payload: { name: "Plugin integration" }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.token).toMatch(/^sk-neuron-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/);
    expect(createdBody.apiKey.name).toBe("Plugin integration");
    expect(createdBody.apiKey.prefix).toMatch(/^sk-neuron-/);

    const list = await app.inject({ method: "GET", url: "/api/api-keys", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(createdBody.token);
    expect(list.json().apiKeys).toMatchObject([{ id: createdBody.apiKey.id, name: "Plugin integration", prefix: createdBody.apiKey.prefix }]);

    const bearerModels = await app.inject({
      method: "GET",
      url: "/api/models",
      headers: { authorization: `Bearer ${createdBody.token}` }
    });
    expect(bearerModels.statusCode).toBe(200);
    expect(bearerModels.json().models).toHaveLength(1);

    const bearerReservation = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { authorization: `Bearer ${createdBody.token}` },
      payload: { modelIds: ["m1"], durationMinutes: 2, keepaliveMinutes: 2 }
    });
    expect(bearerReservation.statusCode).toBe(201);
    expect(bearerReservation.json()).toMatchObject({
      username: "actual",
      displayUsername: "actual ( Plugin integration )"
    });

    const bearerStatus = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${createdBody.token}` }
    });
    expect(bearerStatus.json().capacityTargets[0].activeUsers).toContain("actual ( Plugin integration )");

    const usedList = await app.inject({ method: "GET", url: "/api/api-keys", headers: auth });
    expect(usedList.json().apiKeys[0].lastUsedAt).toEqual(expect.any(String));

    const revoked = await app.inject({ method: "DELETE", url: `/api/api-keys/${createdBody.apiKey.id}`, headers: auth });
    expect(revoked.statusCode).toBe(204);

    const revokedBearerModels = await app.inject({
      method: "GET",
      url: "/api/models",
      headers: { authorization: `Bearer ${createdBody.token}` }
    });
    await app.close();
    expect(revokedBearerModels.statusCode).toBe(401);
  });

  it("exposes an OpenAPI v3 document with bearer auth and API key routes", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const openapi = response.json();
    expect(openapi.openapi).toBe("3.0.3");
    expect(openapi.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(openapi.paths["/api/api-keys"]).toBeDefined();
    expect(openapi.paths["/mcp"]).toBeDefined();
  });

  it("serves MCP tools over authenticated JSON-RPC", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const initialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: auth,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" }
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.serverInfo.name).toBe("neuron-control-plane");

    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: auth,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" }
    });
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toContain("create_reservation");

    const modelCall = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: auth,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_models", arguments: {} } }
    });
    await app.close();

    expect(modelCall.statusCode).toBe(200);
    expect(modelCall.json().result.structuredContent.models).toHaveLength(1);
  });

  it("serves admin provider management and creates persisted providers", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const page = await app.inject({ method: "GET", url: "/admin/providers", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("AWS ECS");
    expect(page.body).toContain("Targets");
    expect(page.body).toContain("1 targets");
    expect(page.body).toContain("CAPACITY_PROVIDERS_JSON");

    const created = await app.inject({
      method: "POST",
      url: "/admin/providers",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "runpod-main",
        displayName: "RunPod Main",
        type: "runpod"
      }).toString()
    });
    expect(created.statusCode).toBe(302);

    const updated = await app.inject({
      method: "POST",
      url: "/admin/providers/runpod-main/update",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "runpod-shared",
        displayName: "RunPod Shared",
        type: "runpod",
        provisioningEnabled: "on"
      }).toString()
    });
    expect(updated.statusCode).toBe(302);

    const refreshed = await app.inject({ method: "GET", url: "/admin/providers", headers: auth });
    await app.close();
    expect(refreshed.body).toContain("RunPod Shared");
    expect(refreshed.body).toContain("runpod-shared");
    expect(refreshed.body).toContain("Save provider");
  });

  it("creates AWS EC2 providers and targets for pre-created instances", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const providersPage = await app.inject({ method: "GET", url: "/admin/providers", headers: auth });
    expect(providersPage.body).toContain('<option value="aws-ec2"');

    const provider = await app.inject({
      method: "POST",
      url: "/admin/providers",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "aws-ec2",
        displayName: "AWS EC2",
        type: "aws-ec2",
        awsEc2InstanceNamePattern: "*.prefer.*"
      }).toString()
    });
    expect(provider.statusCode).toBe(302);

    const target = await app.inject({
      method: "POST",
      url: "/admin/targets",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "prefer-gpu",
        displayName: "PreFer GPU",
        providerId: "aws-ec2",
        modelIds: "qwen",
        awsInstanceId: "i-1234567890abcdef0",
        awsRuntimePort: "8080",
        estimatedHourlyCostUsd: "0.804"
      }).toString()
    });
    expect(target.statusCode).toBe(302);
    expect(target.headers.location).toBe("/admin/targets?created=prefer-gpu");

    const targetsPage = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    expect(targetsPage.body).toContain("PreFer GPU");
    expect(targetsPage.body).toContain("i-1234567890abcdef0");
    expect(targetsPage.body).toContain("CAPACITY_TARGET_PREFER_GPU_AWS_INSTANCE_ID");
    expect(targetsPage.body).toContain("CAPACITY_TARGET_PREFER_GPU_AWS_RUNTIME_PORT");
    expect(targetsPage.body).toContain("CAPACITY_TARGET_PREFER_GPU_ESTIMATED_HOURLY_COST_USD");
    expect(targetsPage.body).toContain("Find EC2 instances");
    expect(targetsPage.body).toContain("setInterval(refreshTargetStatus, 10000)");
    expect(providersPage.body).toContain("Instance Name-tag pattern");

    const refreshedProviders = await app.inject({ method: "GET", url: "/admin/providers", headers: auth });
    expect(refreshedProviders.body).toContain("*.prefer.*");
    expect(refreshedProviders.body).toContain("CAPACITY_PROVIDER_AWS_EC2_AWS_EC2_INSTANCE_NAME_PATTERN");

    const missingInstance = await app.inject({
      method: "POST",
      url: "/admin/targets",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "missing-instance",
        providerId: "aws-ec2"
      }).toString()
    });
    await app.close();

    expect(missingInstance.statusCode).toBe(302);
    expect(missingInstance.headers.location).toContain("AWS%20EC2%20instance%20ID%20is%20required");
  });

  it("serves admin auth management and creates persisted GitHub methods", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const page = await app.inject({ method: "GET", url: "/admin/auth", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Authentication");
    expect(page.body).toContain("Add GitHub auth");

    const created = await app.inject({
      method: "POST",
      url: "/admin/auth",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "github-main",
        displayName: "GitHub Main",
        enabled: "on",
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedUsers: "actual",
        allowedOrganizations: "neuron"
      }).toString()
    });
    expect(created.statusCode).toBe(302);

    const refreshed = await app.inject({ method: "GET", url: "/admin/auth", headers: auth });
    await app.close();
    expect(refreshed.body).toContain("GitHub Main");
    expect(refreshed.body).toContain("github-main");
    expect(refreshed.body).toContain("actual");
    expect(refreshed.body).toContain("neuron");
    expect(refreshed.body).not.toContain("client-secret");
  });

  it("starts GitHub OAuth for configured auth methods", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp({
      ...config,
      cookieSecret: "test-cookie-secret",
      authMethods: [{
        id: "github",
        displayName: "GitHub",
        type: "github",
        enabled: true,
        config: { github: { clientId: "client-id", clientSecret: "client-secret" } }
      }]
    }, models);

    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.body).toContain("Sign in with GitHub");

    const response = await app.inject({ method: "GET", url: "/auth/github/start?method=github", headers: { host: "neuron.test" } });
    await app.close();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://github.com/login/oauth/authorize");
    expect(response.headers.location).toContain("client_id=client-id");
    expect(response.headers.location).toContain("redirect_uri=http%3A%2F%2Fneuron.test%2Fauth%2Fgithub%2Fcallback");
  });

  it("serves update safety controls and enters drain mode before restart", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const page = await app.inject({ method: "GET", url: "/admin/updates", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Restart when safe");
    expect(page.body).toContain("Restart immediately without stopping targets");
    expect(page.body).toContain("leave machines running");

    const unacknowledged = await app.inject({
      method: "POST",
      url: "/admin/updates/force",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ stopTargets: "no", confirm: "RESTART" }).toString()
    });
    expect(unacknowledged.headers.location).toContain("Acknowledge%20the%20unmanaged-capacity%20risk");

    const scheduled = await app.inject({ method: "POST", url: "/admin/updates/schedule", headers: auth });
    expect(scheduled.statusCode).toBe(302);
    const status = await app.inject({ method: "GET", url: "/api/admin/update-status", headers: auth });
    expect(status.json().shutdown.acceptingReservations).toBe(false);
    const blockedReservation = await app.inject({ method: "POST", url: "/api/reservations", headers: auth, payload: { modelIds: ["m1"], durationMinutes: 5 } });
    expect(blockedReservation.statusCode).toBe(503);
    expect(blockedReservation.json().error).toContain("draining for restart");
    await app.close();
  });

  it("creates OIDC methods with secret references and never renders stored secret values", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const created = await app.inject({
      method: "POST",
      url: "/admin/auth",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        type: "oidc",
        id: "okta",
        displayName: "Company Okta",
        enabled: "on",
        issuer: "https://company.okta.com/oauth2/default",
        clientId: "oidc-client-id",
        clientSecretSource: "stored",
        clientSecret: "do-not-render-this",
        scopes: "openid,profile,email,groups",
        usernameClaim: "email",
        groupsClaim: "groups",
        allowedGroups: "neuron-users"
      }).toString()
    });
    expect(created.statusCode).toBe(302);

    const page = await app.inject({ method: "GET", url: "/admin/auth", headers: auth });
    const login = await app.inject({ method: "GET", url: "/login" });
    await app.close();

    expect(page.body).toContain("Company Okta");
    expect(page.body).toContain("Stored in NeurOn database (value hidden)");
    expect(page.body).toContain("Avoid this option in production");
    expect(page.body).not.toContain("do-not-render-this");
    expect(login.body).toContain('action="/auth/oidc/start"');
    expect(login.body).toContain("Sign in with Company Okta");
  });

  it("copies declarative providers into persisted storage from the admin UI", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const copied = await app.inject({ method: "POST", url: "/admin/providers/aws-ecs/copy-to-db", headers: auth });
    expect(copied.statusCode).toBe(302);

    const page = await app.inject({ method: "GET", url: "/admin/providers", headers: auth });

    expect(page.body).toContain("JSON");
    expect(page.body).toContain("CAPACITY_PROVIDERS_JSON");
    expect(page.body.match(/aws-ecs/g)?.length).toBeGreaterThan(1);
    expect(page.body).toContain("persisted");
    expect(page.body).toContain("1 targets");

    const updated = await app.inject({
      method: "POST",
      url: "/admin/providers/aws-ecs/update",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "aws-ecs",
        displayName: "AWS ECS Stored",
        type: "aws-ecs"
      }).toString()
    });
    expect(updated.statusCode).toBe(302);
    await app.close();
  });

  it("serves admin target management and creates persisted targets", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const team = await app.inject({ method: "POST", url: "/api/admin/teams", headers: auth, payload: { name: "Platform" } });
    expect(team.statusCode).toBe(201);
    const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("T1");
    expect(page.body).toContain("CAPACITY_TARGET_KEYS=T1");
    expect(page.body).toContain('name="audienceScope"');
    expect(page.body).toContain('name="audienceTeamIds"');
    expect(page.body).toContain('name="audienceUserIds"');
    expect(page.body).toContain("Platform");
    expect(page.body).toContain("actual");
    expect(page.body).not.toContain('name="hostingMode"');

    const created = await app.inject({
      method: "POST",
      url: "/admin/targets",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "runpod-qwen",
        displayName: "RunPod Qwen",
        providerId: "runpod",
        modelIds: "qwen",
        trafficModelPrefixes: "runpod/",
        audienceScope: "teams",
        audienceTeamIds: team.json().id,
        runpodPodId: "pod-qwen",
        runpodRuntimePort: "8080"
      }).toString()
    });
    expect(created.statusCode).toBe(302);
    const createdTargets = await app.inject({ method: "GET", url: "/api/admin/targets", headers: auth });
    expect(createdTargets.json().capacityTargets.find((target: { id: string }) => target.id === "runpod-qwen")).toMatchObject({
      audience: { scope: "teams", teamIds: [team.json().id] },
      hostingMode: "dedicated"
    });

    const updated = await app.inject({
      method: "POST",
      url: "/admin/targets/runpod-qwen/update",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "runpod-prefer",
        displayName: "RunPod PreFer",
        providerId: "runpod",
        modelIds: "qwen,gemma",
        trafficModelPrefixes: "clint-desktop/,prefer/",
        litellmCredentialName: "neuron/runpod-prefer",
        litellmApiKeyEnv: "PREFER_RUNPOD_API_KEY",
        runpodPodId: "pod-prefer",
        runpodRuntimePort: "8081"
      }).toString()
    });
    expect(updated.statusCode).toBe(302);

    const targets = await app.inject({ method: "GET", url: "/api/admin/targets", headers: auth });
    const refreshed = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    await app.close();

    const storedTarget = targets.json().capacityTargets.find((target: { id: string }) => target.id === "runpod-prefer");
    expect(storedTarget).toMatchObject({
      trafficModelPrefixes: ["clint-desktop/", "prefer/"],
      litellmDisplayPrefix: "clint-desktop/",
      litellm: {
        credentialName: "neuron/runpod-prefer",
        apiKeyEnv: "PREFER_RUNPOD_API_KEY"
      },
      audience: { scope: "global" },
      hostingMode: "multi-model"
    });
    expect(targets.json().capacityTargets.find((target: { id: string }) => target.id === "t1")).toMatchObject({
      trafficModelPrefixes: ["t1/"],
      litellmDisplayPrefix: "t1/"
    });
    expect(refreshed.body).toContain("RunPod PreFer");
    expect(refreshed.body).toContain("pod-prefer");
    expect(refreshed.body).toContain("clint-desktop/");
    expect(refreshed.body).toContain("PREFER_RUNPOD_API_KEY");
    expect(refreshed.body).toContain("LiteLLM model route prefixes");
    expect(refreshed.body).toContain("Save target");
  });

  it("creates PreFer Docker targets with model volume and discovery URLs", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const created = await app.inject({
      method: "POST",
      url: "/admin/targets",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "prefer-local",
        displayName: "PreFer Local",
        providerId: "docker",
        runtimeProfileId: "prefer",
        runtimeProfileVariantId: "smol",
        dockerContainerName: "prefer"
      }).toString()
    });
    expect(created.statusCode).toBe(302);

    const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    await app.close();

    expect(page.body).toContain("prefer-model-cache");
    expect(page.body).toContain("LLAMA_ARG_MODELS_PRESET");
    expect(page.body).toContain("/presets/smol.ini");
    expect(page.body).toContain("http://host.docker.internal:8080/health");
    expect(page.body).toContain("http://host.docker.internal:8080/v1");
  });

  it("copies declarative targets into persisted storage from the admin UI", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

    const copied = await app.inject({ method: "POST", url: "/admin/targets/t1/copy-to-db", headers: auth });
    expect(copied.statusCode).toBe(302);

    const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });

    expect(page.body).toContain("JSON");
    expect(page.body).toContain("CAPACITY_TARGET_KEYS=T1");
    expect(page.body.match(/t1/g)?.length).toBeGreaterThan(1);
    expect(page.body).toContain("persisted");
    expect(page.body).toContain("Save target");

    const aliases = await app.inject({
      method: "PUT",
      url: "/api/admin/targets/t1/models/m1/aliases",
      headers: auth,
      payload: { aliases: ["code", "general"] }
    });
    expect(aliases.statusCode).toBe(200);
    expect(aliases.json()).toMatchObject({ targetId: "t1", modelId: "m1", aliases: ["code", "general"] });
    const clientModels = await app.inject({ method: "GET", url: "/api/client-models", headers: auth });
    expect(clientModels.json().models).toMatchObject([{
      targetId: "t1",
      modelId: "m1",
      aliases: { global: ["code", "general"], scoped: ["t1/code", "t1/general"] }
    }]);

    const updated = await app.inject({
      method: "POST",
      url: "/admin/targets/t1/update",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        id: "t1",
        displayName: "T1 Stored",
        providerId: "aws-ecs",
        modelIds: "m1,m2",
        awsCluster: "cluster",
        awsService: "service",
        awsAsgName: "asg"
      }).toString()
    });
    expect(updated.statusCode).toBe(302);

    const afterUpdate = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    expect(afterUpdate.body).toContain("T1 Stored");
    expect(afterUpdate.body).not.toContain(">T1</strong>");

    const deleted = await app.inject({
      method: "POST",
      url: "/admin/targets/t1/delete",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ confirmName: "t1" }).toString()
    });
    expect(deleted.statusCode).toBe(302);

    const afterDelete = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    expect(afterDelete.body).toContain(">T1</strong>");
    expect(afterDelete.body).toContain("config");
    await app.close();
  });
});

describe("HassleOff admin safety UI", () => {
  const safetyConfig: AppConfig = {
    ...config,
    cookieSecret: "test-cookie-secret",
    adminUsers: ["actual"],
    hassleOff: {
      baseUrl: "http://hassleoff.example.test:8091",
      controllerToken: "controller-token-never-in-browser",
      controllerId: "neuron-test",
      requestTimeoutSeconds: 2,
      failSafeTestTargetId: "hassleoff-failsafe-test",
      allowInsecureHttp: true
    }
  };
  const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };

  it("shows an actionable unconfigured state without changing the default deployment", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    try {
      const page = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: auth });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("configured: no");
      expect(page.body).toContain("Controller URL:");
      expect(page.body).toContain("Not configured");
      expect(page.body).not.toContain(">Run fail-safe test</button>");
    } finally {
      await app.close();
    }
  });

  it("shows server-side readiness and runs the confirmed synthetic fail-safe test", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/status")) return jsonResponse({
        protocolVersion: "1",
        service: { healthy: true, ready: true, armed: true, registrationIssues: [] },
        lastFullTripTestSucceededAt: "2026-07-13T11:00:00.000Z",
        tripTests: [{ targetId: "hassleoff-failsafe-test", lastSucceededAt: "2026-07-13T12:00:00.000Z", auditEventId: 76 }],
        targets: [{
          targetId: "hassleoff-failsafe-test",
          registrationId: "hassleoff-failsafe-test-v1",
          displayName: "HassleOff fail-safe test",
          actionType: "fake",
          testOnly: true,
          armed: false
        }]
      });
      if (url.endsWith("/v1/targets/hassleoff-failsafe-test/trip-test")) return jsonResponse({
        protocolVersion: "1",
        targetId: "hassleoff-failsafe-test",
        succeeded: true,
        lastFullTripTestSucceededAt: "2026-07-13T12:00:00.000Z",
        auditEventId: 77
      });
      throw new Error(`Unexpected test request: ${url}`);
    }));
    const { app } = await buildApp(safetyConfig, models);

    try {
      const page = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: auth });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("<h1>HassleOff</h1>");
      expect(page.body).toContain("Last successful fail-safe test");
      expect(page.body).toContain("audit #76");
      expect(page.body).toContain(">Run fail-safe test</button>");
      expect(page.body).not.toContain("controller-token-never-in-browser");
      const csrfToken = page.body.match(/name="csrfToken" value="([^"]+)"/)?.[1];
      expect(csrfToken).toBeTruthy();

      const unconfirmed = await app.inject({
        method: "POST",
        url: "/admin/hassleoff/fail-safe-test",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ csrfToken: csrfToken! }).toString()
      });
      expect(decodeURIComponent(unconfirmed.headers.location!)).toContain("Confirm the synthetic fail-safe test");
      expect(requests).toHaveLength(1);

      const run = await app.inject({
        method: "POST",
        url: "/admin/hassleoff/fail-safe-test",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ csrfToken: csrfToken!, confirm: "yes" }).toString()
      });
      expect(run.statusCode).toBe(302);
      expect(decodeURIComponent(run.headers.location!)).toContain("HassleOff fail-safe test succeeded");
      expect(requests.map((request) => request.url)).toEqual([
        "http://hassleoff.example.test:8091/v1/status",
        "http://hassleoff.example.test:8091/v1/status",
        "http://hassleoff.example.test:8091/v1/targets/hassleoff-failsafe-test/trip-test"
      ]);
      expect(JSON.parse(String(requests[2].init?.body))).toEqual({
        protocolVersion: "1",
        targetId: "hassleoff-failsafe-test"
      });
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("does not expose the command to non-admin users", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const { app } = await buildApp(safetyConfig, models);
    try {
      const nonAdminAuth = { authorization: `Basic ${Buffer.from("other:local-test-secret").toString("base64")}` };
      const page = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: nonAdminAuth });
      expect(page.statusCode).toBe(403);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("cannot trip a real provider registration even with a valid action token", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return jsonResponse({
        protocolVersion: "1",
        service: { healthy: true, ready: true, armed: true, registrationIssues: [] },
        targets: [{
          targetId: "hassleoff-failsafe-test",
          registrationId: "real-provider-target-v1",
          actionType: "runpod-stop",
          testOnly: false,
          armed: true
        }]
      });
    }));
    const { app, authProvider } = await buildApp(safetyConfig, models);

    try {
      const page = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: auth });
      expect(page.body).not.toContain(">Run fail-safe test</button>");
      expect(page.body).not.toContain("name=\"csrfToken\"");
      const csrfToken = authProvider.createState({
        purpose: "hassleoff-fail-safe-test",
        username: "actual",
        targetId: "hassleoff-failsafe-test",
        expiresAt: Date.now() + 60_000
      });
      const attempted = await app.inject({
        method: "POST",
        url: "/admin/hassleoff/fail-safe-test",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ csrfToken, confirm: "yes" }).toString()
      });
      expect(decodeURIComponent(attempted.headers.location!)).toContain("must be registered as testOnly with a fake action");
      expect(requests).toEqual([
        "http://hassleoff.example.test:8091/v1/status",
        "http://hassleoff.example.test:8091/v1/status"
      ]);
      expect(requests.some((url) => url.endsWith("/trip-test"))).toBe(false);
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("runtime model bootstrap selection", () => {
  it("uses the coordinated bootstrap path for startup, explicit discovery, and post-provision discovery", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const discoveryConfig: AppConfig = {
      ...config,
      capacityTargets: [{
        id: "t1",
        displayName: "T1",
        provider: "aws-ecs",
        modelIds: [],
        apiUrl: "http://runtime.invalid/v1",
        modelDiscovery: { bootstrapOnStartup: true }
      }]
    };
    const { app, bootstrapRuntimeModels, runtimeModelDiscovery } = await buildApp(discoveryConfig, models);
    const bootstrap = vi.spyOn(runtimeModelDiscovery, "bootstrapTarget").mockResolvedValue(undefined);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const outcomes = await bootstrapRuntimeModels();
      const explicit = await app.inject({ method: "POST", url: "/api/admin/targets/t1/discover", headers: auth });
      const provisioned = await app.inject({ method: "POST", url: "/api/admin/targets/t1/provision", headers: auth });

      expect(explicit.statusCode).toBe(200);
      expect(provisioned.statusCode).toBe(200);
      expect(outcomes).toEqual([{ targetId: "t1", outcome: "discovered", reason: "Runtime model discovery bootstrap completed." }]);
      expect(bootstrap).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it("returns the concrete discovery failure and exposes it through the admin UI action", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app, runtimeModelDiscovery } = await buildApp(config, models);
    vi.spyOn(runtimeModelDiscovery, "bootstrapTarget").mockRejectedValue(new Error("runtime catalog authentication failed"));
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/targets/t1/discover", headers: auth });
      const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "runtime catalog authentication failed" });
      expect(page.body).toContain("window.alert(message)");
    } finally {
      await app.close();
    }
  });

  it("returns HTTP 409 when force-stop is requested during discovery", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app, targetOperations } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:local-test-secret").toString("base64")}` };
    let finishOperation: (() => void) | undefined;
    const pendingDiscovery = targetOperations.runRuntimeModelDiscovery(
      "t1",
      async () => ({ wasRunning: true }),
      () => new Promise<void>((resolve) => {
        finishOperation = resolve;
      })
    );
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/targets/t1/force-stop", headers: auth });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("runtime model discovery in progress");
      await vi.waitFor(() => expect(finishOperation).toBeTypeOf("function"));
      finishOperation!();
      await pendingDiscovery;
      expect(targetOperations.activeDiscoveryCount()).toBe(0);
    } finally {
      finishOperation?.();
      await pendingDiscovery.catch(() => undefined);
      await app.close();
    }
  });

  it("discovers models by default when a target has no configured models unless disabled", () => {
    expect(shouldBootstrapRuntimeModels({ modelIds: [] })).toBe(true);
    expect(shouldBootstrapRuntimeModels({ modelIds: [], modelDiscovery: { bootstrapOnStartup: false } })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"] })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"], modelDiscovery: { bootstrapOnStartup: true } })).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
