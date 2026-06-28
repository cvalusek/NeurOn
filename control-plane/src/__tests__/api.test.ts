import { describe, expect, it } from "vitest";
import { buildApp, shouldBootstrapRuntimeModels } from "../app.js";
import type { AppConfig, ModelDefinition } from "../domain/types.js";

const config: AppConfig = {
  port: 0,
  sharedPassword: "secret",
  storage: { driver: "memory" },
  awsRegion: "us-east-1",
  litellmTrafficPollSeconds: 0,
  litellmTrafficLookbackSeconds: 300,
  capacityTargets: [{ id: "t1", displayName: "T1", provider: "aws-ecs", modelIds: ["m1"], healthCheckUrl: "http://example.test" }],
  reconcilerIntervalSeconds: 15,
  reservationStatusPollSeconds: 5,
  adminStatusPollSeconds: 10,
  healthCheckTimeoutSeconds: 1,
  healthCheckIntervalSeconds: 15,
  adminUsers: []
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
});

describe("runtime model bootstrap selection", () => {
  it("discovers models by default when a target has no configured models unless disabled", () => {
    expect(shouldBootstrapRuntimeModels({ modelIds: [] })).toBe(true);
    expect(shouldBootstrapRuntimeModels({ modelIds: [], modelDiscovery: { bootstrapOnStartup: false } })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"] })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"], modelDiscovery: { bootstrapOnStartup: true } })).toBe(true);
  });
});
