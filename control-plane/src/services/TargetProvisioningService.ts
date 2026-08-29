import { nanoid } from "nanoid";
import type { TargetProvisioningJobRepository } from "../domain/interfaces.js";
import type { CapacityTarget, TargetProvisioningJob, TargetProvisioningResource, TargetProvisioningJobStatus } from "../domain/types.js";

export class TargetProvisioningService {
  constructor(private readonly repository: TargetProvisioningJobRepository) {}

  async createDraft(input: {
    providerId: string;
    providerType: string;
    runtimeProfileId?: string;
    target: CapacityTarget;
  }): Promise<TargetProvisioningJob> {
    const existing = await this.repository.getForTarget(input.target.id);
    if (existing) return existing;
    const now = new Date();
    return this.repository.create({
      id: nanoid(12),
      status: "draft",
      providerId: input.providerId,
      providerType: input.providerType,
      runtimeProfileId: input.runtimeProfileId,
      targetId: input.target.id,
      targetDraft: input.target,
      createdResources: [],
      createdAt: now,
      updatedAt: now
    });
  }

  async beginProvision(target: CapacityTarget): Promise<TargetProvisioningJob | undefined> {
    const job = await this.repository.getForTarget(target.id);
    if (!job) return undefined;
    if (job.status !== "draft") {
      throw new Error(`Provisioning job for ${target.id} is ${job.status}; only a reviewed draft can create provider capacity`);
    }
    return this.transition(job.id, "running");
  }

  async recordProvisionedResources(target: CapacityTarget, patch: Partial<CapacityTarget> | void): Promise<TargetProvisioningJob | undefined> {
    const job = await this.repository.getForTarget(target.id);
    if (!job) return undefined;
    if (job.status !== "running") {
      throw new Error(`Provisioning job for ${target.id} is ${job.status}; resources can only be recorded for a running job`);
    }
    return this.repository.update(job.id, {
      targetDraft: mergeProvisioningTarget(target, patch),
      createdResources: mergeResources(job.createdResources, resourcesFromProvisioningPatch(job.providerType, patch)),
      updatedAt: new Date()
    });
  }

  async completeProvision(target: CapacityTarget, patch: Partial<CapacityTarget> | void): Promise<TargetProvisioningJob | undefined> {
    const job = await this.repository.getForTarget(target.id);
    if (!job) return undefined;
    const resources = mergeResources(job.createdResources, resourcesFromProvisioningPatch(job.providerType, patch));
    return this.repository.update(job.id, {
      status: "completed",
      targetDraft: mergeProvisioningTarget(target, patch),
      createdResources: resources,
      updatedAt: new Date(),
      errorMessage: undefined
    });
  }

  async failProvision(targetId: string, error: unknown): Promise<void> {
    const job = await this.repository.getForTarget(targetId);
    if (!job) return;
    await this.repository.update(job.id, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: new Date()
    });
  }

  async abort(targetId: string): Promise<TargetProvisioningJob | undefined> {
    const job = await this.repository.getForTarget(targetId);
    if (!job) return undefined;
    return this.repository.update(job.id, {
      status: "aborted",
      createdResources: job.createdResources.map((resource) => ({ ...resource, cleanupState: resource.cleanupState === "deleted" ? "deleted" : "unknown" })),
      updatedAt: new Date()
    });
  }

  async list(): Promise<TargetProvisioningJob[]> {
    return this.repository.list();
  }

  private async transition(id: string, status: TargetProvisioningJobStatus): Promise<TargetProvisioningJob> {
    return this.repository.update(id, { status, updatedAt: new Date(), errorMessage: undefined });
  }
}

function resourcesFromProvisioningPatch(providerType: string, patch: Partial<CapacityTarget> | void): TargetProvisioningResource[] {
  if (!patch) return [];
  if (providerType === "runpod" && patch.runpod?.podId) {
    return [{ providerType, resourceType: "runpod-pod", resourceId: patch.runpod.podId, cleanupState: "pending" }];
  }
  if (providerType === "aws-ec2" && patch.aws?.instanceId) {
    return [{ providerType, resourceType: "aws-ec2-instance", resourceId: patch.aws.instanceId, cleanupState: "pending" }];
  }
  return [];
}

function mergeResources(left: TargetProvisioningResource[], right: TargetProvisioningResource[]): TargetProvisioningResource[] {
  const resources = new Map<string, TargetProvisioningResource>();
  for (const resource of [...left, ...right]) resources.set(`${resource.resourceType}:${resource.resourceId}`, resource);
  return Array.from(resources.values());
}

function mergeProvisioningTarget(target: CapacityTarget, patch: Partial<CapacityTarget> | void): CapacityTarget {
  if (!patch) return target;
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
