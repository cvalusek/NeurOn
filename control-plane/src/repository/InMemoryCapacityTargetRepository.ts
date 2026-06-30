import type { CapacityTargetRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";
import { cloneTarget } from "./targetRepositoryUtils.js";

export class InMemoryCapacityTargetRepository implements CapacityTargetRepository {
  private readonly targets = new Map<string, CapacityTarget>();

  async create(input: CapacityTarget): Promise<CapacityTarget> {
    if (this.targets.has(input.id)) throw new Error(`Target already exists: ${input.id}`);
    this.targets.set(input.id, cloneTarget(input));
    return cloneTarget(input);
  }

  async get(id: string): Promise<CapacityTarget | undefined> {
    const target = this.targets.get(id);
    return target ? cloneTarget(target) : undefined;
  }

  async list(): Promise<CapacityTarget[]> {
    return Array.from(this.targets.values())
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(cloneTarget);
  }

  async update(id: string, input: CapacityTarget): Promise<CapacityTarget> {
    if (!this.targets.has(id)) throw new Error(`Target not found: ${id}`);
    if (input.id !== id && this.targets.has(input.id)) throw new Error(`Target already exists: ${input.id}`);
    this.targets.delete(id);
    this.targets.set(input.id, cloneTarget(input));
    return cloneTarget(input);
  }

  async delete(id: string): Promise<boolean> {
    return this.targets.delete(id);
  }
}
