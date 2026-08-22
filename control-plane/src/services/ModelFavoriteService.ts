import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, ModelFavorite } from "../domain/types.js";
import type { ModelCatalog } from "./ModelCatalog.js";
import type { IdentityService } from "./IdentityService.js";

export class ModelFavoriteService {
  constructor(private readonly repository: ModelFavoriteRepository, private readonly catalog: ModelCatalog, private readonly identities?: IdentityService) {}

  listForUser(user: AuthenticatedUser): Promise<ModelFavorite[]> { return this.repository.listForUser(user.id); }
  async add(user: AuthenticatedUser, targetId: string, modelId: string): Promise<ModelFavorite> {
    if (this.identities && !this.identities.hasPermission(user,"favorites.manage_own")) throw new Error("Favorite management permission is required");
    const target = this.catalog.getTarget(targetId);
    const model = this.catalog.getModel(modelId);
    if (!target || !model?.targetIds.includes(targetId)) throw new Error("Target/model deployment not found");
    if (this.identities && !await this.identities.canAccessTarget(user,target,"use")) throw new Error("Target/model deployment not found");
    return this.repository.add({ userId: user.id, username: user.username, targetId, modelId });
  }
  remove(user: AuthenticatedUser, targetId: string, modelId: string): Promise<boolean> { if(this.identities&&!this.identities.hasPermission(user,"favorites.manage_own"))throw new Error("Favorite management permission is required");return this.repository.remove(user.id, targetId, modelId); }
}
