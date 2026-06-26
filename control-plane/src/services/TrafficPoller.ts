import type { TrafficSource } from "../domain/interfaces.js";
import { ModelCatalog } from "./ModelCatalog.js";
import { TrafficKeepaliveService } from "./TrafficKeepaliveService.js";

export class TrafficPoller {
  private running = false;

  constructor(
    private readonly source: TrafficSource,
    private readonly catalog: ModelCatalog,
    private readonly keepalive: TrafficKeepaliveService
  ) {}

  async poll(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.source.pollRecentTraffic(now);
      for (const event of events) {
        const matches = this.resolveTraffic(event.modelId);
        for (const match of matches) {
          await this.keepalive.recordTraffic(match.target, [match.modelId], now);
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(intervalSeconds: number): NodeJS.Timeout {
    void this.poll().catch(() => undefined);
    return setInterval(() => void this.poll().catch(() => undefined), intervalSeconds * 1000);
  }

  private resolveTraffic(modelId: string): Array<{ target: ReturnType<ModelCatalog["listTargets"]>[number]; modelId: string }> {
    const model = this.catalog.getModel(modelId);
    if (model) {
      return this.catalog.targetsForModels([modelId]).map((target) => ({ target, modelId: model.id }));
    }

    const matches: Array<{ target: ReturnType<ModelCatalog["listTargets"]>[number]; modelId: string }> = [];
    for (const target of this.catalog.listTargets()) {
      const prefix = target.trafficModelPrefixes?.find((candidate) => modelId.startsWith(candidate));
      if (!prefix) continue;
      const unprefixedModelId = modelId.slice(prefix.length);
      const unprefixedModel = this.catalog.getModel(unprefixedModelId);
      matches.push({ target, modelId: unprefixedModel?.id ?? modelId });
    }
    return matches;
  }
}
