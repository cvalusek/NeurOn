import { afterEach, describe, expect, it } from "vitest";
import { AuthSecretResolver } from "../auth/AuthSecretResolver.js";
import { loadConfig } from "../config/loadConfig.js";

const managedEnv = [
  "AUTH_METHOD_KEYS",
  "AUTH_METHOD_OKTA_TYPE",
  "AUTH_METHOD_OKTA_ID",
  "AUTH_METHOD_OKTA_DISPLAY_NAME",
  "AUTH_METHOD_OKTA_ISSUER",
  "AUTH_METHOD_OKTA_CLIENT_ID",
  "AUTH_METHOD_OKTA_CLIENT_SECRET_SOURCE",
  "AUTH_METHOD_OKTA_CLIENT_SECRET_ENV",
  "AUTH_METHOD_OKTA_CLIENT_SECRET_ID",
  "AUTH_METHOD_OKTA_CLIENT_SECRET_JSON_KEY",
  "AUTH_METHOD_OKTA_ALLOWED_GROUPS",
  "PUBLIC_BASE_URL"
];

afterEach(() => {
  for (const key of managedEnv) delete process.env[key];
});

describe("OIDC authentication configuration", () => {
  it("loads multiple-provider environment configuration with an environment secret convention", async () => {
    process.env.AUTH_METHOD_KEYS = "OKTA";
    process.env.AUTH_METHOD_OKTA_TYPE = "oidc";
    process.env.AUTH_METHOD_OKTA_DISPLAY_NAME = "Company Okta";
    process.env.AUTH_METHOD_OKTA_ISSUER = "https://company.okta.com/oauth2/default";
    process.env.AUTH_METHOD_OKTA_CLIENT_ID = "client-id";
    process.env.AUTH_METHOD_OKTA_ALLOWED_GROUPS = "neuron-users,platform";
    process.env.PUBLIC_BASE_URL = "https://neuron.example.test/";

    const { config } = await loadConfig();

    expect(config.publicBaseUrl).toBe("https://neuron.example.test");
    expect(config.authMethods).toEqual([expect.objectContaining({
      id: "okta",
      displayName: "Company Okta",
      type: "oidc",
      config: { oidc: expect.objectContaining({
        issuer: "https://company.okta.com/oauth2/default",
        clientId: "client-id",
        clientSecret: { source: "environment", environmentVariable: "AUTH_METHOD_OKTA_CLIENT_SECRET" },
        allowedGroups: ["neuron-users", "platform"]
      }) }
    })]);
  });

  it("loads an AWS Secrets Manager reference without resolving it at startup", async () => {
    process.env.AUTH_METHOD_KEYS = "OKTA";
    process.env.AUTH_METHOD_OKTA_TYPE = "oidc";
    process.env.AUTH_METHOD_OKTA_ISSUER = "https://company.okta.com";
    process.env.AUTH_METHOD_OKTA_CLIENT_ID = "client-id";
    process.env.AUTH_METHOD_OKTA_CLIENT_SECRET_SOURCE = "aws-secrets-manager";
    process.env.AUTH_METHOD_OKTA_CLIENT_SECRET_ID = "/neuron/auth/okta";
    process.env.AUTH_METHOD_OKTA_CLIENT_SECRET_JSON_KEY = "clientSecret";

    const { config } = await loadConfig();

    expect(config.authMethods[0]?.config.oidc?.clientSecret).toEqual({
      source: "aws-secrets-manager",
      secretId: "/neuron/auth/okta",
      jsonKey: "clientSecret"
    });
  });
});

describe("auth secret resolution", () => {
  it("resolves environment and stored values", async () => {
    process.env.AUTH_METHOD_OKTA_CLIENT_SECRET_ENV = "from-environment";
    const resolver = new AuthSecretResolver("us-east-2", { send: async () => ({}) });

    await expect(resolver.resolve({ source: "environment", environmentVariable: "AUTH_METHOD_OKTA_CLIENT_SECRET_ENV" })).resolves.toBe("from-environment");
    await expect(resolver.resolve({ source: "stored", value: "stored-value" })).resolves.toBe("stored-value");
  });

  it("extracts a selected JSON key from AWS Secrets Manager", async () => {
    const resolver = new AuthSecretResolver("us-east-2", {
      send: async () => ({ SecretString: JSON.stringify({ clientSecret: "from-aws" }) })
    });

    await expect(resolver.resolve({ source: "aws-secrets-manager", secretId: "/neuron/auth/okta", jsonKey: "clientSecret" })).resolves.toBe("from-aws");
  });
});
