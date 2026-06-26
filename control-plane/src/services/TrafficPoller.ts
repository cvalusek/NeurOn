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
        const model = this.catalog.getModel(event.modelId);
        if (!model) continue;
        for (const target of this.catalog.targetsForModels([event.modelId])) {
          await this.keepalive.recordTraffic(target, [model.id], now);
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
}
