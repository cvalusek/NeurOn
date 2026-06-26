import type { TrafficSource } from "../domain/interfaces.js";

interface LiteLlmSpendLog {
  model?: string | null;
  model_group?: string | null;
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
    const logs = await this.fetchRecentLogs(start, end);
    const recentByModel = new Map<string, Date>();
    for (const log of logs) {
      const seenAt = parseDate(log.endTime ?? log.startTime);
      if (!seenAt || seenAt < start || seenAt > end) continue;
      for (const modelId of modelIdsForLog(log)) {
        const existing = recentByModel.get(modelId);
        if (!existing || seenAt > existing) recentByModel.set(modelId, seenAt);
      }
    }
    return Array.from(recentByModel.entries()).map(([modelId, seenAt]) => ({ modelId, seenAt }));
  }

  private async fetchRecentLogs(start: Date, end: Date): Promise<LiteLlmSpendLog[]> {
    const v2Logs = await this.fetchJson(spendLogsV2Url(this.apiBaseUrl, start, end));
    const v2List = logsFromResponse(v2Logs);
    if (v2List.length > 0) return v2List;
    return logsFromResponse(await this.fetchJson(new URL("/spend/logs", this.apiBaseUrl)));
  }

  private async fetchJson(url: URL): Promise<SpendLogsResponse | LiteLlmSpendLog[]> {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`LiteLLM spend logs returned ${response.status}`);
    }
    return (await response.json()) as SpendLogsResponse | LiteLlmSpendLog[];
  }
}

function spendLogsV2Url(apiBaseUrl: string, start: Date, end: Date): URL {
  const url = new URL("/spend/logs/v2", apiBaseUrl);
  url.searchParams.set("start_date", dateOnly(start));
  url.searchParams.set("end_date", dateOnly(end));
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("sort_by", "endTime");
  url.searchParams.set("sort_order", "desc");
  return url;
}

function logsFromResponse(body: SpendLogsResponse | LiteLlmSpendLog[]): LiteLlmSpendLog[] {
  return Array.isArray(body) ? body : body.data ?? [];
}

function modelIdsForLog(log: LiteLlmSpendLog): string[] {
  return Array.from(new Set([log.model_group, log.model].filter((model): model is string => Boolean(model))));
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
