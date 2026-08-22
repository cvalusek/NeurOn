import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { ModelFavorite } from "../domain/types.js";

export class InMemoryModelFavoriteRepository implements ModelFavoriteRepository {
  private readonly values = new Map<string, ModelFavorite>();
  async listForUser(userId: string): Promise<ModelFavorite[]> {
    return Array.from(this.values.values()).filter((value) => value.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }
  async add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite> {
    const value = { ...input, createdAt: input.createdAt ?? new Date() }; this.values.set(key(value.userId, value.targetId, value.modelId), value); return clone(value);
  }
  async remove(userId: string, targetId: string, modelId: string): Promise<boolean> { return this.values.delete(key(userId, targetId, modelId)); }
  countForUser(userId: string): number { return Array.from(this.values.values()).filter((value) => value.userId === userId).length; }
  reassignUser(sourceUserId: string, targetUserId: string, username: string): void {
    for (const [existingKey, favorite] of Array.from(this.values.entries())) {
      if (favorite.userId !== sourceUserId) continue;
      this.values.delete(existingKey);
      const updated = { ...favorite, userId: targetUserId, username };
      if (!this.values.has(key(targetUserId, favorite.targetId, favorite.modelId))) this.values.set(key(targetUserId, favorite.targetId, favorite.modelId), updated);
    }
  }
}
function key(userId: string, targetId: string, modelId: string): string { return `${userId}::${targetId}::${modelId}`; }
function clone(value: ModelFavorite): ModelFavorite { return { ...value, createdAt: new Date(value.createdAt) }; }
