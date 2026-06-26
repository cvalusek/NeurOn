import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

export class CompositeCapacityProvider implements CapacityProvider {
  constructor(private readonly providers: Record<string, CapacityProvider>) {}

  async installTarget(target: CapacityTarget): Promise<void> {
    await this.providerFor(target).installTarget(target);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    await this.providerFor(target).ensureTargetOn(target);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    await this.providerFor(target).ensureTargetOff(target);
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    return this.providerFor(target).getTargetStatus(target);
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.providerFor(target).forceStopTarget(target);
  }

  private providerFor(target: CapacityTarget): CapacityProvider {
    const provider = this.providers[target.provider];
    if (!provider) throw new Error(`No capacity provider registered for ${target.provider}`);
    return provider;
  }
}
