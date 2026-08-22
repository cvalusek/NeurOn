import type { TrafficSource } from "../domain/interfaces.js";

interface LiteLlmSpendLog {
  request_id?: string | null;
  model?: string | null;
  model_group?: string | null;
  endTime?: string | null;
  startTime?: string | null;
  completionStartTime?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cache_hit?: string | boolean | null;
  status?: string | null;
  /** Stable LiteLLM user identifier attached to the virtual key/request. */
  user?: string | null;
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

  async pollRecentTraffic(now = new Date()): ReturnType<TrafficSource["pollRecentTraffic"]> {
    const end = now;
    const start = new Date(now.getTime() - this.lookbackSeconds * 1000);
    const logs = await this.fetchRecentLogs(start, end);
    const events: Array<{
      modelId: string;
      seenAt: Date;
      requestId?: string;
      performance?: {
        decodeTokensPerSecond?: number;
        prefillTokensPerSecond?: number;
        timeToFirstTokenSeconds?: number;
      };
      externalUserSubject?: string;
    }> = [];
    for (const log of logs) {
      const seenAt = parseDate(log.endTime ?? log.startTime);
      if (!seenAt || seenAt < start || seenAt > end) continue;
      const performance = performanceForLog(log);
      for (const [index, modelId] of modelIdsForLog(log).entries()) {
        events.push({
          modelId,
          seenAt,
          ...(externalUserSubject(log) ? { externalUserSubject: externalUserSubject(log) } : {}),
          ...(index === 0 && performance && log.request_id ? { requestId: log.request_id, performance } : {})
        });
      }
    }
    return dedupeTrafficEvents(events);
  }

  private async fetchRecentLogs(start: Date, end: Date): Promise<LiteLlmSpendLog[]> {
    const v2Logs = await this.fetchJson(spendLogsV2Url(this.apiBaseUrl, start, end));
    const v2List = logsFromResponse(v2Logs);
    if (v2List.length > 0) return v2List;
    return logsFromResponse(await this.fetchJson(spendLogsLegacyUrl(this.apiBaseUrl, start, end)));
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
  url.searchParams.set("start_date", utcDateOnly(start));
  url.searchParams.set("end_date", nextUtcDateOnly(end));
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("sort_by", "endTime");
  url.searchParams.set("sort_order", "desc");
  return url;
}

function spendLogsLegacyUrl(apiBaseUrl: string, start: Date, end: Date): URL {
  const url = new URL("/spend/logs", apiBaseUrl);
  url.searchParams.set("start_date", utcDateOnly(start));
  url.searchParams.set("end_date", nextUtcDateOnly(end));
  url.searchParams.set("summarize", "false");
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

function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function externalUserSubject(log: LiteLlmSpendLog): string | undefined {
  const value = log.user?.trim();
  return value && value.length <= 500 ? value : undefined;
}

function performanceForLog(log: LiteLlmSpendLog): {
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
} | undefined {
  if (isCacheHit(log.cache_hit) || /(?:error|fail)/iu.test(log.status ?? "")) return undefined;
  const start = parseDate(log.startTime);
  const completionStart = parseDate(log.completionStartTime);
  const end = parseDate(log.endTime);
  if (!start || !completionStart || !end || completionStart < start || end < completionStart) return undefined;
  const timeToFirstTokenSeconds = (completionStart.getTime() - start.getTime()) / 1000;
  const decodeSeconds = (end.getTime() - completionStart.getTime()) / 1000;
  const decodeTokensPerSecond = positiveRate(log.completion_tokens, decodeSeconds);
  const prefillTokensPerSecond = positiveRate(log.prompt_tokens, timeToFirstTokenSeconds);
  if (!decodeTokensPerSecond && !prefillTokensPerSecond && timeToFirstTokenSeconds <= 0) return undefined;
  return {
    decodeTokensPerSecond,
    prefillTokensPerSecond,
    timeToFirstTokenSeconds: timeToFirstTokenSeconds > 0 ? timeToFirstTokenSeconds : undefined
  };
}

function positiveRate(tokens: number | null | undefined, seconds: number): number | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return tokens / seconds;
}

function isCacheHit(value: LiteLlmSpendLog["cache_hit"]): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "hit"].includes(value.trim().toLowerCase());
}

function dedupeTrafficEvents<T extends { modelId: string; seenAt: Date; requestId?: string; externalUserSubject?: string; performance?: unknown }>(events: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const event of events) {
    const key = `${event.requestId ?? "traffic"}\0${event.modelId}\0${event.externalUserSubject ?? "anonymous"}\0${event.seenAt.toISOString()}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.performance && event.performance)) byKey.set(key, event);
  }
  return Array.from(byKey.values());
}

function nextUtcDateOnly(date: Date): string {
  const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  return utcDateOnly(next);
}
