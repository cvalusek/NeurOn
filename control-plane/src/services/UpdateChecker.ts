import type { UpdateCheckConfig } from "../domain/types.js";

export interface UpdateStatus {
  enabled: boolean;
  repository: string;
  currentRevision?: string;
  latestRevision?: string;
  updateAvailable?: boolean;
  checkedAt?: string;
  error?: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: Array<{ head_sha?: string }>;
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
        `https://api.github.com/repos/${this.config.repository}/actions/workflows/build-control-plane.yml/runs?branch=main&status=success&per_page=1`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "NeurOn-update-checker",
            "x-github-api-version": "2022-11-28",
            ...(this.config.githubToken ? { authorization: `Bearer ${this.config.githubToken}` } : {})
          },
          signal: AbortSignal.timeout(10_000)
        }
      );
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const body = await response.json() as WorkflowRunsResponse;
      const latestRevision = body.workflow_runs?.[0]?.head_sha;
      if (!latestRevision) throw new Error("No successful main image build was found");
      return this.cache({
        ...status,
        latestRevision,
        updateAvailable: status.currentRevision ? !sameRevision(status.currentRevision, latestRevision) : undefined,
        checkedAt
      });
    } catch (error) {
      return this.cache({ ...status, checkedAt, error: error instanceof Error ? error.message : String(error) });
    }
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

function sameRevision(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
