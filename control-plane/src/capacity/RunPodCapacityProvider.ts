import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, RunPodTargetConfig, TargetCostEstimateConfig } from "../domain/types.js";

const defaultApiBaseUrl = "https://rest.runpod.io/v1";

export class RunPodCapacityProvider implements CapacityProvider {
  async provisionTarget(target: CapacityTarget): Promise<Partial<CapacityTarget> | void> {
    const runpod = requireRunPod(target);
    if (runpod.podId) return;
    if (!runpod.create) throw new Error(`Target ${target.id} is missing runpod.podId or runpod.create config`);
    const pod = await this.request<RunPodPod>(runpod, "/pods", {
      method: "POST",
      body: JSON.stringify(runpod.create)
    });
    if (!pod.id) throw new Error("RunPod create Pod response did not include an id");
    return { runpod: { ...runpod, podId: pod.id } };
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) throw new Error(`Target ${target.id} is missing runpod.podId; provision the resource explicitly first`);
    await this.request(runpod, `/pods/${requiredPodId(target)}/start`, { method: "POST" });
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) return;
    await this.request(runpod, `/pods/${runpod.podId}/stop`, { method: "POST" });
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) return { observed: "stopped", message: "RunPod Pod is not provisioned" };
    const pod = await this.request<RunPodPod>(runpod, `/pods/${runpod.podId}`, { method: "GET" });
    const desiredStatus = pod.desiredStatus;
    const runtime = runPodRuntime(target, pod.id ?? runpod.podId);
    if (desiredStatus === "RUNNING") return { observed: "healthy", message: "RunPod Pod desired status is RUNNING", details: pod as Record<string, unknown>, runtime };
    if (desiredStatus === "EXITED" || desiredStatus === "TERMINATED") {
      return { observed: "stopped", message: `RunPod Pod desired status is ${desiredStatus}`, details: pod as Record<string, unknown> };
    }
    return { observed: "starting", message: `RunPod Pod desired status is ${desiredStatus ?? "unknown"}`, details: pod as Record<string, unknown>, runtime };
  }

  async getTargetCostEstimate(target: CapacityTarget): Promise<TargetCostEstimateConfig | undefined> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) return undefined;
    const pod = await this.request<RunPodPod>(runpod, `/pods/${runpod.podId}`, { method: "GET" });
    const hourlyUsd = hourlyCostFromPod(pod);
    return hourlyUsd === undefined ? undefined : { hourlyUsd };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }

  private async request<T = unknown>(runpod: RunPodTargetConfig, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${(runpod.apiBaseUrl ?? defaultApiBaseUrl).replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey(runpod)}`,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new Error(`RunPod API returned ${response.status}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

interface RunPodPod {
  id?: string;
  desiredStatus?: "RUNNING" | "EXITED" | "TERMINATED" | string;
  adjustedCostPerHr?: number | string;
  costPerHr?: number | string;
  machine?: {
    costPerHr?: number | string;
  };
}

function requireRunPod(target: CapacityTarget): RunPodTargetConfig {
  if (!target.runpod) throw new Error(`Target ${target.id} is missing runpod config`);
  return target.runpod;
}

function requiredPodId(target: CapacityTarget): string {
  const podId = target.runpod?.podId;
  if (!podId) throw new Error(`Target ${target.id} is missing runpod.podId`);
  return podId;
}

function apiKey(runpod: RunPodTargetConfig): string {
  const value = runpod.apiKey ?? process.env[runpod.apiKeyEnv ?? "RUNPOD_API_KEY"];
  if (!value) throw new Error(`RunPod API key is required; set ${runpod.apiKeyEnv ?? "RUNPOD_API_KEY"} or runpod.apiKey`);
  return value;
}

function hourlyCostFromPod(pod: RunPodPod): number | undefined {
  return firstPositiveNumber(pod.adjustedCostPerHr, pod.costPerHr, pod.machine?.costPerHr);
}

function runPodRuntime(target: CapacityTarget, podId: string): CapacityProviderStatus["runtime"] {
  const port = target.runpod?.runtimePort ?? target.runtimeDeployment?.port ?? 8080;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(podId) || `${podId}-${port}`.length > 63) return undefined;
  const origin = `https://${podId}-${port}.proxy.runpod.net`;
  return {
    apiUrl: `${origin}${normalizedPath(target.runtimeDeployment?.apiPath, "/v1")}`,
    healthUrl: `${origin}${normalizedPath(target.runtimeDeployment?.healthPath, "/health")}`
  };
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return selected.startsWith("/") ? selected : `/${selected}`;
}

function firstPositiveNumber(...values: Array<number | string | undefined>): number | undefined {
  for (const value of values) {
    if (value === undefined || value === "") continue;
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return undefined;
}
