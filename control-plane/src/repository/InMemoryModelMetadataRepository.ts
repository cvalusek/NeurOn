import type { ModelMetadataRepository } from "../domain/interfaces.js";
import type { ModelCapabilityMetadata, ModelDeploymentMetadata, StoredModelCapabilityMetadata, StoredModelDeploymentMetadata } from "../domain/types.js";
import { cloneStoredCapability, cloneStoredDeployment, storedCapability, storedDeployment } from "./modelMetadataUtils.js";

export class InMemoryModelMetadataRepository implements ModelMetadataRepository {
  private readonly capabilities = new Map<string, StoredModelCapabilityMetadata>();
  private readonly deployments = new Map<string, StoredModelDeploymentMetadata>();

  async listCapabilities(): Promise<StoredModelCapabilityMetadata[]> {
    return Array.from(this.capabilities.values()).sort((a, b) => a.modelId.localeCompare(b.modelId)).map(cloneStoredCapability);
  }
  async listDeployments(): Promise<StoredModelDeploymentMetadata[]> {
    return Array.from(this.deployments.values()).sort((a, b) => a.targetId.localeCompare(b.targetId) || a.modelId.localeCompare(b.modelId)).map(cloneStoredDeployment);
  }
  async upsertCapability(input: ModelCapabilityMetadata, updatedAt = new Date()): Promise<StoredModelCapabilityMetadata> {
    const value = storedCapability(input, updatedAt); this.capabilities.set(input.modelId, value); return cloneStoredCapability(value);
  }
  async upsertDeployment(input: ModelDeploymentMetadata, updatedAt = new Date()): Promise<StoredModelDeploymentMetadata> {
    const value = storedDeployment(input, updatedAt); this.deployments.set(key(input.targetId, input.modelId), value); return cloneStoredDeployment(value);
  }
  async deleteCapability(modelId: string): Promise<boolean> { return this.capabilities.delete(modelId); }
  async deleteDeployment(targetId: string, modelId: string): Promise<boolean> { return this.deployments.delete(key(targetId, modelId)); }
}

function key(targetId: string, modelId: string): string { return `${targetId}::${modelId}`; }
