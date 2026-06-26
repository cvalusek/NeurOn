import { AutoScalingClient, DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

export class AwsEcsAsgCapacityProvider implements CapacityProvider {
  private readonly ecs: ECSClient;
  private readonly asg: AutoScalingClient;

  constructor(region: string) {
    this.ecs = new ECSClient({ region });
    this.asg = new AutoScalingClient({ region });
  }

  async installTarget(_target: CapacityTarget): Promise<void> {
    throw new Error("AWS ECS/ASG target installation is not implemented");
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const aws = requireAws(target);
    await this.asg.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: aws.autoScalingGroupName, DesiredCapacity: 1, HonorCooldown: false }));
    await this.ecs.send(new UpdateServiceCommand({ cluster: aws.cluster, service: aws.service, desiredCount: 1 }));
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const aws = requireAws(target);
    await this.ecs.send(new UpdateServiceCommand({ cluster: aws.cluster, service: aws.service, desiredCount: 0 }));
    await this.asg.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: aws.autoScalingGroupName, DesiredCapacity: 0, HonorCooldown: false }));
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const aws = requireAws(target);
    const [serviceResult, asgResult] = await Promise.all([
      this.ecs.send(new DescribeServicesCommand({ cluster: aws.cluster, services: [aws.service] })),
      this.asg.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [aws.autoScalingGroupName] }))
    ]);
    const service = serviceResult.services?.[0];
    const group = asgResult.AutoScalingGroups?.[0];
    if (!service || !group) return { observed: "failed", message: "ECS service or ASG not found" };
    const desiredCount = service.desiredCount ?? 0;
    const runningCount = service.runningCount ?? 0;
    const asgDesired = group.DesiredCapacity ?? 0;
    const inServiceInstances = group.Instances?.filter((instance) => instance.LifecycleState === "InService").length ?? 0;
    if (desiredCount === 0 && asgDesired === 0 && runningCount === 0) return { observed: "stopped", message: "Stopped", details: { desiredCount, runningCount, asgDesired } };
    if (desiredCount > 0 && runningCount > 0 && inServiceInstances > 0) return { observed: "healthy", message: "ECS service running", details: { desiredCount, runningCount, asgDesired, inServiceInstances } };
    return { observed: desiredCount > 0 || asgDesired > 0 ? "provisioning" : "stopping", message: "Waiting for ECS/ASG convergence", details: { desiredCount, runningCount, asgDesired, inServiceInstances } };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }
}

function requireAws(target: CapacityTarget) {
  if (!target.aws) throw new Error(`Target ${target.id} is missing AWS config`);
  const cluster = target.aws.cluster ?? target.aws.clusterName;
  const service = target.aws.service ?? target.aws.serviceName;
  if (!cluster || !service) throw new Error(`Target ${target.id} is missing ECS cluster or service config`);
  return { ...target.aws, cluster, service };
}
