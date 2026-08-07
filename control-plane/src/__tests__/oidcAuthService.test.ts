import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSecretResolver } from "../auth/AuthSecretResolver.js";

const protocol = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  discovery: vi.fn(async () => ({})),
  authorizationCodeGrant: vi.fn(async () => ({ claims: () => protocol.claims })),
  buildAuthorizationUrl: vi.fn((_config: unknown, parameters: Record<string, string>) => {
    const url = new URL("https://identity.example.test/authorize");
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url;
  })
}));

vi.mock("openid-client", () => ({
  discovery: protocol.discovery,
  authorizationCodeGrant: protocol.authorizationCodeGrant,
  buildAuthorizationUrl: protocol.buildAuthorizationUrl,
  ClientSecretPost: vi.fn(() => "client-secret-post"),
  randomPKCECodeVerifier: vi.fn(() => "code-verifier"),
  calculatePKCECodeChallenge: vi.fn(async () => "code-challenge"),
  randomState: vi.fn(() => "state"),
  randomNonce: vi.fn(() => "nonce")
}));

import { OidcAuthService } from "../auth/OidcAuthService.js";

const baseConfig = {
  issuer: "https://identity.example.test/oauth2/default",
  clientId: "client-id",
  clientSecret: { source: "stored" as const, value: "client-secret" }
};

beforeEach(() => {
  protocol.claims = {};
  vi.clearAllMocks();
});

describe("OIDC authentication", () => {
  it("builds a PKCE authorization request and includes groups when group access is configured", async () => {
    const service = new OidcAuthService({ resolve: vi.fn(async () => "client-secret") } as unknown as AuthSecretResolver);

    const result = await service.createAuthorizationRequest("okta", { ...baseConfig, allowedGroups: ["neuron-users"] }, "https://neuron.example.test/auth/oidc/callback");

    expect(result.loginState).toMatchObject({ methodId: "okta", state: "state", nonce: "nonce", codeVerifier: "code-verifier" });
    expect(result.url.searchParams.get("scope")).toBe("openid profile email groups");
    expect(result.url.searchParams.get("code_challenge")).toBe("code-challenge");
    expect(result.url.searchParams.get("redirect_uri")).toBe("https://neuron.example.test/auth/oidc/callback");
  });

  it("returns the configured username claim when user and group restrictions pass", async () => {
    protocol.claims = { email: "alice@example.com", groups: ["neuron-users"] };
    const service = new OidcAuthService({ resolve: vi.fn(async () => "client-secret") } as unknown as AuthSecretResolver);

    const username = await service.authenticate(
      { ...baseConfig, usernameClaim: "email", allowedUsers: ["alice@example.com"], allowedGroups: ["neuron-users"] },
      "https://neuron.example.test/auth/oidc/callback?code=code&state=state",
      { methodId: "okta", state: "state", nonce: "nonce", codeVerifier: "code-verifier", issuedAt: Date.now() }
    );

    expect(username).toBe("alice@example.com");
    expect(protocol.authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(), expect.any(URL), {
      pkceCodeVerifier: "code-verifier",
      expectedState: "state",
      expectedNonce: "nonce"
    });
  });

  it("rejects users outside configured groups", async () => {
    protocol.claims = { preferred_username: "alice", groups: ["other"] };
    const service = new OidcAuthService({ resolve: vi.fn(async () => "client-secret") } as unknown as AuthSecretResolver);

    await expect(service.authenticate(
      { ...baseConfig, allowedGroups: ["neuron-users"] },
      "https://neuron.example.test/auth/oidc/callback?code=code&state=state",
      { methodId: "okta", state: "state", nonce: "nonce", codeVerifier: "code-verifier", issuedAt: Date.now() }
    )).rejects.toThrow("not in an allowed group");
  });
});
