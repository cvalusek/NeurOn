import type { TargetProvisioningJob } from "../domain/types.js";

export function cloneTargetProvisioningJob(job: TargetProvisioningJob): TargetProvisioningJob {
  return {
    ...JSON.parse(JSON.stringify(job)),
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt)
  } as TargetProvisioningJob;
}

export function targetProvisioningJobFromJson(value: string | TargetProvisioningJob): TargetProvisioningJob {
  const parsed = typeof value === "string" ? JSON.parse(value) as TargetProvisioningJob : value;
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt)
  };
}
