import type { TrafficSource } from "../domain/interfaces.js";
import { ModelCatalog } from "./ModelCatalog.js";
import { TrafficKeepaliveService } from "./TrafficKeepaliveService.js";
import { litellmRoutePrefixes } from "../litellm/modelRouting.js";
import type { ModelSelectionService } from "./ModelSelectionService.js";

export class TrafficPoller {
  private running = false;
  private stopped = false;
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly source: TrafficSource,
    private readonly catalog: ModelCatalog,
    private readonly keepalive: TrafficKeepaliveService,
    private readonly modelSelection?: ModelSelectionService
  ) {}

  async poll(now = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const events = await this.source.pollRecentTraffic(now);
      const latestTraffic = new Map<
        string,
        { match: ReturnType<TrafficPoller["resolveTraffic"]>[number]; seenAt: Date }
      >();
      for (const event of events) {
        if (this.stopped) return;
        const matches = this.resolveTraffic(event.modelId);
        if (event.performance && matches.length === 1) {
          this.modelSelection?.recordObservation(matches[0].target.id, matches[0].modelId, {
            requestId: event.requestId,
            seenAt: event.seenAt,
            ...event.performance
          });
        }
        for (const match of matches) {
          const key = `${match.target.id}\u0000${match.modelId}`;
          const current = latestTraffic.get(key);
          if (!current || current.seenAt.getTime() < event.seenAt.getTime()) {
            latestTraffic.set(key, { match, seenAt: event.seenAt });
          }
        }
      }
      for (const { match, seenAt } of latestTraffic.values()) {
        if (this.stopped) return;
        await this.keepalive.recordTraffic(match.target, [match.modelId], seenAt, now);
      }
    } finally {
      this.running = false;
    }
  }

  start(intervalSeconds: number): NodeJS.Timeout {
    this.stop();
    this.stopped = false;
    void this.poll().catch(() => undefined);
    this.interval = setInterval(() => void this.poll().catch(() => undefined), intervalSeconds * 1000);
    this.interval.unref();
    return this.interval;
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private resolveTraffic(modelId: string): Array<{ target: ReturnType<ModelCatalog["listTargets"]>[number]; modelId: string }> {
    const model = this.catalog.getModel(modelId);
    if (model) {
      return this.catalog.targetsForModels([modelId]).map((target) => ({ target, modelId: model.id }));
    }

    const matches: Array<{ target: ReturnType<ModelCatalog["listTargets"]>[number]; modelId: string }> = [];
    for (const target of this.catalog.listTargets()) {
      const prefix = litellmRoutePrefixes(target).find((candidate) => modelId.startsWith(candidate));
      if (!prefix) continue;
      const unprefixedModelId = modelId.slice(prefix.length);
      const unprefixedModel = this.catalog.getModel(unprefixedModelId);
      matches.push({ target, modelId: unprefixedModel?.id ?? modelId });
    }
    return matches;
  }
}
