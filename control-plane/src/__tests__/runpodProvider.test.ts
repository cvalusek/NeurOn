import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPodCapacityProvider } from "../capacity/RunPodCapacityProvider.js";
import type { CapacityTarget } from "../domain/types.js";

const target: CapacityTarget = {
  id: "runpod-test",
  displayName: "RunPod Test",
  provider: "runpod",
  modelIds: [],
  healthCheckUrl: "https://example.test/health",
  runpod: {
    podId: "pod-123",
    apiKey: "secret"
  }
};

describe("RunPodCapacityProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts, stops, and reads Pod status through the RunPod REST API", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        const isGet = init?.method === "GET";
        return {
          ok: true,
          text: async () => (isGet ? JSON.stringify({ id: "pod-123", desiredStatus: "RUNNING" }) : "")
        };
      })
    );

    const provider = new RunPodCapacityProvider();
    await provider.ensureTargetOn(target);
    const status = await provider.getTargetStatus(target);
    await provider.ensureTargetOff(target);

    expect(calls).toEqual([
      { url: "https://rest.runpod.io/v1/pods/pod-123/start", method: "POST" },
      { url: "https://rest.runpod.io/v1/pods/pod-123", method: "GET" },
      { url: "https://rest.runpod.io/v1/pods/pod-123/stop", method: "POST" }
    ]);
    expect(status.observed).toBe("healthy");
  });

  it("creates a Pod when installing an uninstalled target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify({ id: "created-pod" })
      }))
    );
    const installTarget: CapacityTarget = {
      ...target,
      runpod: {
        apiKey: "secret",
        create: {
          name: "prefer",
          imageName: "ghcr.io/cvalusek/prefer:latest"
        }
      }
    };

    await new RunPodCapacityProvider().installTarget(installTarget);

    expect(installTarget.runpod?.podId).toBe("created-pod");
  });
});
