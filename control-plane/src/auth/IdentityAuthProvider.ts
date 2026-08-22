import crypto from "node:crypto";
import type { ApiKeyRepository, AuthProvider } from "../domain/interfaces.js";
import type { AuthenticatedUser } from "../domain/types.js";
import { authenticateApiKey } from "../services/ApiKeyService.js";
import type { IdentityService } from "../services/IdentityService.js";

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const LOCAL_AUTH_WINDOW_MS = 10 * 60_000;
const LOCAL_AUTH_MAX_FAILURES = 8;
const LOCAL_AUTH_MAX_TRACKED_USERS = 10_000;

export class IdentityAuthProvider implements AuthProvider {
  private readonly localAuthenticationAttempts = new Map<string, { failures: number; resetAt: number }>();

  constructor(
    private readonly identities: IdentityService,
    private readonly cookieSecret?: string,
    private readonly apiKeys?: ApiKeyRepository,
    private readonly localAuthenticationEnabled: () => Promise<boolean> = async () => true
  ) {}

  async authenticate(request: { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> }): Promise<AuthenticatedUser | undefined> {
    const bearer = await this.fromBearerAuth(request.headers.authorization);
    if (bearer) return bearer;
    const basic = await this.fromBasicAuth(request.headers.authorization);
    if (basic) return basic;
    const cookie = request.cookies?.llm_control_auth;
    return cookie && this.cookieSecret ? this.fromSignedCookie(cookie) : undefined;
  }

  createCookie(user: AuthenticatedUser): string {
    if (!this.cookieSecret) throw new Error("COOKIE_SECRET is not configured");
    const issuedAt = Date.now();
    return this.sign({ userId: user.id, sessionVersion: user.sessionVersion, issuedAt, expiresAt: issuedAt + SESSION_MAX_AGE_SECONDS * 1_000 });
  }

  createState(payload: Record<string, unknown>): string {
    if (!this.cookieSecret) throw new Error("COOKIE_SECRET is not configured");
    return this.sign(payload);
  }

  verifyState<T extends Record<string, unknown>>(state: string): T | undefined { return this.verifySigned<T>(state); }

  private async fromBasicAuth(header: string | string[] | undefined): Promise<AuthenticatedUser | undefined> {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith("Basic ")) return undefined;
    if (!await this.localAuthenticationEnabled()) return undefined;
    const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return undefined;
    const username = decoded.slice(0, separator);
    const attemptKey = username.trim().toLocaleLowerCase("en-US");
    const now = Date.now();
    const attempt = this.localAuthenticationAttempts.get(attemptKey);
    if (attempt && attempt.resetAt > now && attempt.failures >= LOCAL_AUTH_MAX_FAILURES) return undefined;
    if (attempt?.resetAt && attempt.resetAt <= now) this.localAuthenticationAttempts.delete(attemptKey);
    const user = await this.identities.authenticateLocal(username, decoded.slice(separator + 1));
    if (user) {
      this.localAuthenticationAttempts.delete(attemptKey);
      return user;
    }
    this.recordLocalAuthenticationFailure(attemptKey, now);
    return undefined;
  }

  private async fromBearerAuth(header: string | string[] | undefined): Promise<AuthenticatedUser | undefined> {
    if (!this.apiKeys) return undefined;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith("Bearer ")) return undefined;
    return authenticateApiKey(this.apiKeys, value.slice("Bearer ".length).trim(), (userId) => this.identities.authenticatedUser(userId));
  }

  private async fromSignedCookie(cookie: string): Promise<AuthenticatedUser | undefined> {
    const parsed = this.verifySigned<{ userId?: string; sessionVersion?: number; expiresAt?: number }>(cookie);
    if (!parsed?.userId || !Number.isInteger(parsed.sessionVersion) || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt! <= Date.now()) return undefined;
    const user = await this.identities.authenticatedUser(parsed.userId);
    return user?.sessionVersion === parsed.sessionVersion ? user : undefined;
  }

  private sign(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.cookieSecret!).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verifySigned<T extends Record<string, unknown>>(value: string): T | undefined {
    if (!this.cookieSecret) return undefined;
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return undefined;
    const expected = crypto.createHmac("sha256", this.cookieSecret).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return undefined;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T; } catch { return undefined; }
  }

  private recordLocalAuthenticationFailure(attemptKey: string, now: number): void {
    if (this.localAuthenticationAttempts.size >= LOCAL_AUTH_MAX_TRACKED_USERS) {
      for (const [key, attempt] of this.localAuthenticationAttempts) {
        if (attempt.resetAt <= now) this.localAuthenticationAttempts.delete(key);
      }
      if (this.localAuthenticationAttempts.size >= LOCAL_AUTH_MAX_TRACKED_USERS) {
        const oldest = this.localAuthenticationAttempts.keys().next().value as string | undefined;
        if (oldest) this.localAuthenticationAttempts.delete(oldest);
      }
    }
    const current = this.localAuthenticationAttempts.get(attemptKey);
    this.localAuthenticationAttempts.set(attemptKey, {
      failures: (current?.failures ?? 0) + 1,
      resetAt: current?.resetAt ?? now + LOCAL_AUTH_WINDOW_MS
    });
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left); const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
