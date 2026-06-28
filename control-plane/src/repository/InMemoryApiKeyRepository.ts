import { nanoid } from "nanoid";
import type { ApiKeyRepository } from "../domain/interfaces.js";
import type { ApiKey } from "../domain/types.js";

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private readonly keys = new Map<string, ApiKey>();

  async create(input: Omit<ApiKey, "id"> & { id?: string }): Promise<ApiKey> {
    const key = { ...input, id: input.id ?? nanoid(12) };
    this.keys.set(key.id, cloneApiKey(key));
    return cloneApiKey(key);
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const key = this.keys.get(id);
    return key ? cloneApiKey(key) : undefined;
  }

  async listForUser(username: string): Promise<ApiKey[]> {
    return Array.from(this.keys.values())
      .filter((key) => key.username === username)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneApiKey);
  }

  async deleteForUser(id: string, username: string): Promise<boolean> {
    const key = this.keys.get(id);
    if (!key || key.username !== username) return false;
    return this.keys.delete(id);
  }

  async touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void> {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.set(id, cloneApiKey({ ...key, lastUsedAt }));
  }
}

function cloneApiKey(key: ApiKey): ApiKey {
  return {
    ...key,
    createdAt: new Date(key.createdAt),
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : undefined
  };
}
