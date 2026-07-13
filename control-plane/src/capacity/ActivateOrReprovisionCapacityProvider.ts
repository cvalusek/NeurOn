import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, TargetCostEstimateConfig } from "../domain/types.js";
import { RecoverableTargetUnavailableError } from "./RecoverableTargetUnavailableError.js";

export interface ReplacementTargetPatchSink {
  canPersistReplacement(targetId: string): Promise<boolean>;
  applyReplacementPatch(targetId: string, patch: Partial<CapacityTarget>): Promise<CapacityTarget | undefined>;
}

export class ActivateOrReprovisionCapacityProvider implements CapacityProvider {
  constructor(
    private readonly delegate: CapacityProvider,
    private readonly patchSink: ReplacementTargetPatchSink
  ) {}

  async provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void> {
    return this.delegate.provisionTarget(target);
  }

  async reprovisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget>> {
    if (!this.delegate.reprovisionTarget) throw new Error(`Provider adapter for ${target.id} does not support replacement provisioning`);
    return this.delegate.reprovisionTarget(target);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    try {
      await this.delegate.ensureTargetOn(target);
      return;
    } catch (error) {
      if (!(error instanceof RecoverableTargetUnavailableError)) throw error;
      if (!target.activationPolicy?.reprovisionOnRecoverableUnavailable) throw error;
      if (!this.delegate.reprovisionTarget) {
        throw new Error(`Target ${target.id} allows replacement, but its provider adapter does not implement reprovisionTarget`, { cause: error });
      }
      if (!(await this.patchSink.canPersistReplacement(target.id))) {
        throw new Error(`Target ${target.id} cannot be replacement-provisioned until its provider binding is stored durably`, { cause: error });
      }
      const patch = await this.delegate.reprovisionTarget(target);
      if (!patch || Object.keys(patch).length === 0) {
        throw new Error(`Replacement provisioning for ${target.id} did not return a target binding patch`, { cause: error });
      }
      const replacement = await this.patchSink.applyReplacementPatch(target.id, patch);
      if (!replacement) throw new Error(`Replacement target patch could not be applied for ${target.id}`, { cause: error });
      await this.delegate.ensureTargetOn(replacement);
    }
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
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
}
