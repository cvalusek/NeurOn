import type { CapacityTarget } from "../domain/types.js";

export interface HealthCheckResult {
  ok: boolean;
  message: string;
}

export class HealthChecker {
  constructor(private readonly timeoutSeconds: number) {}

  async check(target: CapacityTarget): Promise<HealthCheckResult> {
    if (!target.healthUrl) return { ok: true, message: "Provider reported ready" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const response = await fetch(target.healthUrl, { signal: controller.signal });
      return {
        ok: response.ok,
        message: response.ok ? "Ready" : `Health check returned ${response.status}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Health check failed: ${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
