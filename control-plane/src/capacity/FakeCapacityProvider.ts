import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

export class FakeCapacityProvider implements CapacityProvider {
  readonly desired = new Map<string, "on" | "off">();
  readonly statuses = new Map<string, CapacityProviderStatus>();

  async installTarget(target: CapacityTarget): Promise<void> {
    if (!this.statuses.has(target.id)) this.statuses.set(target.id, { observed: "stopped", message: "Installed fake target" });
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    this.desired.set(target.id, "on");
    if (!this.statuses.has(target.id)) this.statuses.set(target.id, { observed: "provisioning", message: "Provisioning" });
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    this.desired.set(target.id, "off");
    if (!this.statuses.has(target.id)) this.statuses.set(target.id, { observed: "stopped", message: "Stopped" });
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    return this.statuses.get(target.id) ?? { observed: this.desired.get(target.id) === "on" ? "provisioning" : "stopped", message: "Local fake status" };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    this.desired.set(target.id, "off");
    this.statuses.set(target.id, { observed: "stopped", message: "Force stopped" });
  }
}
