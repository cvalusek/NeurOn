import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { SharedPasswordAuthProvider } from "../auth/SharedPasswordAuthProvider.js";
import type { AppConfig, ModelDefinition } from "../domain/types.js";
import { shouldBootstrapRuntimeModels } from "../services/RuntimeModelDiscovery.js";

const config: AppConfig = {
  port: 0,
  sharedPassword: "secret",
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

const models: ModelDefinition[] = [{ id: "m1", displayName: "M1", aliases: ["m1"], targetIds: ["t1"] }];

describe("API authentication context", () => {
  it("uses the authenticated username instead of POST body username", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const response = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` },
      payload: { username: "spoofed", modelIds: ["m1"], durationMinutes: 10 }
    });
    await app.close();
    expect(response.statusCode).toBe(201);
    expect(response.json().username).toBe("actual");
  });

  it("creates reservation profiles and starts reservations from them", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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

  it("serves a profiles page for the current user's reservation profiles", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
    await app.inject({
      method: "POST",
      url: "/api/reservation-profiles",
      headers: auth,
      payload: { name: "Daily coding", selections: [{ targetId: "t1", modelIds: ["m1"] }] }
    });

    const page = await app.inject({ method: "GET", url: "/profiles", headers: auth });
    await app.close();

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Profiles");
    expect(page.body).toContain("Daily coding");
    expect(page.body).toContain("T1");
    expect(page.body).toContain("m1");
    expect(page.body).toContain("New profile");
    expect(page.body).toContain('name="returnTo" value="/profiles"');
  });

  it("creates reservation profiles from the profiles page and returns there", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

    const response = await app.inject({
      method: "POST",
      url: "/reservation-profiles",
      headers: auth,
      payload: {
        name: "Profiles page profile",
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
  });

  it("keeps direct reservation creation working without a reservation profile", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const response = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` },
      payload: { modelIds: ["m1"], targetIds: ["t1"], durationMinutes: 10 }
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ modelIds: ["m1"], targets: [{ id: "t1" }] });
    expect(response.json().profileId).toBeUndefined();
  });

  it("hides expired reservations from the default status payload", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: auth,
      payload: { modelIds: ["m1"], durationMinutes: 60 }
    });
    await reconciler.reconcile(new Date("2026-06-25T10:00:00.000Z"));
    await reconciler.reconcile(new Date("2026-06-25T10:15:00.000Z"));

    const response = await app.inject({ method: "GET", url: `/api/reservations/${created.json().reservationId}`, headers: auth });
    await app.close();

    expect(response.json().costEstimate).toMatchObject({ estimatedCostUsd: 3, currency: "USD" });
    expect(response.json().costEstimate.projectedTotalCostUsd).toBeGreaterThanOrEqual(3);
  });

  it("creates API keys, authenticates bearer requests, and revokes keys", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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

  it("serves admin auth management and creates persisted GitHub methods", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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

  it("copies declarative providers into persisted storage from the admin UI", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

    const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("T1");
    expect(page.body).toContain("CAPACITY_TARGET_KEYS=T1");

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
        runpodPodId: "pod-qwen",
        runpodRuntimePort: "8080"
      }).toString()
    });
    expect(created.statusCode).toBe(302);

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
      litellmDisplayPrefix: "clint-desktop/"
    });
    expect(refreshed.body).toContain("RunPod PreFer");
    expect(refreshed.body).toContain("pod-prefer");
    expect(refreshed.body).toContain("clint-desktop/");
    expect(refreshed.body).toContain("LiteLLM model route prefixes");
    expect(refreshed.body).toContain("Save target");
  });

  it("creates PreFer Docker targets with model volume and discovery URLs", async () => {
    process.env.USE_FAKE_PROVIDER = "true";
    const { app } = await buildApp(config, models);
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

    const copied = await app.inject({ method: "POST", url: "/admin/targets/t1/copy-to-db", headers: auth });
    expect(copied.statusCode).toBe(302);

    const page = await app.inject({ method: "GET", url: "/admin/targets", headers: auth });

    expect(page.body).toContain("JSON");
    expect(page.body).toContain("CAPACITY_TARGET_KEYS=T1");
    expect(page.body.match(/t1/g)?.length).toBeGreaterThan(1);
    expect(page.body).toContain("persisted");
    expect(page.body).toContain("Save target");

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
      failSafeTestTargetId: "hassleoff-failsafe-test"
    }
  };
  const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };

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
      expect(page.body).toContain("HassleOff safety");
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
      const nonAdminAuth = { authorization: `Basic ${Buffer.from("other:secret").toString("base64")}` };
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
    const { app } = await buildApp(safetyConfig, models);

    try {
      const page = await app.inject({ method: "GET", url: "/admin/hassleoff", headers: auth });
      expect(page.body).not.toContain(">Run fail-safe test</button>");
      expect(page.body).not.toContain("name=\"csrfToken\"");
      const csrfToken = new SharedPasswordAuthProvider("secret", ["actual"], "test-cookie-secret").createState({
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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
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
    const auth = { authorization: `Basic ${Buffer.from("actual:secret").toString("base64")}` };
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
