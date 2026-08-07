import { describe, expect, it, vi } from "vitest";
import { UpdateChecker } from "../services/UpdateChecker.js";

describe("update checker", () => {
  it("compares the running image revision with the latest successful main image build", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [{ head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] }), { status: 200 }));
    const checker = new UpdateChecker({
      enabled: true,
      repository: "cvalusek/NeurOn",
      currentRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkIntervalSeconds: 900
    }, fetcher as typeof fetch, () => new Date("2026-08-07T12:00:00Z"));

    const status = await checker.check();

    expect(status).toMatchObject({
      currentRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      latestRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      updateAvailable: true,
      checkedAt: "2026-08-07T12:00:00.000Z"
    });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("status=success"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("caches checks for the configured interval and accepts short matching revisions", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [{ head_sha: "abcdef1234567890" }] }), { status: 200 }));
    const checker = new UpdateChecker({
      enabled: true,
      repository: "cvalusek/NeurOn",
      currentRevision: "abcdef1",
      checkIntervalSeconds: 900
    }, fetcher as typeof fetch, () => new Date("2026-08-07T12:00:00Z"));

    expect((await checker.check()).updateAvailable).toBe(false);
    expect((await checker.check()).updateAvailable).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
