import { describe, expect, it } from "vitest";
import type { CapacityTarget } from "../domain/types.js";
import { InMemoryTargetProvisioningJobRepository } from "../repository/InMemoryTargetProvisioningJobRepository.js";
import { TargetProvisioningService } from "../services/TargetProvisioningService.js";

const target: CapacityTarget = {
  id: "catalog-target",
  displayName: "Catalog target",
  provider: "runpod",
  providerId: "runpod-main",
  modelIds: ["model-a"],
  runpod: { runtimePort: 8080, create: { imageName: "example.invalid/runtime:fixed" } }
};

describe("TargetProvisioningService", () => {
  it("allows provider capacity creation exactly once from a reviewed draft", async () => {
    const service = new TargetProvisioningService(new InMemoryTargetProvisioningJobRepository());
    const draft = await service.createDraft({
      providerId: "runpod-main",
      providerType: "runpod",
      runtimeProfileId: "prefer",
      target
    });

    expect(draft.status).toBe("draft");
    await expect(service.beginProvision(target)).resolves.toMatchObject({ status: "running" });
    await expect(service.beginProvision(target)).rejects.toThrow(/only a reviewed draft/);

    await service.recordProvisionedResources(target, { runpod: { podId: "pod-1" } });
    await expect(service.list()).resolves.toMatchObject([{
      status: "running",
      targetDraft: { runpod: { runtimePort: 8080, create: { imageName: "example.invalid/runtime:fixed" }, podId: "pod-1" } },
      createdResources: [{ providerType: "runpod", resourceType: "runpod-pod", resourceId: "pod-1", cleanupState: "pending" }]
    }]);

    await service.completeProvision({ ...target, runpod: { ...target.runpod, podId: "pod-1" } }, { runpod: { podId: "pod-1" } });
    await expect(service.beginProvision(target)).rejects.toThrow(/is completed/);
    await expect(service.list()).resolves.toMatchObject([{
      status: "completed",
      createdResources: [{ providerType: "runpod", resourceType: "runpod-pod", resourceId: "pod-1", cleanupState: "pending" }]
    }]);
  });

  it("records an AWS instance before later target persistence can fail", async () => {
    const service = new TargetProvisioningService(new InMemoryTargetProvisioningJobRepository());
    const awsTarget: CapacityTarget = { ...target, provider: "aws-ec2", providerId: "aws-main", aws: { runtimePort: 8080 } };
    await service.createDraft({ providerId: "aws-main", providerType: "aws-ec2", runtimeProfileId: "prefer", target: awsTarget });
    await service.beginProvision(awsTarget);

    await service.recordProvisionedResources(awsTarget, { aws: { instanceId: "i-created" } });
    await service.failProvision(awsTarget.id, new Error("target persistence failed"));

    await expect(service.list()).resolves.toMatchObject([{
      status: "failed",
      targetDraft: { aws: { runtimePort: 8080, instanceId: "i-created" } },
      createdResources: [{ providerType: "aws-ec2", resourceType: "aws-ec2-instance", resourceId: "i-created", cleanupState: "pending" }],
      errorMessage: "target persistence failed"
    }]);
  });

  it("keeps the legacy no-job path available without inventing durable state", async () => {
    const service = new TargetProvisioningService(new InMemoryTargetProvisioningJobRepository());
    await expect(service.beginProvision(target)).resolves.toBeUndefined();
  });
});
