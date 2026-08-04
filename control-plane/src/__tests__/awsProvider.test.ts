import { DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";
import { AwsEc2CapacityProvider } from "../capacity/AwsEc2CapacityProvider.js";
import { AwsEcsAsgCapacityProvider } from "../capacity/AwsEcsAsgCapacityProvider.js";
import type { CapacityTarget } from "../domain/types.js";

const ec2Target: CapacityTarget = {
  id: "ec2-gpu",
  displayName: "EC2 GPU",
  provider: "aws-ec2",
  modelIds: ["qwen"],
  aws: { instanceId: "i-1234567890abcdef0" }
};

const ecsTarget: CapacityTarget = {
  id: "ecs-gpu",
  displayName: "ECS GPU",
  provider: "aws-ecs",
  modelIds: ["qwen"],
  aws: { cluster: "llm-cluster", service: "prefer", autoScalingGroupName: "prefer-asg" }
};

describe("AWS EC2 provider", () => {
  it("starts and stops the configured instance", async () => {
    const commands: unknown[] = [];
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      send: async (command) => {
        commands.push(command);
        return {};
      }
    });

    await provider.ensureTargetOn(ec2Target);
    await provider.ensureTargetOff(ec2Target);

    expect(commands[0]).toBeInstanceOf(StartInstancesCommand);
    expect(commandInput(commands[0])).toEqual({ InstanceIds: ["i-1234567890abcdef0"] });
    expect(commands[1]).toBeInstanceOf(StopInstancesCommand);
    expect(commandInput(commands[1])).toEqual({ InstanceIds: ["i-1234567890abcdef0"] });
  });

  it("maps instance lifecycle states to NeurOn status", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      send: async (command) => {
        expect(command).toBeInstanceOf(DescribeInstancesCommand);
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-1234567890abcdef0",
                  State: { Name: "pending" },
                  PrivateIpAddress: "10.0.0.10"
                }
              ]
            }
          ]
        };
      }
    });

    await expect(provider.getTargetStatus(ec2Target)).resolves.toMatchObject({
      observed: "starting",
      message: "EC2 instance starting",
      details: { instanceId: "i-1234567890abcdef0", state: "pending", privateIpAddress: "10.0.0.10" }
    });
  });

  it("requires an instance ID", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", { send: async () => ({}) });

    await expect(provider.ensureTargetOn({ ...ec2Target, aws: {} })).rejects.toThrow("missing AWS EC2 instanceId config");
  });

  it("treats a terminated instance as failed capacity", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      send: async () => ({ Reservations: [{ Instances: [{ InstanceId: "i-1234567890abcdef0", State: { Name: "terminated" } }] }] })
    });

    await expect(provider.getTargetStatus(ec2Target)).resolves.toMatchObject({
      observed: "failed",
      message: "EC2 instance terminated"
    });
  });
});

describe("AWS ECS/ASG provider", () => {
  it("updates ASG and ECS desired capacity when turning targets on and off", async () => {
    const commands: unknown[] = [];
    const provider = new AwsEcsAsgCapacityProvider("us-east-1", {
      asg: {
        send: async (command) => {
          commands.push(command);
          return {};
        }
      },
      ecs: {
        send: async (command) => {
          commands.push(command);
          return {};
        }
      }
    });

    await provider.ensureTargetOn(ecsTarget);
    await provider.ensureTargetOff(ecsTarget);

    expect(commands[0]).toBeInstanceOf(SetDesiredCapacityCommand);
    expect(commandInput(commands[0])).toEqual({ AutoScalingGroupName: "prefer-asg", DesiredCapacity: 1, HonorCooldown: false });
    expect(commands[1]).toBeInstanceOf(UpdateServiceCommand);
    expect(commandInput(commands[1])).toEqual({ cluster: "llm-cluster", service: "prefer", desiredCount: 1 });
    expect(commands[2]).toBeInstanceOf(UpdateServiceCommand);
    expect(commandInput(commands[2])).toEqual({ cluster: "llm-cluster", service: "prefer", desiredCount: 0 });
    expect(commands[3]).toBeInstanceOf(SetDesiredCapacityCommand);
    expect(commandInput(commands[3])).toEqual({ AutoScalingGroupName: "prefer-asg", DesiredCapacity: 0, HonorCooldown: false });
  });

  it("reports stopped when ECS and ASG have converged to zero capacity", async () => {
    const provider = new AwsEcsAsgCapacityProvider("us-east-1", {
      ecs: {
        send: async (command) => {
          expect(command).toBeInstanceOf(DescribeServicesCommand);
          return { services: [{ desiredCount: 0, runningCount: 0 }] };
        }
      },
      asg: {
        send: async (command) => {
          expect(command).toBeInstanceOf(DescribeAutoScalingGroupsCommand);
          return { AutoScalingGroups: [{ DesiredCapacity: 0, Instances: [] }] };
        }
      }
    });

    await expect(provider.getTargetStatus(ecsTarget)).resolves.toMatchObject({
      observed: "stopped",
      message: "Stopped",
      details: { desiredCount: 0, runningCount: 0, asgDesired: 0 }
    });
  });

  it("requires the ASG name for ECS/ASG targets", async () => {
    const provider = new AwsEcsAsgCapacityProvider("us-east-1", {
      ecs: { send: async () => ({}) },
      asg: { send: async () => ({}) }
    });

    await expect(provider.ensureTargetOn({ ...ecsTarget, aws: { cluster: "llm-cluster", service: "prefer" } })).rejects.toThrow("missing AWS autoScalingGroupName config");
  });
});

function commandInput(command: unknown): unknown {
  return (command as { input: unknown }).input;
}
