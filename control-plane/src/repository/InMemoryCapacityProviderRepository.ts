import type { CapacityProviderRepository } from "../domain/interfaces.js";
import type { CapacityProviderDefinition } from "../domain/types.js";

export class InMemoryCapacityProviderRepository implements CapacityProviderRepository {
  private readonly providers = new Map<string, CapacityProviderDefinition>();

  async create(input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    if (this.providers.has(input.id)) throw new Error(`Provider already exists: ${input.id}`);
    this.providers.set(input.id, cloneProvider(input));
    return cloneProvider(input);
  }

  async get(id: string): Promise<CapacityProviderDefinition | undefined> {
    const provider = this.providers.get(id);
    return provider ? cloneProvider(provider) : undefined;
  }

  async list(): Promise<CapacityProviderDefinition[]> {
    return Array.from(this.providers.values())
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(cloneProvider);
  }

  async update(id: string, input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    if (!this.providers.has(id)) throw new Error(`Provider not found: ${id}`);
    if (input.id !== id && this.providers.has(input.id)) throw new Error(`Provider already exists: ${input.id}`);
    this.providers.delete(id);
    this.providers.set(input.id, cloneProvider(input));
    return cloneProvider(input);
  }

  async delete(id: string): Promise<boolean> {
    return this.providers.delete(id);
  }
}

export function cloneProvider(provider: CapacityProviderDefinition): CapacityProviderDefinition {
  return {
    ...provider,
    provisioning: provider.provisioning ? { ...provider.provisioning } : undefined,
    config: provider.config ? JSON.parse(JSON.stringify(provider.config)) as CapacityProviderDefinition["config"] : undefined
  };
}
