import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteLlmSpendLogsTrafficSource } from "../litellm/LiteLlmSpendLogsTrafficSource.js";

describe("LiteLlmSpendLogsTrafficSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries spend logs with date-only bounds", async () => {
    let requestedUrl = "";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = new LiteLlmSpendLogsTrafficSource("http://litellm.test:4000", "secret", 300);
    await source.pollRecentTraffic(new Date("2026-06-26T17:48:51.000Z"));

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/spend/logs/v2");
    expect(url.searchParams.get("start_date")).toBe("2026-06-26");
    expect(url.searchParams.get("end_date")).toBe("2026-06-26");
  });
});
