import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

type AwsEc2Client = Pick<EC2Client, "send">;

export class AwsEc2CapacityProvider implements CapacityProvider {
  private readonly ec2: AwsEc2Client;

  constructor(region: string, ec2?: AwsEc2Client) {
    this.ec2 = ec2 ?? new EC2Client({ region });
  }

  async provisionTarget(_target: CapacityTarget): Promise<void> {
    throw new Error("AWS EC2 resource provisioning is not implemented");
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const instanceId = requireInstanceId(target);
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const instanceId = requireInstanceId(target);
    await this.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const instanceId = requireInstanceId(target);
    const result = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = result.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((candidate) => candidate.InstanceId === instanceId);
    if (!instance) return { observed: "failed", message: "EC2 instance not found", details: { instanceId } };

    const state = instance.State?.Name;
    const details = {
      instanceId,
      state,
      publicDnsName: instance.PublicDnsName,
      privateDnsName: instance.PrivateDnsName,
      publicIpAddress: instance.PublicIpAddress,
      privateIpAddress: instance.PrivateIpAddress
    };
    if (state === "running") return { observed: "healthy", message: "EC2 instance running", details };
    if (state === "pending") return { observed: "starting", message: "EC2 instance starting", details };
    if (state === "stopping" || state === "shutting-down") return { observed: "stopping", message: "EC2 instance stopping", details };
    if (state === "stopped") return { observed: "stopped", message: "EC2 instance stopped", details };
    if (state === "terminated") return { observed: "failed", message: "EC2 instance terminated", details };
    return { observed: "failed", message: `EC2 instance state is ${state ?? "unknown"}`, details };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }
}

function requireInstanceId(target: CapacityTarget): string {
  const instanceId = target.aws?.instanceId;
  if (!instanceId) throw new Error(`Target ${target.id} is missing AWS EC2 instanceId config`);
  return instanceId;
}
