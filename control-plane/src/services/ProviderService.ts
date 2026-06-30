import type { CapacityProviderRepository } from "../domain/interfaces.js";
import type { CapacityProviderDefinition } from "../domain/types.js";
import { ProviderCatalog } from "./ProviderCatalog.js";

export interface ProviderView extends CapacityProviderDefinition {
  source: "config" | "persisted";
  editable: boolean;
}

export class ProviderService {
  constructor(
    private readonly configuredProviders: CapacityProviderDefinition[],
    private readonly repository: CapacityProviderRepository,
    private readonly runtimeCatalog: ProviderCatalog
  ) {}

  async initialize(): Promise<void> {
    await this.refreshRuntimeCatalog();
  }

  async list(): Promise<ProviderView[]> {
    const persisted = await this.repository.list();
    const persistedIds = new Set(persisted.map((provider) => provider.id));
    const views = [
      ...this.configuredProviders
        .filter((provider) => !persistedIds.has(provider.id))
        .map((provider) => ({ ...cloneProvider(provider), source: "config" as const, editable: false })),
      ...persisted.map((provider) => ({ ...cloneProvider(provider), source: "persisted" as const, editable: true }))
    ];
    return views.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async create(input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    const provider = normalizeProvider(input);
    if (this.configuredProviders.some((candidate) => candidate.id === provider.id)) throw new Error(`Provider already exists in config: ${provider.id}`);
    const created = await this.repository.create(provider);
    await this.refreshRuntimeCatalog();
    return created;
  }

  async update(id: string, input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    if (this.configuredProviders.some((candidate) => candidate.id === id) && !(await this.repository.get(id))) {
      throw new Error("Config providers cannot be edited from the UI");
    }
    const provider = normalizeProvider(input);
    if (provider.id !== id && this.configuredProviders.some((candidate) => candidate.id === provider.id)) {
      throw new Error(`Provider already exists in config: ${provider.id}`);
    }
    const updated = await this.repository.update(id, provider);
    await this.refreshRuntimeCatalog();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (this.configuredProviders.some((candidate) => candidate.id === id) && !(await this.repository.get(id))) {
      throw new Error("Config providers cannot be deleted from the UI");
    }
    const deleted = await this.repository.delete(id);
    await this.refreshRuntimeCatalog();
    return deleted;
  }

  async copyConfiguredToPersistence(id: string): Promise<CapacityProviderDefinition> {
    const provider = this.configuredProviders.find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`Config provider not found: ${id}`);
    if (await this.repository.get(id)) throw new Error(`Provider already exists in storage: ${id}`);
    const created = await this.repository.create(cloneProvider(provider));
    await this.refreshRuntimeCatalog();
    return created;
  }

  private async refreshRuntimeCatalog(): Promise<void> {
    this.runtimeCatalog.replaceProviders([...this.configuredProviders, ...(await this.repository.list())]);
  }
}

export function normalizeProvider(input: CapacityProviderDefinition): CapacityProviderDefinition {
  return {
    id: input.id.trim(),
    displayName: (input.displayName || input.id).trim(),
    type: input.type.trim(),
    provisioning: input.provisioning ? { enabled: input.provisioning.enabled ?? false } : undefined,
    config: input.config,
    credentialId: input.credentialId?.trim() || undefined
  };
}

function cloneProvider(provider: CapacityProviderDefinition): CapacityProviderDefinition {
  return {
    ...provider,
    provisioning: provider.provisioning ? { ...provider.provisioning } : undefined,
    config: provider.config ? JSON.parse(JSON.stringify(provider.config)) as CapacityProviderDefinition["config"] : undefined
  };
}
