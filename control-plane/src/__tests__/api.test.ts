import { describe, expect, it } from "vitest";
import { buildApp, shouldBootstrapRuntimeModels } from "../app.js";
import type { AppConfig, ModelDefinition } from "../domain/types.js";

const config: AppConfig = {
  port: 0,
  sharedPassword: "secret",
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
});

describe("runtime model bootstrap selection", () => {
  it("discovers models by default when a target has no configured models unless disabled", () => {
    expect(shouldBootstrapRuntimeModels({ modelIds: [] })).toBe(true);
    expect(shouldBootstrapRuntimeModels({ modelIds: [], modelDiscovery: { bootstrapOnStartup: false } })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"] })).toBe(false);
    expect(shouldBootstrapRuntimeModels({ modelIds: ["configured"], modelDiscovery: { bootstrapOnStartup: true } })).toBe(true);
  });
});
