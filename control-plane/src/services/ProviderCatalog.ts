import type { CapacityProviderDefinition, CapacityTarget } from "../domain/types.js";

export class ProviderCatalog {
  private readonly providerById: Map<string, CapacityProviderDefinition>;

  constructor(providers: CapacityProviderDefinition[]) {
    this.providerById = new Map(providers.map((provider) => [provider.id, provider]));
  }

  listProviders(): CapacityProviderDefinition[] {
    return Array.from(this.providerById.values());
  }

  getProvider(id: string): CapacityProviderDefinition | undefined {
    return this.providerById.get(id);
  }

  replaceProviders(providers: CapacityProviderDefinition[]): void {
    this.providerById.clear();
    for (const provider of providers) this.providerById.set(provider.id, provider);
  }

  providerForTarget(target: CapacityTarget): CapacityProviderDefinition {
    const providerId = target.providerId ?? target.provider;
    const provider = this.providerById.get(providerId);
    if (provider) return provider;
    return {
      id: providerId,
      displayName: providerId,
      type: target.provider,
      provisioning: { enabled: false },
      config: {}
    };
  }
}
