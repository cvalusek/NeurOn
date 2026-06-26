import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, RunPodTargetConfig } from "../domain/types.js";

const defaultApiBaseUrl = "https://rest.runpod.io/v1";

export class RunPodCapacityProvider implements CapacityProvider {
  async installTarget(target: CapacityTarget): Promise<void> {
    const runpod = requireRunPod(target);
    if (runpod.podId) return;
    if (!runpod.create) throw new Error(`Target ${target.id} is missing runpod.podId or runpod.create config`);
    const pod = await this.request<RunPodPod>(runpod, "/pods", {
      method: "POST",
      body: JSON.stringify(runpod.create)
    });
    if (!pod.id) throw new Error("RunPod create Pod response did not include an id");
    runpod.podId = pod.id;
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) await this.installTarget(target);
    await this.request(runpod, `/pods/${requiredPodId(target)}/start`, { method: "POST" });
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) return;
    await this.request(runpod, `/pods/${runpod.podId}/stop`, { method: "POST" });
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const runpod = requireRunPod(target);
    if (!runpod.podId) return { observed: "stopped", message: "RunPod Pod is not installed" };
    const pod = await this.request<RunPodPod>(runpod, `/pods/${runpod.podId}`, { method: "GET" });
    const desiredStatus = pod.desiredStatus;
    if (desiredStatus === "RUNNING") return { observed: "healthy", message: "RunPod Pod desired status is RUNNING", details: pod as Record<string, unknown> };
    if (desiredStatus === "EXITED" || desiredStatus === "TERMINATED") {
      return { observed: "stopped", message: `RunPod Pod desired status is ${desiredStatus}`, details: pod as Record<string, unknown> };
    }
    return { observed: "provisioning", message: `RunPod Pod desired status is ${desiredStatus ?? "unknown"}`, details: pod as Record<string, unknown> };
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
      const body = await response.text().catch(() => "");
      throw new Error(`RunPod API returned ${response.status}${body ? `: ${body}` : ""}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

interface RunPodPod {
  id?: string;
  desiredStatus?: "RUNNING" | "EXITED" | "TERMINATED" | string;
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
