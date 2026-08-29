import type { RegisteredTarget, StopActionContext, StopActionExecutor, StopActionResult } from "./types.js";
import { InMemoryProviderCredentials } from "./credentials.js";

const defaultRunPodApiBaseUrl = "https://rest.runpod.io/v1";

export class RegisteredStopActionExecutor implements StopActionExecutor {
  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly credentials = new InMemoryProviderCredentials()
  ) {}

  credentialStatus(target: RegisteredTarget): { required: boolean; available: boolean; credentialId?: string } {
    if (target.action.type === "fake") return { required: false, available: true };
    if (target.action.credentialId) {
      return {
        required: true,
        available: this.credentials.has(target.action.credentialId),
        credentialId: target.action.credentialId
      };
    }
    const apiKeyEnv = target.action.apiKeyEnv ?? "RUNPOD_API_KEY";
    return { required: true, available: Boolean(process.env[apiKeyEnv]) };
  }

  async stop(target: RegisteredTarget, _context: StopActionContext): Promise<StopActionResult> {
    if (target.action.type === "fake") {
      return { message: `Synthetic stop completed for ${target.targetId}` };
    }
    const apiKey = target.action.credentialId
      ? this.credentials.get(target.action.credentialId)
      : process.env[target.action.apiKeyEnv ?? "RUNPOD_API_KEY"];
    if (!apiKey) throw new Error("RunPod stop credential is unavailable");
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
