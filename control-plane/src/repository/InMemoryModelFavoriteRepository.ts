import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { ModelFavorite } from "../domain/types.js";

export class InMemoryModelFavoriteRepository implements ModelFavoriteRepository {
  private readonly values = new Map<string, ModelFavorite>();
  async listForUser(username: string): Promise<ModelFavorite[]> {
    return Array.from(this.values.values()).filter((value) => value.username === username).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }
  async add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite> {
    const value = { ...input, createdAt: input.createdAt ?? new Date() }; this.values.set(key(value.username, value.targetId, value.modelId), value); return clone(value);
  }
  async remove(username: string, targetId: string, modelId: string): Promise<boolean> { return this.values.delete(key(username, targetId, modelId)); }
}
function key(username: string, targetId: string, modelId: string): string { return `${username}::${targetId}::${modelId}`; }
function clone(value: ModelFavorite): ModelFavorite { return { ...value, createdAt: new Date(value.createdAt) }; }
