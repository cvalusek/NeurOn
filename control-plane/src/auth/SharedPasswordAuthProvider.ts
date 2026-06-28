import crypto from "node:crypto";
import type { ApiKeyRepository, AuthProvider } from "../domain/interfaces.js";
import type { AuthenticatedUser } from "../domain/types.js";
import { authenticateApiKey } from "../services/ApiKeyService.js";

export class SharedPasswordAuthProvider implements AuthProvider {
  constructor(
    private readonly sharedPassword: string,
    private readonly adminUsers: string[],
    private readonly cookieSecret?: string,
    private readonly apiKeys?: ApiKeyRepository
  ) {}

  async authenticate(request: { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> }): Promise<AuthenticatedUser | undefined> {
    const bearer = await this.fromBearerAuth(request.headers.authorization);
    if (bearer) return bearer;
    const basic = this.fromBasicAuth(request.headers.authorization);
    if (basic) return basic;
    const cookie = request.cookies?.llm_control_auth;
    if (cookie && this.cookieSecret) return this.fromSignedCookie(cookie);
    return undefined;
  }

  createCookie(username: string): string {
    if (!this.cookieSecret) throw new Error("COOKIE_SECRET is not configured");
    const payload = Buffer.from(JSON.stringify({ username })).toString("base64url");
    const signature = crypto.createHmac("sha256", this.cookieSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private fromBasicAuth(header: string | string[] | undefined): AuthenticatedUser | undefined {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return undefined;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (!username || password !== this.sharedPassword) return undefined;
    return { username, isAdmin: this.isAdmin(username) };
  }

  private async fromBearerAuth(header: string | string[] | undefined): Promise<AuthenticatedUser | undefined> {
    if (!this.apiKeys) return undefined;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith("Bearer ")) return undefined;
    return authenticateApiKey(this.apiKeys, value.slice("Bearer ".length).trim(), (username) => this.isAdmin(username));
  }

  private fromSignedCookie(cookie: string): AuthenticatedUser | undefined {
    const [payload, signature] = cookie.split(".");
    if (!payload || !signature || !this.cookieSecret) return undefined;
    const expected = crypto.createHmac("sha256", this.cookieSecret).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { username?: string };
    if (!parsed.username) return undefined;
    return { username: parsed.username, isAdmin: this.isAdmin(parsed.username) };
  }

  private isAdmin(username: string): boolean {
    return this.adminUsers.length === 0 || this.adminUsers.includes(username);
  }
}
