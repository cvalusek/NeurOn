import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteLlmSpendLogsTrafficSource } from "../litellm/LiteLlmSpendLogsTrafficSource.js";

describe("LiteLlmSpendLogsTrafficSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries spend logs with date-only bounds", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ data: [{ model: "qwen", endTime: "2026-06-26T17:48:00.000Z" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = new LiteLlmSpendLogsTrafficSource("http://litellm.test:4000", "secret", 300);
    await source.pollRecentTraffic(new Date("2026-06-26T17:48:51.000Z"));

    const url = new URL(requestedUrls[0]);
    expect(url.pathname).toBe("/spend/logs/v2");
    expect(url.searchParams.get("start_date")).toBe("2026-06-26");
    expect(url.searchParams.get("end_date")).toBe("2026-06-26");
    expect(requestedUrls).toHaveLength(1);
  });

  it("falls back to legacy spend logs and reads model groups", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      if (requestedUrls.length === 1) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            model: "unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL",
            model_group: "prefer/gemma-4b-e2b",
            endTime: "2026-06-26T17:48:00.000Z"
          }
        ]),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = new LiteLlmSpendLogsTrafficSource("http://litellm.test:4000", "secret", 300);
    const events = await source.pollRecentTraffic(new Date("2026-06-26T17:48:51.000Z"));

    expect(new URL(requestedUrls[0]).pathname).toBe("/spend/logs/v2");
    expect(new URL(requestedUrls[1]).pathname).toBe("/spend/logs");
    expect(events).toEqual([
      { modelId: "prefer/gemma-4b-e2b", seenAt: new Date("2026-06-26T17:48:00.000Z") },
      { modelId: "unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL", seenAt: new Date("2026-06-26T17:48:00.000Z") }
    ]);
  });
});
