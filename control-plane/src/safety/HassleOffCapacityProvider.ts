import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, TargetCostEstimateConfig } from "../domain/types.js";
import type { HassleOffClient } from "./HassleOffClient.js";

export class HassleOffCapacityProvider implements CapacityProvider {
  constructor(
    private readonly delegate: CapacityProvider,
    private readonly client?: HassleOffClient
  ) {}

  async provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void> {
    await this.requireLease(target);
    return this.delegate.provisionTarget(target);
  }

  async reprovisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget>> {
    await this.requireLease(target);
    if (!this.delegate.reprovisionTarget) throw new Error(`Provider adapter for ${target.id} does not support replacement provisioning`);
    return this.delegate.reprovisionTarget(target);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    await this.requireLease(target);
    await this.delegate.ensureTargetOn(target);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    if (target.hassleOff?.protected && this.client && target.hassleOff.staleTripTestShutdown?.enabled) {
      try {
        if (await this.client.shutdownThroughHassleOffIfTripTestStale(target)) return;
      } catch {
        // A watchdog outage must never prevent NeurOn from directly turning capacity off.
      }
    }
    await this.delegate.ensureTargetOff(target);
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    return this.delegate.getTargetStatus(target);
  }

  async getTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined> {
    return this.delegate.getTargetCostEstimate?.(target);
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.delegate.forceStopTarget(target);
  }

  private async requireLease(target: CapacityTarget): Promise<void> {
    if (!target.hassleOff?.protected) return;
    if (!this.client) {
      throw new Error(
        `HassleOff interlock blocked target ${target.id}: configure HASSLEOFF_URL and HASSLEOFF_CONTROLLER_TOKEN`
      );
    }
    await this.client.acceptExactTargetLease(target);
  }
}
