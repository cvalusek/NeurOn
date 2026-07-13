import type { RegisteredTarget, StopActionContext, StopActionExecutor, StopActionResult } from "./types.js";

const defaultRunPodApiBaseUrl = "https://rest.runpod.io/v1";

export class RegisteredStopActionExecutor implements StopActionExecutor {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async stop(target: RegisteredTarget, _context: StopActionContext): Promise<StopActionResult> {
    if (target.action.type === "fake") {
      return { message: `Synthetic stop completed for ${target.targetId}` };
    }
    const apiKeyEnv = target.action.apiKeyEnv ?? "RUNPOD_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`RunPod stop credential is unavailable in ${apiKeyEnv}`);
    const baseUrl = (target.action.apiBaseUrl ?? defaultRunPodApiBaseUrl).replace(/\/$/, "");
    const response = await this.fetchImplementation(`${baseUrl}/pods/${encodeURIComponent(target.action.podId)}/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    if (!response.ok) {
      // Provider response bodies are deliberately excluded because this message is
      // persisted in the audit trail and exposed by the status API.
      throw new Error(`RunPod stop returned HTTP ${response.status}`);
    }
    return { message: `RunPod stop accepted for registered Pod ${target.action.podId}` };
  }
}
