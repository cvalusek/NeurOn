import * as oidc from "openid-client";
import type { OidcAuthMethodConfig } from "../domain/types.js";
import { AuthSecretResolver } from "./AuthSecretResolver.js";

export interface OidcLoginState extends Record<string, unknown> {
  methodId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
}

export class OidcAuthService {
  constructor(private readonly secrets: AuthSecretResolver) {}

  async createAuthorizationRequest(methodId: string, config: OidcAuthMethodConfig, redirectUri: string): Promise<{ url: URL; loginState: OidcLoginState }> {
    const client = await this.client(config);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const scopes = normalizedScopes(config);
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });
    return { url, loginState: { methodId, state, nonce, codeVerifier, issuedAt: Date.now() } };
  }

  async authenticate(config: OidcAuthMethodConfig, callbackUrl: string, loginState: OidcLoginState): Promise<string> {
    if (Date.now() - loginState.issuedAt > 10 * 60 * 1000) throw new Error("OIDC sign in state expired");
    const client = await this.client(config);
    const tokens = await oidc.authorizationCodeGrant(client, new URL(callbackUrl), {
      pkceCodeVerifier: loginState.codeVerifier,
      expectedState: loginState.state,
      expectedNonce: loginState.nonce
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("OIDC provider did not return an ID token");
    const usernameClaim = config.usernameClaim ?? "preferred_username";
    const username = claims[usernameClaim];
    if (typeof username !== "string" || !username) throw new Error(`OIDC ID token did not contain string claim ${usernameClaim}`);
    if (config.allowedUsers?.length && !config.allowedUsers.includes(username)) throw new Error("This OIDC user is not allowed");
    if (config.allowedGroups?.length) {
      const groupsClaim = config.groupsClaim ?? "groups";
      const rawGroups = claims[groupsClaim];
      const groups = Array.isArray(rawGroups) ? rawGroups.filter((value): value is string => typeof value === "string") : [];
      if (!config.allowedGroups.some((group) => groups.includes(group))) throw new Error("This OIDC user is not in an allowed group");
    }
    return username;
  }

  private async client(config: OidcAuthMethodConfig): Promise<oidc.Configuration> {
    const secret = await this.secrets.resolve(config.clientSecret);
    return oidc.discovery(new URL(config.issuer), config.clientId, secret, oidc.ClientSecretPost(secret));
  }
}

function normalizedScopes(config: OidcAuthMethodConfig): string[] {
  const scopes = config.scopes?.length ? config.scopes : ["openid", "profile", "email"];
  const required = config.allowedGroups?.length ? [...scopes, "groups"] : scopes;
  return Array.from(new Set(["openid", ...required]));
}
