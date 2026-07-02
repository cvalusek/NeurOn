import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderDefinition, CapacityProviderStatus, CapacityTarget, TargetCostEstimateConfig } from "../domain/types.js";
import { ProviderCatalog } from "../services/ProviderCatalog.js";

export class CompositeCapacityProvider implements CapacityProvider {
  private readonly providerCatalog: ProviderCatalog;

  constructor(
    private readonly providers: Record<string, CapacityProvider>,
    providerCatalog: ProviderCatalog | CapacityProviderDefinition[] = []
  ) {
    this.providerCatalog = Array.isArray(providerCatalog) ? new ProviderCatalog(providerCatalog) : providerCatalog;
  }

  async provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void> {
    const resolved = this.resolve(target);
    if (!resolved.definition.provisioning?.enabled) {
      throw new Error(`Provider ${resolved.definition.id} does not allow resource provisioning`);
    }
    return resolved.provider.provisionTarget(resolved.target);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const resolved = this.resolve(target);
    await resolved.provider.ensureTargetOn(resolved.target);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const resolved = this.resolve(target);
    await resolved.provider.ensureTargetOff(resolved.target);
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const resolved = this.resolve(target);
    return resolved.provider.getTargetStatus(resolved.target);
  }

  async getTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined> {
    const resolved = this.resolve(target);
    return resolved.provider.getTargetCostEstimate?.(resolved.target);
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    const resolved = this.resolve(target);
    await resolved.provider.forceStopTarget(resolved.target);
  }

  private resolve(target: CapacityTarget): { provider: CapacityProvider; target: CapacityTarget; definition: CapacityProviderDefinition } {
    const definition = this.providerCatalog.providerForTarget(target);
    const providerType = adapterKey(definition.type);
    const provider = this.providers[providerType];
    if (!provider) throw new Error(`No capacity provider registered for ${definition.type}`);
    return { provider, target: effectiveTarget(target, definition), definition };
  }
}

function adapterKey(providerType: string): string {
  return providerType === "aws-ecs-asg" ? "aws-ecs" : providerType;
}

function effectiveTarget(target: CapacityTarget, provider: CapacityProviderDefinition): CapacityTarget {
  const next: CapacityTarget = { ...target, provider: provider.type };
  if (provider.type === "aws-ecs-asg") next.provider = "aws-ecs";
  if (provider.type === "runpod" && provider.config?.runpod) {
    next.runpod = {
      ...provider.config.runpod,
      ...(target.runpod ?? {})
    };
  }
  if (provider.type === "neuron" && provider.config?.neuron) {
    next.neuronProvider = provider.config.neuron;
  }
  return next;
}
