import type { ModelCapabilityMetadata, ModelDeploymentMetadata, StoredModelCapabilityMetadata, StoredModelDeploymentMetadata } from "../domain/types.js";

export function cloneStoredCapability(value: StoredModelCapabilityMetadata): StoredModelCapabilityMetadata {
  return { ...structuredClone(value), updatedAt: new Date(value.updatedAt) };
}

export function cloneStoredDeployment(value: StoredModelDeploymentMetadata): StoredModelDeploymentMetadata {
  return { ...structuredClone(value), updatedAt: new Date(value.updatedAt) };
}

export function storedCapability(input: ModelCapabilityMetadata, updatedAt = new Date()): StoredModelCapabilityMetadata {
  return { ...structuredClone(input), updatedAt: new Date(updatedAt) };
}

export function storedDeployment(input: ModelDeploymentMetadata, updatedAt = new Date()): StoredModelDeploymentMetadata {
  return { ...structuredClone(input), updatedAt: new Date(updatedAt) };
}
