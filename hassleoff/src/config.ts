import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HassleOffConfig } from "./types.js";

const targetSchema = z.object({
  targetId: z.string().min(1),
  registrationId: z.string().min(1),
  displayName: z.string().optional(),
  testOnly: z.boolean().optional(),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("fake") }),
    z.object({
      type: z.literal("runpod-stop"),
      podId: z.string().min(1),
      apiBaseUrl: z.string().url().optional(),
      credentialId: z.string().min(1).optional(),
      apiKeyEnv: z.string().min(1).optional()
    })
  ])
}).superRefine((target, context) => {
  if (target.action.type === "runpod-stop" && target.action.credentialId && target.action.apiKeyEnv) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action"],
      message: "RunPod actions must set only one of credentialId or apiKeyEnv"
    });
  }
  if (target.action.type === "runpod-stop" && target.action.apiBaseUrl && new URL(target.action.apiBaseUrl).protocol !== "https:") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action", "apiBaseUrl"],
      message: "RunPod action apiBaseUrl must use HTTPS"
    });
  }
});

export function loadHassleOffConfig(): HassleOffConfig {
  const controllerToken = requiredEnv("HASSLEOFF_CONTROLLER_TOKEN");
  if (controllerToken.length < 16) throw new Error("HASSLEOFF_CONTROLLER_TOKEN must contain at least 16 characters");
  const targetsRaw = loadTargetsJson();
  const targets = z.array(targetSchema).min(1).parse(JSON.parse(targetsRaw));
  const uniqueTargets = new Set(targets.map((target) => target.targetId));
  if (uniqueTargets.size !== targets.length) throw new Error("HassleOff target registrations contain duplicate targetId values");
  return {
    port: intEnv("PORT", 8091),
    controllerToken,
    databasePath: process.env.HASSLEOFF_SQLITE_PATH?.trim() || path.resolve(process.cwd(), "data", "hassleoff.db"),
    targets,
    checkIntervalMs: intEnv("HASSLEOFF_CHECK_INTERVAL_MS", 5_000),
    maxClockSkewMs: intEnv("HASSLEOFF_MAX_CLOCK_SKEW_MS", 10_000),
    minLeaseMs: intEnv("HASSLEOFF_MIN_LEASE_MS", 15_000),
    maxLeaseMs: intEnv("HASSLEOFF_MAX_LEASE_MS", 300_000),
    maxMaintenanceHoldMs: intEnv("HASSLEOFF_MAX_MAINTENANCE_HOLD_MS", 3_600_000),
    failedActionRetryMs: intEnv("HASSLEOFF_FAILED_ACTION_RETRY_MS", 15_000),
    allowInsecureHttp: boolEnv("HASSLEOFF_ALLOW_INSECURE_HTTP", false),
    trustProxy: boolEnv("HASSLEOFF_TRUST_PROXY", false)
  };
}

function loadTargetsJson(): string {
  const inline = process.env.HASSLEOFF_TARGETS_JSON?.trim();
  const file = process.env.HASSLEOFF_TARGETS_FILE?.trim();
  if (inline && file) throw new Error("Set only one of HASSLEOFF_TARGETS_JSON or HASSLEOFF_TARGETS_FILE");
  if (inline) return inline;
  if (file) return readFileSync(file, "utf8");
  throw new Error("HASSLEOFF_TARGETS_JSON or HASSLEOFF_TARGETS_FILE is required");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
