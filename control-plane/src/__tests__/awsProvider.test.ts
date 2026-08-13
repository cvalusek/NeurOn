import { DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, DescribeSpotPriceHistoryCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { GetProductsCommand } from "@aws-sdk/client-pricing";
import { describe, expect, it } from "vitest";
import { AwsEc2CapacityProvider } from "../capacity/AwsEc2CapacityProvider.js";
import { AwsEcsAsgCapacityProvider } from "../capacity/AwsEcsAsgCapacityProvider.js";
import type { CapacityTarget } from "../domain/types.js";
import { NoopBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { Reconciler } from "../reconciler/Reconciler.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";

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
      ec2: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof DescribeInstancesCommand) {
            return { Reservations: [{ Instances: [{ InstanceId: "i-1234567890abcdef0", State: { Name: "stopped" } }] }] };
          }
          return {};
        }
      }
    });

    await provider.ensureTargetOn(ec2Target);
    await provider.ensureTargetOff(ec2Target);

    expect(commands[0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(commands[1]).toBeInstanceOf(StartInstancesCommand);
    expect(commandInput(commands[1])).toEqual({ InstanceIds: ["i-1234567890abcdef0"] });
    expect(commands[2]).toBeInstanceOf(StopInstancesCommand);
    expect(commandInput(commands[2])).toEqual({ InstanceIds: ["i-1234567890abcdef0"] });
  });

  it("waits for a stopping instance and starts it on a later stopped observation", async () => {
    const commands: unknown[] = [];
    const states: Array<"stopping" | "stopped"> = ["stopping", "stopped"];
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof DescribeInstancesCommand) {
            return {
              Reservations: [{ Instances: [{
                InstanceId: "i-1234567890abcdef0",
                State: { Name: states.shift() }
              }] }]
            };
          }
          return {};
        }
      }
    });

    await provider.ensureTargetOn(ec2Target);
    expect(commands.filter((command) => command instanceof StartInstancesCommand)).toHaveLength(0);

    await provider.ensureTargetOn(ec2Target);
    expect(commands.filter((command) => command instanceof StartInstancesCommand)).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(commands[1]).toBeInstanceOf(DescribeInstancesCommand);
    expect(commands[2]).toBeInstanceOf(StartInstancesCommand);
  });

  it("keeps reservation demand active until a stopping instance can restart", async () => {
    const commands: unknown[] = [];
    const states: Array<"stopping" | "stopped" | "pending"> = ["stopping", "stopping", "stopped", "pending"];
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof DescribeInstancesCommand) {
            return {
              Reservations: [{ Instances: [{
                InstanceId: "i-1234567890abcdef0",
                State: { Name: states.shift() }
              }] }]
            };
          }
          return {};
        }
      }
    });
    const reservations = new InMemoryReservationRepository();
    const statuses = new InMemoryTargetStatusRepository();
    const now = new Date("2026-08-13T10:00:00.000Z");
    const reservation = await reservations.create({
      username: "clint",
      modelIds: ["qwen"],
      targetIds: [ec2Target.id],
      createdAt: now,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      status: "active"
    });
    const reconciler = new Reconciler([ec2Target], reservations, statuses, provider, new NoopBackendConfigSync());

    await reconciler.reconcile(now);
    expect(statuses.get(ec2Target.id)).toMatchObject({
      desired: "on",
      observed: "starting",
      message: "Waiting for target to finish stopping before restart"
    });
    expect((await reservations.get(reservation.id))?.status).toBe("active");
    expect(commands.filter((command) => command instanceof StartInstancesCommand)).toHaveLength(0);

    await reconciler.reconcile(new Date("2026-08-13T10:00:10.000Z"));
    expect(commands.filter((command) => command instanceof StartInstancesCommand)).toHaveLength(1);
    expect(statuses.get(ec2Target.id)).toMatchObject({
      desired: "on",
      observed: "starting",
      message: "EC2 instance starting"
    });
    expect((await reservations.get(reservation.id))?.status).toBe("active");
  });

  it("does not issue start calls for instances already running or pending", async () => {
    const commands: unknown[] = [];
    const states: Array<"running" | "pending"> = ["running", "pending"];
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: {
        send: async (command) => {
          commands.push(command);
          return {
            Reservations: [{ Instances: [{
              InstanceId: "i-1234567890abcdef0",
              State: { Name: states.shift() }
            }] }]
          };
        }
      }
    });

    await provider.ensureTargetOn(ec2Target);
    await provider.ensureTargetOn(ec2Target);

    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command instanceof DescribeInstancesCommand)).toBe(true);
  });

  it("fails closed when an instance cannot be restarted", async () => {
    const commands: unknown[] = [];
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: {
        send: async (command) => {
          commands.push(command);
          return { Reservations: [{ Instances: [{ InstanceId: "i-1234567890abcdef0", State: { Name: "shutting-down" } }] }] };
        }
      }
    });

    await expect(provider.ensureTargetOn(ec2Target)).rejects.toThrow("is shutting-down and cannot be restarted");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(DescribeInstancesCommand);
  });

  it("maps instance lifecycle states to NeurOn status", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: {
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
      }
    });

    await expect(provider.getTargetStatus(ec2Target)).resolves.toMatchObject({
      observed: "starting",
      message: "EC2 instance starting",
      details: { instanceId: "i-1234567890abcdef0", state: "pending", privateIpAddress: "10.0.0.10" },
      runtime: {
        apiUrl: "http://10.0.0.10:8080/v1",
        healthUrl: "http://10.0.0.10:8080/health"
      }
    });
  });

  it("uses target runtime endpoint overrides with the discovered private address", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-2", {
      ec2: {
        send: async () => ({
          Reservations: [{ Instances: [{ InstanceId: "i-1234567890abcdef0", State: { Name: "running" }, PrivateDnsName: "ip-10-0-0-20.internal" }] }]
        })
      }
    });

    await expect(provider.getTargetStatus({
      ...ec2Target,
      aws: { ...ec2Target.aws, runtimePort: 9000, runtimeProtocol: "https", apiPath: "openai/v1", healthPath: "/ready" }
    })).resolves.toMatchObject({
      runtime: {
        apiUrl: "https://ip-10-0-0-20.internal:9000/openai/v1",
        healthUrl: "https://ip-10-0-0-20.internal:9000/ready"
      }
    });
  });

  it("discovers active instances using the default provider Name-tag pattern", async () => {
    const commands: unknown[] = [];
    const provider = new AwsEc2CapacityProvider("us-east-2", {
      ec2: {
        send: async (command) => {
          commands.push(command);
          return {
            Reservations: [{ Instances: [{
              InstanceId: "i-1234567890abcdef0",
              InstanceType: "g6.xlarge",
              State: { Name: "stopped" },
              Placement: { AvailabilityZone: "us-east-2a" },
              PrivateIpAddress: "10.0.0.10",
              Tags: [{ Key: "Name", Value: "epd.sandbox.prefer.g6.xlarge.general" }]
            }] }]
          };
        }
      }
    });

    await expect(provider.discoverResources({
      id: "ec2",
      displayName: "EC2",
      type: "aws-ec2"
    })).resolves.toEqual([{
      id: "i-1234567890abcdef0",
      displayName: "epd.sandbox.prefer.g6.xlarge.general",
      state: "stopped",
      details: {
        instanceType: "g6.xlarge",
        availabilityZone: "us-east-2a",
        privateIpAddress: "10.0.0.10",
        privateDnsName: undefined
      }
    }]);
    expect(commandInput(commands[0])).toEqual({ Filters: [
      { Name: "tag:Name", Values: ["*.prefer.*"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }
    ] });

    await provider.discoverResources({
      id: "ec2",
      displayName: "EC2",
      type: "aws-ec2",
      config: { awsEc2: { instanceNamePattern: "team.prefer.*" } }
    });
    expect(commandInput(commands[1])).toMatchObject({
      Filters: expect.arrayContaining([{ Name: "tag:Name", Values: ["team.prefer.*"] }])
    });
  });

  it("discovers the current on-demand hourly price", async () => {
    const pricingCommands: unknown[] = [];
    const provider = new AwsEc2CapacityProvider("us-east-2", {
      ec2: { send: async () => ({ Reservations: [{ Instances: [{
        InstanceId: "i-1234567890abcdef0",
        InstanceType: "g6.xlarge",
        PlatformDetails: "Linux/UNIX",
        Placement: { Tenancy: "default" },
        UsageOperation: "RunInstances"
      }] }] }) },
      pricing: { send: async (command) => {
        pricingCommands.push(command);
        return { PriceList: [JSON.stringify({ terms: { OnDemand: { term: { priceDimensions: { hourly: { unit: "Hrs", pricePerUnit: { USD: "0.804" } } } } } } })] };
      } }
    });

    await expect(provider.getTargetCostEstimate(ec2Target)).resolves.toEqual({ hourlyUsd: 0.804 });
    expect(pricingCommands[0]).toBeInstanceOf(GetProductsCommand);
    expect(commandInput(pricingCommands[0])).toMatchObject({ ServiceCode: "AmazonEC2" });
    expect(commandInput(pricingCommands[0])).toMatchObject({ Filters: expect.arrayContaining([{ Type: "TERM_MATCH", Field: "regionCode", Value: "us-east-2" }]) });
  });

  it("discovers the newest spot hourly price", async () => {
    const ec2Commands: unknown[] = [];
    const provider = new AwsEc2CapacityProvider("us-east-2", {
      ec2: { send: async (command) => {
        ec2Commands.push(command);
        if (command instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: [{
          InstanceId: "i-1234567890abcdef0",
          InstanceLifecycle: "spot",
          InstanceType: "g6.xlarge",
          PlatformDetails: "Linux/UNIX",
          Placement: { AvailabilityZone: "us-east-2a" }
        }] }] };
        return { SpotPriceHistory: [{ SpotPrice: "0.34", Timestamp: new Date("2026-08-05T12:00:00Z") }] };
      } }
    });

    await expect(provider.getTargetCostEstimate(ec2Target)).resolves.toEqual({ hourlyUsd: 0.34 });
    expect(ec2Commands[1]).toBeInstanceOf(DescribeSpotPriceHistoryCommand);
  });

  it("requires an instance ID", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", { ec2: { send: async () => ({}) } });

    await expect(provider.ensureTargetOn({ ...ec2Target, aws: {} })).rejects.toThrow("missing AWS EC2 instanceId config");
  });

  it("treats a terminated instance as failed capacity", async () => {
    const provider = new AwsEc2CapacityProvider("us-east-1", {
      ec2: { send: async () => ({ Reservations: [{ Instances: [{ InstanceId: "i-1234567890abcdef0", State: { Name: "terminated" } }] }] }) }
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
