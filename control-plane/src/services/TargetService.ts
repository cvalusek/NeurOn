import type { CapacityTargetRepository, TargetModelDiscoveryRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";
import { cloneTarget } from "../repository/targetRepositoryUtils.js";
import { ModelCatalog } from "./ModelCatalog.js";

export interface TargetView extends CapacityTarget {
  source: "config" | "persisted";
  editable: boolean;
}

export class TargetService {
  constructor(
    private readonly configuredTargets: CapacityTarget[],
    private readonly repository: CapacityTargetRepository,
    private readonly catalog: ModelCatalog,
    private readonly runtimeTargets: CapacityTarget[],
    private readonly modelDiscoveries?: TargetModelDiscoveryRepository
  ) {}

  async initialize(): Promise<void> {
    for (const target of await this.repository.list()) {
      const index = this.runtimeTargets.findIndex((candidate) => candidate.id === target.id);
      if (index >= 0) this.runtimeTargets.splice(index, 1, cloneTarget(target));
      else this.runtimeTargets.push(cloneTarget(target));
      this.catalog.removeTarget(target.id);
      this.catalog.upsertTarget(target);
    }
  }

  async list(): Promise<TargetView[]> {
    const persisted = await this.repository.list();
    const persistedIds = new Set(persisted.map((target) => target.id));
    return [
      ...this.configuredTargets
        .filter((target) => !persistedIds.has(target.id))
        .map((target) => ({ ...cloneTarget(target), source: "config" as const, editable: false })),
      ...persisted.map((target) => ({ ...cloneTarget(target), source: "persisted" as const, editable: true }))
    ].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async create(input: CapacityTarget): Promise<CapacityTarget> {
    const target = normalizeTarget(input);
    if (this.configuredTargets.some((candidate) => candidate.id === target.id)) throw new Error(`Target already exists in config: ${target.id}`);
    const created = await this.repository.create(target);
    this.runtimeTargets.push(cloneTarget(created));
    this.catalog.upsertTarget(created);
    return created;
  }

  async update(id: string, input: CapacityTarget): Promise<CapacityTarget> {
    if (this.configuredTargets.some((candidate) => candidate.id === id) && !(await this.repository.get(id))) {
      throw new Error("Config targets cannot be edited from the UI");
    }
    const target = normalizeTarget(input);
    if (target.id !== id && this.configuredTargets.some((candidate) => candidate.id === target.id)) {
      throw new Error(`Target already exists in config: ${target.id}`);
    }
    const updated = await this.repository.update(id, target);
    if (id !== updated.id) await this.modelDiscoveries?.delete(id);
    const index = this.runtimeTargets.findIndex((candidate) => candidate.id === id);
    if (index >= 0) this.runtimeTargets.splice(index, 1, cloneTarget(updated));
    else this.runtimeTargets.push(cloneTarget(updated));
    this.catalog.removeTarget(id);
    this.catalog.upsertTarget(updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (this.configuredTargets.some((candidate) => candidate.id === id) && !(await this.repository.get(id))) {
      throw new Error("Config targets cannot be deleted from the UI");
    }
    const deleted = await this.repository.delete(id);
    if (deleted) {
      await this.modelDiscoveries?.delete(id);
      const index = this.runtimeTargets.findIndex((target) => target.id === id);
      if (index >= 0) this.runtimeTargets.splice(index, 1);
      this.catalog.removeTarget(id);
      const configured = this.configuredTargets.find((target) => target.id === id);
      if (configured) {
        this.runtimeTargets.push(cloneTarget(configured));
        this.catalog.upsertTarget(configured);
      }
    }
    return deleted;
  }

  async copyConfiguredToPersistence(id: string): Promise<CapacityTarget> {
    const target = this.configuredTargets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`Config target not found: ${id}`);
    if (await this.repository.get(id)) throw new Error(`Target already exists in storage: ${id}`);
    const created = await this.repository.create(cloneTarget(target));
    const index = this.runtimeTargets.findIndex((candidate) => candidate.id === created.id);
    if (index >= 0) this.runtimeTargets.splice(index, 1, cloneTarget(created));
    else this.runtimeTargets.push(cloneTarget(created));
    this.catalog.removeTarget(created.id);
    this.catalog.upsertTarget(created);
    return created;
  }

  async applyProvisioningPatch(id: string, patch: Partial<CapacityTarget> | void): Promise<CapacityTarget | undefined> {
    if (!patch) return this.runtimeTargets.find((target) => target.id === id);
    const runtime = this.runtimeTargets.find((target) => target.id === id);
    if (!runtime) return undefined;
    const updated = mergeTarget(runtime, patch);
    if (await this.repository.get(id)) {
      await this.repository.update(id, updated);
    }
    Object.assign(runtime, updated);
    this.catalog.upsertTarget(runtime);
    return cloneTarget(runtime);
  }

  async canPersistReplacementPatch(id: string): Promise<boolean> {
    return Boolean(await this.repository.get(id));
  }

  async applyReplacementPatch(id: string, patch: Partial<CapacityTarget>): Promise<CapacityTarget | undefined> {
    if (!(await this.canPersistReplacementPatch(id))) {
      throw new Error(`Target ${id} must be persisted before replacement provisioning can update its provider binding`);
    }
    return this.applyProvisioningPatch(id, patch);
  }
}

export function normalizeTarget(input: CapacityTarget): CapacityTarget {
  const provider = input.provider.trim();
  return {
    ...input,
    id: input.id.trim(),
    displayName: (input.displayName || input.id).trim(),
    provider,
    providerId: input.providerId?.trim() || provider,
    modelIds: input.modelIds.map((modelId) => modelId.trim()).filter(Boolean)
  };
}

function mergeTarget(target: CapacityTarget, patch: Partial<CapacityTarget>): CapacityTarget {
  return {
    ...target,
    ...patch,
    aws: patch.aws ? { ...(target.aws ?? {}), ...patch.aws } : target.aws,
    docker: patch.docker ? { ...(target.docker ?? {}), ...patch.docker } : target.docker,
    dockerCompose: patch.dockerCompose ? { ...(target.dockerCompose ?? {}), ...patch.dockerCompose } : target.dockerCompose,
    runpod: patch.runpod ? { ...(target.runpod ?? {}), ...patch.runpod } : target.runpod,
    neuron: patch.neuron ? { ...(target.neuron ?? {}), ...patch.neuron } : target.neuron
  };
}
