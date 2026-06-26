import type { TrafficSource } from "../domain/interfaces.js";

interface LiteLlmSpendLog {
  model?: string | null;
  endTime?: string | null;
  startTime?: string | null;
}

interface SpendLogsResponse {
  data?: LiteLlmSpendLog[];
}

export class LiteLlmSpendLogsTrafficSource implements TrafficSource {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string,
    private readonly lookbackSeconds: number
  ) {}

  async pollRecentTraffic(now = new Date()): Promise<Array<{ modelId: string; seenAt: Date }>> {
    const end = now;
    const start = new Date(now.getTime() - this.lookbackSeconds * 1000);
    const url = new URL("/spend/logs/v2", this.apiBaseUrl);
    url.searchParams.set("start_date", dateOnly(start));
    url.searchParams.set("end_date", dateOnly(end));
    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("sort_by", "endTime");
    url.searchParams.set("sort_order", "desc");

    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`LiteLLM spend logs returned ${response.status}`);
    }

    const body = (await response.json()) as SpendLogsResponse | LiteLlmSpendLog[];
    const logs = Array.isArray(body) ? body : body.data ?? [];
    const recentByModel = new Map<string, Date>();
    for (const log of logs) {
      if (!log.model) continue;
      const seenAt = parseDate(log.endTime ?? log.startTime);
      if (!seenAt || seenAt < start || seenAt > end) continue;
      const existing = recentByModel.get(log.model);
      if (!existing || seenAt > existing) recentByModel.set(log.model, seenAt);
    }
    return Array.from(recentByModel.entries()).map(([modelId, seenAt]) => ({ modelId, seenAt }));
  }
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
