import {
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance
} from "@aws-sdk/client-ec2";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderDefinition, CapacityProviderResource, CapacityProviderStatus, CapacityTarget, TargetCostEstimateConfig } from "../domain/types.js";

type AwsEc2Client = Pick<EC2Client, "send">;
type AwsPricingClient = Pick<PricingClient, "send">;

interface AwsEc2Clients {
  ec2?: AwsEc2Client;
  pricing?: AwsPricingClient;
}

interface CachedCost {
  expiresAt: number;
  estimate?: TargetCostEstimateConfig;
}

const COST_CACHE_MS = 60 * 60 * 1000;

export class AwsEc2CapacityProvider implements CapacityProvider {
  private readonly ec2: AwsEc2Client;
  private readonly pricing: AwsPricingClient;
  private readonly costCache = new Map<string, CachedCost>();

  constructor(private readonly region: string, clients: AwsEc2Clients = {}) {
    this.ec2 = clients.ec2 ?? new EC2Client({ region });
    // Price List has regional endpoints in us-east-1, eu-central-1, and ap-south-1.
    // Product filters still use the workload region supplied to this provider.
    this.pricing = clients.pricing ?? new PricingClient({ region: "us-east-1" });
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
    const instance = await this.describeInstance(instanceId);
    if (!instance) return { observed: "failed", message: "EC2 instance not found", details: { instanceId } };

    const state = instance.State?.Name;
    const details = {
      instanceId,
      instanceType: instance.InstanceType,
      availabilityZone: instance.Placement?.AvailabilityZone,
      state,
      publicDnsName: instance.PublicDnsName,
      privateDnsName: instance.PrivateDnsName,
      publicIpAddress: instance.PublicIpAddress,
      privateIpAddress: instance.PrivateIpAddress
    };
    const runtime = runtimeEndpoints(target, instance);
    if (state === "running") return { observed: "healthy", message: "EC2 instance running", details, runtime };
    if (state === "pending") return { observed: "starting", message: "EC2 instance starting", details, runtime };
    if (state === "stopping" || state === "shutting-down") return { observed: "stopping", message: "EC2 instance stopping", details, runtime };
    if (state === "stopped") return { observed: "stopped", message: "EC2 instance stopped", details, runtime };
    if (state === "terminated") return { observed: "failed", message: "EC2 instance terminated", details };
    return { observed: "failed", message: `EC2 instance state is ${state ?? "unknown"}`, details, runtime };
  }

  async getTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined> {
    const instanceId = requireInstanceId(target);
    const cached = this.costCache.get(instanceId);
    if (cached && cached.expiresAt > Date.now()) return cached.estimate;

    const instance = await this.describeInstance(instanceId);
    const hourlyUsd = instance?.InstanceLifecycle === "spot"
      ? await this.spotHourlyCost(instance)
      : instance?.InstanceLifecycle
        ? undefined
        : await this.onDemandHourlyCost(instance);
    const estimate = hourlyUsd === undefined ? undefined : { hourlyUsd };
    this.costCache.set(instanceId, { expiresAt: Date.now() + COST_CACHE_MS, estimate });
    return estimate;
  }

  async discoverResources(provider: CapacityProviderDefinition): Promise<CapacityProviderResource[]> {
    const namePattern = provider.config?.awsEc2?.instanceNamePattern?.trim();
    const result = await this.ec2.send(new DescribeInstancesCommand({
      Filters: [
        ...(namePattern ? [{ Name: "tag:Name", Values: [namePattern] }] : []),
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }
      ]
    }));
    return (result.Reservations ?? [])
      .flatMap((reservation) => reservation.Instances ?? [])
      .filter((instance): instance is Instance & { InstanceId: string } => Boolean(instance.InstanceId))
      .map((instance) => {
        const name = instance.Tags?.find((tag) => tag.Key === "Name")?.Value || instance.InstanceId;
        return {
          id: instance.InstanceId,
          displayName: name,
          state: instance.State?.Name,
          details: {
            instanceType: instance.InstanceType,
            availabilityZone: instance.Placement?.AvailabilityZone,
            privateIpAddress: instance.PrivateIpAddress,
            privateDnsName: instance.PrivateDnsName
          }
        };
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }

  private async describeInstance(instanceId: string): Promise<Instance | undefined> {
    const result = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return result.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((candidate) => candidate.InstanceId === instanceId);
  }

  private async onDemandHourlyCost(instance: Instance | undefined): Promise<number | undefined> {
    if (!instance?.InstanceType) return undefined;
    const result = await this.pricing.send(new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      FormatVersion: "aws_v1",
      MaxResults: 10,
      Filters: [
        term("instanceType", instance.InstanceType),
        term("regionCode", this.region),
        term("operatingSystem", pricingOperatingSystem(instance.PlatformDetails)),
        term("tenancy", pricingTenancy(instance.Placement?.Tenancy)),
        term("preInstalledSw", "NA"),
        term("capacitystatus", "Used"),
        term("operation", instance.UsageOperation ?? "RunInstances")
      ]
    }));
    return onDemandHourlyPrice(result.PriceList ?? []);
  }

  private async spotHourlyCost(instance: Instance): Promise<number | undefined> {
    if (!instance.InstanceType) return undefined;
    const result = await this.ec2.send(new DescribeSpotPriceHistoryCommand({
      AvailabilityZone: instance.Placement?.AvailabilityZone,
      InstanceTypes: [instance.InstanceType],
      ProductDescriptions: [spotProductDescription(instance.PlatformDetails)],
      StartTime: new Date(),
      MaxResults: 10
    }));
    const prices = (result.SpotPriceHistory ?? [])
      .map((entry) => ({ price: Number(entry.SpotPrice), timestamp: entry.Timestamp?.getTime() ?? 0 }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price >= 0)
      .sort((left, right) => right.timestamp - left.timestamp);
    return prices[0]?.price;
  }
}

function requireInstanceId(target: CapacityTarget): string {
  const instanceId = target.aws?.instanceId;
  if (!instanceId) throw new Error(`Target ${target.id} is missing AWS EC2 instanceId config`);
  return instanceId;
}

function runtimeEndpoints(target: CapacityTarget, instance: Instance): CapacityProviderStatus["runtime"] {
  const host = instance.PrivateIpAddress || instance.PrivateDnsName;
  if (!host) return undefined;
  const protocol = target.aws?.runtimeProtocol ?? "http";
  const port = target.aws?.runtimePort ?? 8080;
  const origin = `${protocol}://${host}:${port}`;
  return {
    apiUrl: `${origin}${path(target.aws?.apiPath, "/v1")}`,
    healthUrl: `${origin}${path(target.aws?.healthPath, "/health")}`
  };
}

function path(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return selected.startsWith("/") ? selected : `/${selected}`;
}

function term(field: string, value: string) {
  return { Type: "TERM_MATCH" as const, Field: field, Value: value };
}

function pricingOperatingSystem(platformDetails: string | undefined): string {
  const platform = platformDetails?.toLowerCase() ?? "";
  if (platform.includes("windows")) return "Windows";
  if (platform.includes("red hat")) return "RHEL";
  if (platform.includes("suse")) return "SUSE";
  return "Linux";
}

function spotProductDescription(platformDetails: string | undefined): string {
  const platform = platformDetails?.toLowerCase() ?? "";
  if (platform.includes("windows")) return "Windows";
  if (platform.includes("red hat")) return "Red Hat Enterprise Linux";
  if (platform.includes("suse")) return "SUSE Linux";
  return "Linux/UNIX";
}

function pricingTenancy(tenancy: string | undefined): string {
  if (tenancy === "dedicated") return "Dedicated";
  if (tenancy === "host") return "Host";
  return "Shared";
}

function onDemandHourlyPrice(priceList: string[]): number | undefined {
  for (const item of priceList) {
    const document = JSON.parse(item) as PriceDocument;
    for (const term of Object.values(document.terms?.OnDemand ?? {})) {
      for (const dimension of Object.values(term.priceDimensions ?? {})) {
        if (dimension.unit && dimension.unit !== "Hrs") continue;
        const price = Number(dimension.pricePerUnit?.USD);
        if (Number.isFinite(price) && price >= 0) return price;
      }
    }
  }
  return undefined;
}

interface PriceDocument {
  terms?: {
    OnDemand?: Record<string, {
      priceDimensions?: Record<string, {
        unit?: string;
        pricePerUnit?: { USD?: string };
      }>;
    }>;
  };
}
