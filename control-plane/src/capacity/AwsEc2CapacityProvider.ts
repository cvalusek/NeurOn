import {
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
  type _InstanceType
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
export const DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN = "*.prefer.*";
export const DEFAULT_AWS_EC2_USER_DATA_BEGIN_MARKER = "# BEGIN NEURON MANAGED PREFER DEPLOYMENT";
export const DEFAULT_AWS_EC2_USER_DATA_END_MARKER = "# END NEURON MANAGED PREFER DEPLOYMENT";

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

  async provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void> {
    if (target.aws?.instanceId) return;
    const plan = target.runtimeDeployment;
    if (!plan) throw new Error(`Target ${target.id} is missing a resolved runtime deployment`);
    const provisioning = target.aws?.provisioning;
    if (!provisioning) throw new Error(`Target ${target.id} is missing its provider-owned EC2 provisioning configuration`);
    const launchTemplateId = provisioning.launchTemplateId?.trim();
    const launchTemplateName = provisioning.launchTemplateName?.trim();
    if (Boolean(launchTemplateId) === Boolean(launchTemplateName)) {
      throw new Error("EC2 provisioning requires exactly one launch template ID or name");
    }
    const version = provisioning.launchTemplateVersion?.trim() || "$Default";
    const template = await this.ec2.send(new DescribeLaunchTemplateVersionsCommand({
      ...(launchTemplateId ? { LaunchTemplateId: launchTemplateId } : { LaunchTemplateName: launchTemplateName }),
      Versions: [version]
    }));
    if (template.LaunchTemplateVersions?.length !== 1) {
      throw new Error(`EC2 launch template version ${version} was not found exactly once`);
    }
    const encodedUserData = template.LaunchTemplateVersions[0]?.LaunchTemplateData?.UserData;
    if (!encodedUserData) throw new Error("EC2 launch template does not contain user data; refusing to provision without the PreFer boot contract");
    const userData = decodeUserData(encodedUserData);
    const environment = {
      ...(provisioning.deploymentEnvironment ?? {}),
      ...plan.environment,
      AWS_REGION: this.region,
      PREFER_IMAGE: plan.image
    };
    const managedBlock = preferDeploymentBlock(
      environment,
      provisioning.userDataBeginMarker?.trim() || DEFAULT_AWS_EC2_USER_DATA_BEGIN_MARKER,
      provisioning.userDataEndMarker?.trim() || DEFAULT_AWS_EC2_USER_DATA_END_MARKER
    );
    const updatedUserData = replaceMarkedBlock(
      userData,
      provisioning.userDataBeginMarker?.trim() || DEFAULT_AWS_EC2_USER_DATA_BEGIN_MARKER,
      provisioning.userDataEndMarker?.trim() || DEFAULT_AWS_EC2_USER_DATA_END_MARKER,
      managedBlock
    );
    const result = await this.ec2.send(new RunInstancesCommand({
      LaunchTemplate: {
        ...(launchTemplateId ? { LaunchTemplateId: launchTemplateId } : { LaunchTemplateName: launchTemplateName }),
        Version: version
      },
      ...(plan.hardware?.providerSku ? { InstanceType: plan.hardware.providerSku as _InstanceType } : {}),
      UserData: Buffer.from(updatedUserData, "utf8").toString("base64"),
      MinCount: 1,
      MaxCount: 1,
      TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "Name", Value: target.displayName }] }]
    }));
    const instanceIds = (result.Instances ?? []).map((instance) => instance.InstanceId).filter((id): id is string => Boolean(id));
    if (instanceIds.length !== 1) throw new Error("EC2 RunInstances did not return exactly one instance ID");
    return {
      aws: {
        instanceId: instanceIds[0],
        runtimePort: target.aws?.runtimePort,
        runtimeProtocol: target.aws?.runtimeProtocol,
        healthPath: target.aws?.healthPath,
        apiPath: target.aws?.apiPath
      }
    };
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const instanceId = requireInstanceId(target);
    const instance = await this.describeInstance(instanceId);
    if (!instance) throw new Error(`EC2 instance ${instanceId} was not found`);

    const state = instance.State?.Name;
    if (state === "running" || state === "pending" || state === "stopping") return;
    if (state === "shutting-down" || state === "terminated") {
      throw new Error(`EC2 instance ${instanceId} is ${state} and cannot be restarted`);
    }
    if (state !== "stopped") {
      throw new Error(`EC2 instance ${instanceId} cannot be started from state ${state ?? "unknown"}`);
    }
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
    const namePattern = provider.config?.awsEc2?.instanceNamePattern?.trim()
      || DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN;
    const result = await this.ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [namePattern] },
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

function decodeUserData(value: string): string {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!decoded.trim() || decoded.includes("\u0000")) throw new Error("EC2 launch-template user data is not valid text");
  return decoded;
}

function preferDeploymentBlock(environment: Record<string, string>, beginMarker: string, endMarker: string): string[] {
  const lines = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid EC2 deployment environment key: ${key}`);
      if (value.includes("\u0000") || /[\r\n]/u.test(value)) throw new Error(`EC2 deployment environment value ${key} must be one line`);
      return `${key}=${environmentValue(value)}`;
    });
  return [
    beginMarker,
    "umask 077",
    "install -d -m 0755 /opt/prefer",
    "cat > /opt/prefer/deployment.env.tmp <<'NEURON_PREFER_DEPLOYMENT_ENV'",
    ...lines,
    "NEURON_PREFER_DEPLOYMENT_ENV",
    "chmod 0600 /opt/prefer/deployment.env.tmp",
    "mv /opt/prefer/deployment.env.tmp /opt/prefer/deployment.env",
    endMarker
  ];
}

function environmentValue(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, "\\$")
    .replace(/`/gu, "\\`")}"`;
}

function replaceMarkedBlock(source: string, beginMarker: string, endMarker: string, replacement: string[]): string {
  if (!beginMarker || !endMarker || beginMarker === endMarker) throw new Error("EC2 user-data markers must be distinct nonempty lines");
  const lines = source.split(/\r?\n/u);
  const beginIndexes = lines.flatMap((line, index) => line.trim() === beginMarker ? [index] : []);
  const endIndexes = lines.flatMap((line, index) => line.trim() === endMarker ? [index] : []);
  if (beginIndexes.length !== 1 || endIndexes.length !== 1 || beginIndexes[0]! >= endIndexes[0]!) {
    throw new Error(`EC2 launch-template user data must contain exactly one ordered ${beginMarker} / ${endMarker} block`);
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return [...lines.slice(0, beginIndexes[0]), ...replacement, ...lines.slice(endIndexes[0]! + 1)].join(newline);
}
