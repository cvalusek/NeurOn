import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ModelFavorite } from "../domain/types.js";
import type { ModelCatalog } from "./ModelCatalog.js";

export class ModelFavoriteService {
  constructor(private readonly repository: ModelFavoriteRepository, private readonly catalog: ModelCatalog) {}

  listForUser(user: AuthenticatedUser): Promise<ModelFavorite[]> { return this.repository.listForUser(user.username); }
  async add(user: AuthenticatedUser, targetId: string, modelId: string): Promise<ModelFavorite> {
    const target = this.catalog.getTarget(targetId);
    const model = this.catalog.getModel(modelId);
    if (!target || !model?.targetIds.includes(targetId)) throw new Error("Target/model deployment not found");
    return this.repository.add({ username: user.username, targetId, modelId });
  }
  remove(user: AuthenticatedUser, targetId: string, modelId: string): Promise<boolean> { return this.repository.remove(user.username, targetId, modelId); }
}
