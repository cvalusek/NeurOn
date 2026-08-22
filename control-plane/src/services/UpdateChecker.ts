import type { UpdateCheckConfig } from "../domain/types.js";

export interface UpdateStatus {
  enabled: boolean;
  repository: string;
  currentRevision?: string;
  latestRevision?: string;
  updateAvailable?: boolean;
  revisionState?: "current" | "update_available" | "running_ahead" | "diverged" | "unknown";
  checkedAt?: string;
  error?: string;
  compareUrl?: string;
  releaseNotes?: ReleaseNote[];
  releaseNotesError?: string;
}

export interface ReleaseNote {
  title: string;
  details?: string;
  revision?: string;
  url?: string;
  curated: boolean;
}

interface WorkflowRunsResponse {
  workflow_runs?: Array<{ head_sha?: string }>;
}

interface CompareResponse {
  status?: "ahead" | "behind" | "diverged" | "identical";
  ahead_by?: number;
  behind_by?: number;
  html_url?: string;
  commits?: Array<{ sha?: string; html_url?: string; commit?: { message?: string } }>;
  files?: Array<{ filename?: string; status?: string }>;
}

export class UpdateChecker {
  private cached?: UpdateStatus;
  private checkInFlight?: Promise<UpdateStatus>;

  constructor(
    private readonly config: UpdateCheckConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()
  ) {}

  status(): UpdateStatus {
    return this.cached ?? this.baseStatus();
  }

  async check(force = false): Promise<UpdateStatus> {
    if (!this.config.enabled) return this.cache(this.baseStatus());
    const checkedAt = this.cached?.checkedAt ? new Date(this.cached.checkedAt) : undefined;
    if (!force && checkedAt && this.clock().getTime() - checkedAt.getTime() < this.config.checkIntervalSeconds * 1000) return this.cached!;
    this.checkInFlight ??= this.performCheck().finally(() => {
      this.checkInFlight = undefined;
    });
    return this.checkInFlight;
  }

  private async performCheck(): Promise<UpdateStatus> {
    const status = this.baseStatus();
    const checkedAt = this.clock().toISOString();
    try {
      const response = await this.fetcher(
        `${this.repositoryApiUrl()}/actions/workflows/build-control-plane.yml/runs?branch=main&status=success&per_page=1`,
        {
          headers: this.githubHeaders(),
          signal: AbortSignal.timeout(10_000)
        }
      );
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const body = await response.json() as WorkflowRunsResponse;
      const latestRevision = body.workflow_runs?.[0]?.head_sha;
      if (!latestRevision) throw new Error("No successful main image build was found");
      let updateAvailable: boolean | undefined;
      let revisionState: UpdateStatus["revisionState"] = status.currentRevision ? "unknown" : undefined;
      let releaseNotes: ReleaseNote[] | undefined;
      let releaseNotesError: string | undefined;
      let compareUrl: string | undefined;
      if (status.currentRevision && sameRevision(status.currentRevision, latestRevision)) {
        updateAvailable = false;
        revisionState = "current";
      } else if (status.currentRevision) {
        try {
          const comparison = await this.fetchComparison(status.currentRevision, latestRevision);
          revisionState = comparison.revisionState;
          updateAvailable = comparison.revisionState === "update_available";
          releaseNotes = updateAvailable ? comparison.releaseNotes : undefined;
          compareUrl = comparison.compareUrl;
        } catch (error) {
          releaseNotesError = error instanceof Error ? error.message : String(error);
          compareUrl = this.compareWebUrl(status.currentRevision, latestRevision);
        }
      }
      return this.cache({
        ...status,
        latestRevision,
        updateAvailable,
        revisionState,
        checkedAt,
        compareUrl,
        releaseNotes,
        releaseNotesError
      });
    } catch (error) {
      return this.cache({ ...status, checkedAt, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async fetchComparison(currentRevision: string, latestRevision: string): Promise<{ compareUrl?: string; releaseNotes: ReleaseNote[]; revisionState: NonNullable<UpdateStatus["revisionState"]> }> {
    const response = await this.fetcher(
      `${this.repositoryApiUrl()}/compare/${encodeURIComponent(currentRevision)}...${encodeURIComponent(latestRevision)}`,
      { headers: this.githubHeaders(), signal: AbortSignal.timeout(10_000) }
    );
    if (!response.ok) throw new Error(`GitHub comparison returned HTTP ${response.status}`);
    const comparison = await response.json() as CompareResponse;
    const relation = comparison.status ?? ((comparison.commits?.length ?? 0) > 0 ? "ahead" : "identical");
    const revisionState = relation === "ahead"
      ? "update_available"
      : relation === "behind"
        ? "running_ahead"
        : relation === "identical"
          ? "current"
          : "diverged";
    const compareUrl = safeGithubRepositoryUrl(comparison.html_url, this.config.repository)
      ?? this.compareWebUrl(currentRevision, latestRevision);
    if (revisionState !== "update_available") return { compareUrl, releaseNotes: [], revisionState };
    const fragments = (comparison.files ?? []).filter((file) =>
      file.status !== "removed" && /^control-plane\/changes\/[^/]+\.md$/u.test(file.filename ?? "")
    );
    const curated = (await Promise.all(fragments.slice(0, 20).map(async (file) => {
      const noteResponse = await this.fetcher(
        this.repositoryContentsApiUrl(file.filename!, latestRevision),
        { headers: this.githubHeaders("application/vnd.github.raw+json"), signal: AbortSignal.timeout(10_000) }
      );
      if (!noteResponse.ok) throw new Error(`GitHub release note returned HTTP ${noteResponse.status}`);
      return parseReleaseNote(await noteResponse.text());
    }))).filter((note): note is ReleaseNote => Boolean(note));
    if (curated.length > 0) return { compareUrl, releaseNotes: curated, revisionState };

    const commits = (comparison.commits ?? []).map((commit) => ({
      title: firstLine(commit.commit?.message) || "Untitled change",
      revision: commit.sha?.slice(0, 12),
      url: safeGithubRepositoryUrl(commit.html_url, this.config.repository),
      curated: false
    }));
    return { compareUrl, releaseNotes: commits.slice(-30), revisionState };
  }

  private githubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
    return {
      accept,
      "user-agent": "NeurOn-update-checker",
      "x-github-api-version": "2022-11-28",
      ...(this.config.githubToken ? { authorization: `Bearer ${this.config.githubToken}` } : {})
    };
  }

  private repositoryApiUrl(): string {
    return `https://api.github.com/repos/${encodedRepositoryPath(this.config.repository)}`;
  }

  private repositoryContentsApiUrl(filename: string, revision: string): string {
    const encodedFilename = filename.split("/").map(encodeURIComponent).join("/");
    return `${this.repositoryApiUrl()}/contents/${encodedFilename}?ref=${encodeURIComponent(revision)}`;
  }

  private compareWebUrl(currentRevision: string, latestRevision: string): string {
    return `https://github.com/${encodedRepositoryPath(this.config.repository)}/compare/${encodeURIComponent(currentRevision)}...${encodeURIComponent(latestRevision)}`;
  }

  private baseStatus(): UpdateStatus {
    return {
      enabled: this.config.enabled,
      repository: this.config.repository,
      currentRevision: this.config.currentRevision
    };
  }

  private cache(status: UpdateStatus): UpdateStatus {
    this.cached = status;
    return status;
  }
}

function parseReleaseNote(markdown: string): ReleaseNote | undefined {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) return undefined;
  const lines = normalized.split("\n");
  const title = lines[0].replace(/^#\s+/u, "").trim();
  if (!title) return undefined;
  const details = lines.slice(1).join("\n").trim() || undefined;
  return { title, details, curated: true };
}

function firstLine(value: string | undefined): string {
  return value?.split(/\r?\n/u)[0]?.trim() ?? "";
}

function encodedRepositoryPath(repository: string): string {
  const segments = repository.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[a-z0-9_.-]+$/iu.test(segment))) {
    throw new Error("GitHub repository must use the owner/name format");
  }
  return segments.map(encodeURIComponent).join("/");
}

export function safeGithubRepositoryUrl(value: string | undefined, repository: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const expectedPrefix = `/${repository.toLowerCase()}/`;
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port !== "" ||
      !url.pathname.toLowerCase().startsWith(expectedPrefix) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sameRevision(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
