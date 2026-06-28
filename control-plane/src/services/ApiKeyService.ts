import crypto from "node:crypto";
import { customAlphabet } from "nanoid";
import type { ApiKeyRepository } from "../domain/interfaces.js";
import type { ApiKey, AuthenticatedUser } from "../domain/types.js";

export interface CreatedApiKey {
  key: ApiKey;
  token: string;
}

export class ApiKeyService {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  async createForUser(user: AuthenticatedUser, input: { name: string }): Promise<CreatedApiKey> {
    const name = input.name.trim();
    if (!name) throw new Error("API key name is required");
    if (name.length > 80) throw new Error("API key name must be 80 characters or fewer");

    const id = createApiKeyId();
    const secret = crypto.randomBytes(32).toString("base64url");
    const token = `sk-neuron-${id}-${secret}`;
    const key = await this.apiKeys.create({
      id,
      username: user.username,
      name,
      prefix: `sk-neuron-${id}`,
      keyHash: hashToken(token),
      createdAt: new Date()
    });
    return { key, token };
  }

  async listForUser(user: AuthenticatedUser): Promise<ApiKey[]> {
    return this.apiKeys.listForUser(user.username);
  }

  async revokeForUser(user: AuthenticatedUser, id: string): Promise<boolean> {
    return this.apiKeys.deleteForUser(id, user.username);
  }
}

export async function authenticateApiKey(
  apiKeys: ApiKeyRepository,
  token: string,
  isAdmin: (username: string) => boolean
): Promise<AuthenticatedUser | undefined> {
  const id = parseTokenId(token);
  if (!id) return undefined;
  const key = await apiKeys.get(id);
  if (!key) return undefined;
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(key.keyHash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return undefined;
  await apiKeys.touchLastUsedAt(key.id, new Date());
  return { username: key.username, isAdmin: isAdmin(key.username), apiKeyName: key.name };
}

function parseTokenId(token: string): string | undefined {
  const match = /^sk-neuron-([A-Za-z0-9]+)-[A-Za-z0-9_-]+$/.exec(token);
  return match?.[1];
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

const createApiKeyId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 12);
