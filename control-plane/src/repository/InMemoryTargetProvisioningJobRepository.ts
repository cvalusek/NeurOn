import type { TargetProvisioningJobRepository } from "../domain/interfaces.js";
import type { TargetProvisioningJob } from "../domain/types.js";
import { cloneTargetProvisioningJob } from "./targetProvisioningJobUtils.js";

export class InMemoryTargetProvisioningJobRepository implements TargetProvisioningJobRepository {
  private readonly jobs = new Map<string, TargetProvisioningJob>();

  async create(input: TargetProvisioningJob): Promise<TargetProvisioningJob> {
    if (this.jobs.has(input.id)) throw new Error(`Target provisioning job already exists: ${input.id}`);
    this.jobs.set(input.id, cloneTargetProvisioningJob(input));
    return cloneTargetProvisioningJob(input);
  }

  async get(id: string): Promise<TargetProvisioningJob | undefined> {
    const job = this.jobs.get(id);
    return job ? cloneTargetProvisioningJob(job) : undefined;
  }

  async getForTarget(targetId: string): Promise<TargetProvisioningJob | undefined> {
    const jobs = await this.list();
    return jobs.find((job) => job.targetId === targetId);
  }

  async list(): Promise<TargetProvisioningJob[]> {
    return Array.from(this.jobs.values())
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneTargetProvisioningJob);
  }

  async update(id: string, patch: Partial<TargetProvisioningJob>): Promise<TargetProvisioningJob> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Target provisioning job not found: ${id}`);
    const updated = { ...current, ...patch, id, updatedAt: patch.updatedAt ?? new Date() };
    this.jobs.set(id, cloneTargetProvisioningJob(updated));
    return cloneTargetProvisioningJob(updated);
  }
}
