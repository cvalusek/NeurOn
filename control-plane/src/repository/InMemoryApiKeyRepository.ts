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

  async listForUser(userId: string): Promise<ApiKey[]> {
    return Array.from(this.keys.values())
      .filter((key) => key.userId === userId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneApiKey);
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const key = this.keys.get(id);
    if (!key || key.userId !== userId) return false;
    return this.keys.delete(id);
  }

  async touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void> {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.set(id, cloneApiKey({ ...key, lastUsedAt }));
  }

  countForUser(userId: string): number { return Array.from(this.keys.values()).filter((value) => value.userId === userId).length; }
  reassignUser(sourceUserId: string, targetUserId: string, username: string): void {
    for (const key of this.keys.values()) if (key.userId === sourceUserId) Object.assign(key, { userId: targetUserId, username });
  }
}

function cloneApiKey(key: ApiKey): ApiKey {
  return {
    ...key,
    createdAt: new Date(key.createdAt),
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : undefined
  };
}
