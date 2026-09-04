// ── Config ────────────────────────────────────────────────
// Harness-agnostic NeurOn config loading + provider gating.
// No timers, no process state, no harness awareness: the env object is
// injected (defaulting to process.env), the allowed-provider skip logger is
// a parameter so each adapter keeps its own log routing, and the optional
// harnessLabel names the calling harness in user-facing error strings
// (default "OpenCode" keeps the reference plugin's output byte-identical;
// the Codex and pi adapters pass their own label).

export const DEFAULT_POLL_S = 5;
export const DEFAULT_DURATION_MINUTES = 2;
export const DEFAULT_WAIT_TIMEOUT_S = 600;
export const DEFAULT_HARNESS_LABEL = "OpenCode";

// The harness label for a loaded config; falls back to the reference label
// so configs built without a label (e.g. in tests) keep the original wording.
export function harnessLabelOf(config) {
  return config?.harnessLabel || DEFAULT_HARNESS_LABEL;
}

export function loadConfig(env = process.env, harnessLabel = DEFAULT_HARNESS_LABEL) {
  const raw = env.NEURON_ALLOWED_PROVIDERS;
  const allowedProviders = raw
    ? raw.split(",").map((p) => p.trim()).filter(Boolean)
    : [];
  const baseUrl = env.NEURON_API_BASE_URL || "http://localhost:8090";
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))
    throw new Error("NEURON_API_BASE_URL must be a valid http:// or https:// URL");
  return {
    apiBaseUrl: trimSlash(baseUrl),
    apiKey: env.NEURON_API_KEY,
    durationMinutes: positiveNumber(
      env.NEURON_RESERVATION_DURATION_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    keepaliveMinutes: positiveNumber(
      env.NEURON_RESERVATION_KEEPALIVE_MINUTES,
      DEFAULT_DURATION_MINUTES
    ),
    waitForHealthy: boolEnv(env.NEURON_WAIT_FOR_HEALTHY, true),
    waitTimeoutMs: positiveNumber(env.NEURON_WAIT_TIMEOUT_SECONDS, DEFAULT_WAIT_TIMEOUT_S) * 1000,
    pollMs: positiveNumber(env.NEURON_WAIT_POLL_SECONDS, DEFAULT_POLL_S) * 1000,
    requestTimeoutMs: positiveNumber(env.NEURON_REQUEST_TIMEOUT_MS, 8000),
    preflightTimeoutMs: positiveNumber(env.NEURON_PREFLIGHT_TIMEOUT_MS, 2000),
    cooldownPeriodMs: positiveNumber(env.NEURON_COOLDOWN_PERIOD_MS, 30000),
    retryMaxAttempts: positiveNumber(env.NEURON_RETRY_MAX_ATTEMPTS, 3),
    retryBaseMs: positiveNumber(env.NEURON_RETRY_BASE_MS, 1000),
    retryMaxMs: positiveNumber(env.NEURON_RETRY_MAX_MS, 8000),
    blockOnColdMessage: boolEnv(env.NEURON_BLOCK_ON_COLD_MESSAGE, false),
    bypassMessageHook: boolEnv(env.NEURON_BYPASS_MESSAGE_HOOK, false),
    strictProviderMatch: boolEnv(env.NEURON_STRICT_PROVIDER_MATCH, false),
    warmupLockTimeoutMs: positiveNumber(env.NEURON_WARMUP_LOCK_TIMEOUT_MS, 60000),
    // Pin the authenticated username for lease/adoption scoping. Without it
    // the harness discovers the username lazily via GET /api/me (cached on
    // the injected state). Useful for tests and for operators who know their
    // username in advance.
    username: env.NEURON_USERNAME || undefined,
    allowedProviders,
    harnessLabel
  };
}

// ── Model / provider helpers ──────────────────────────────

export function matchesAllowedProvider(providerId, modelId, allowedProviders, log = () => {}) {
  if (!allowedProviders.length) return true;
  if (providerId) {
    for (const p of allowedProviders)
      if (providerId.toLowerCase() === p.toLowerCase()) return true;
    log(`allowed-provider skip: provider=${providerId} model=${modelId} allowed=${allowedProviders.join(",")}`);
    return false;
  }
  for (const p of allowedProviders)
    if (modelId.startsWith(p + "/")) return true;
  log(`allowed-provider skip: provider=none model=${modelId} allowed=${allowedProviders.join(",")}`);
  return false;
}

export function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function boolEnv(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function trimSlash(value) {
  return value.replace(/\/+$/, "");
}
