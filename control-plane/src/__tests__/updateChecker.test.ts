import { describe, expect, it, vi } from "vitest";
import { safeGithubRepositoryUrl, UpdateChecker } from "../services/UpdateChecker.js";

describe("update checker", () => {
  it("allows only standard HTTPS links under the configured GitHub repository", () => {
    expect(safeGithubRepositoryUrl("https://github.com/cvalusek/NeurOn/commit/abc", "cvalusek/NeurOn"))
      .toBe("https://github.com/cvalusek/NeurOn/commit/abc");
    expect(safeGithubRepositoryUrl("javascript:alert(1)", "cvalusek/NeurOn")).toBeUndefined();
    expect(safeGithubRepositoryUrl("https://attacker.example/cvalusek/NeurOn/commit/abc", "cvalusek/NeurOn")).toBeUndefined();
    expect(safeGithubRepositoryUrl("https://github.com:444/cvalusek/NeurOn/commit/abc", "cvalusek/NeurOn")).toBeUndefined();
    expect(safeGithubRepositoryUrl("https://github.com/other/NeurOn/commit/abc", "cvalusek/NeurOn")).toBeUndefined();
  });

  it("compares the running image revision with the latest successful main image build", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/compare/")
      ? new Response(JSON.stringify({ html_url: "https://github.com/cvalusek/NeurOn/compare/a...b", commits: [{ sha: "bbbbbbbbbbbb", html_url: "https://github.com/cvalusek/NeurOn/commit/b", commit: { message: "Improve reservations\n\nDetails" } }], files: [] }), { status: 200 })
      : new Response(JSON.stringify({ workflow_runs: [{ head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] }), { status: 200 }));
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
      checkedAt: "2026-08-07T12:00:00.000Z",
      compareUrl: "https://github.com/cvalusek/NeurOn/compare/a...b",
      releaseNotes: [{ title: "Improve reservations", revision: "bbbbbbbbbbbb", curated: false }]
    });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("status=success"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("prefers curated change fragments without exposing the token in notes", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("actions/workflows")) return new Response(JSON.stringify({ workflow_runs: [{ head_sha: "new-sha" }] }), { status: 200 });
      if (url.includes("/compare/")) return new Response(JSON.stringify({
        html_url: "https://github.com/cvalusek/NeurOn/compare/old...new",
        commits: [{ commit: { message: "Internal implementation detail" } }],
        files: [{
          filename: "control-plane/changes/friendlier-reservations.md",
          status: "added",
          raw_url: "https://attacker.example/collect-token"
        }]
      }), { status: 200 });
      expect(url).toBe("https://api.github.com/repos/cvalusek/NeurOn/contents/control-plane/changes/friendlier-reservations.md?ref=new-sha");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.raw+json");
      return new Response("# Friendlier reservations\n\nProfiles can span targets and Home manages every active reservation.", { status: 200 });
    });
    const checker = new UpdateChecker({
      enabled: true,
      repository: "cvalusek/NeurOn",
      currentRevision: "old-sha",
      checkIntervalSeconds: 900,
      githubToken: "private-token"
    }, fetcher as typeof fetch);

    const status = await checker.check();

    expect(status.releaseNotes).toEqual([{
      title: "Friendlier reservations",
      details: "Profiles can span targets and Home manages every active reservation.",
      curated: true
    }]);
    expect(JSON.stringify(status)).not.toContain("private-token");
    expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain("https://attacker.example/collect-token");
  });

  it("drops untrusted and non-HTTPS comparison links", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/compare/")
      ? new Response(JSON.stringify({
          html_url: "javascript:alert(document.cookie)",
          commits: [
            { sha: "new-sha", html_url: "https://attacker.example/commit/new-sha", commit: { message: "Safe title" } },
            { sha: "newer-sha", html_url: "https://github.com/another/repository/commit/newer-sha", commit: { message: "Other repository" } }
          ],
          files: []
        }), { status: 200 })
      : new Response(JSON.stringify({ workflow_runs: [{ head_sha: "new-sha" }] }), { status: 200 }));
    const checker = new UpdateChecker({
      enabled: true,
      repository: "cvalusek/NeurOn",
      currentRevision: "old-sha",
      checkIntervalSeconds: 900
    }, fetcher as typeof fetch);

    const status = await checker.check();

    expect(status.compareUrl).toBe("https://github.com/cvalusek/NeurOn/compare/old-sha...new-sha");
    expect(status.releaseNotes).toEqual([
      { title: "Safe title", revision: "new-sha", url: undefined, curated: false },
      { title: "Other repository", revision: "newer-sha", url: undefined, curated: false }
    ]);
    expect(JSON.stringify(status)).not.toContain("javascript:");
    expect(JSON.stringify(status)).not.toContain("attacker.example");
    expect(JSON.stringify(status)).not.toContain("another/repository");
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

  it("does not advertise an update or fetch reverse patch notes while CI is behind the running revision", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/compare/")
      ? new Response(JSON.stringify({
          status: "behind",
          ahead_by: 0,
          behind_by: 2,
          html_url: "https://github.com/cvalusek/NeurOn/compare/running...built",
          commits: [],
          files: [{ filename: "control-plane/changes/old-change.md", status: "modified" }]
        }), { status: 200 })
      : new Response(JSON.stringify({ workflow_runs: [{ head_sha: "built-revision" }] }), { status: 200 }));
    const checker = new UpdateChecker({
      enabled: true,
      repository: "cvalusek/NeurOn",
      currentRevision: "running-revision",
      checkIntervalSeconds: 900
    }, fetcher as typeof fetch);

    const status = await checker.check();

    expect(status).toMatchObject({ updateAvailable: false, revisionState: "running_ahead", releaseNotes: undefined });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/contents/"))).toBe(false);
  });
});
