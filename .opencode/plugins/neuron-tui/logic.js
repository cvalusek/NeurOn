// Pure display/selection logic for the NeurOn TUI reservation panel.
// Framework-free and deterministic so it can be unit-tested with `node --test`
// (no TypeScript, no loaders). `now` is always passed in by the caller.

/**
 * @typedef {Object} ModelEntry
 * @property {string} id
 * @property {string[]} [aliases]
 * @property {string[]} [backendModelIds]
 * @property {string[]} [runtimeModelIds]
 * @property {string[]} [targetIds]
 */

/**
 * @typedef {Object} ReservationLike
 * @property {string} [reservationId]
 * @property {string[]} [modelIds]
 * @property {Array<{ id?: string }>} [targets]
 * @property {string} [expiresAt]
 */

/**
 * @typedef {Object} SummaryRow
 * @property {string} label
 * @property {string} value
 * @property {("ok"|"warn"|"bad"|"accent"|"muted")?} [tone]
 */

/**
 * @typedef {Object} Summary
 * @property {string} collapsed
 * @property {"ok"|"warn"|"bad"|"unknown"} level
 * @property {SummaryRow[]} rows
 */

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Parse a NEURON_ALLOWED_PROVIDERS value (comma-separated, same format as
 * the server plugin) into a lowercased list. Empty/undefined -> [].
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseAllowedProviders(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a session model passes the NEURON_ALLOWED_PROVIDERS filter.
 * Mirrors the server plugin's matchesAllowedProvider:
 *   - empty filter allows everything;
 *   - a provider id (when present) must be in the list, case-insensitive;
 *   - without a provider id, the model string must start with `provider/`.
 *
 * @param {string[] | undefined} allowedProviders
 * @param {string | undefined} providerId
 * @param {string | undefined} modelId
 * @returns {boolean}
 */
export function isProviderAllowed(allowedProviders, providerId, modelId) {
  if (!Array.isArray(allowedProviders) || allowedProviders.length === 0) return true;
  const provider =
    typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (provider) {
    return allowedProviders.some((p) => p === provider);
  }
  const model = typeof modelId === "string" ? modelId.toLowerCase() : "";
  return allowedProviders.some((p) => model.startsWith(`${p}/`));
}

/**
 * All name keys a catalog entry is known by (id, aliases, backend +
 * runtime model ids), lowercased.
 *
 * @param {object} entry
 * @returns {string[]}
 */
function modelLookupKeys(entry) {
  return [
    entry?.id,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    ...(Array.isArray(entry?.backendModelIds) ? entry.backendModelIds : []),
    ...(Array.isArray(entry?.runtimeModelIds) ? entry.runtimeModelIds : []),
  ].map(lower).filter((id) => id !== "");
}

/**
 * Candidate names for a session model id: the full id, then each suffix
 * after a "/" (longest first). Litellm route names carry a target prefix
 * (e.g. "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"), so the bare
 * catalog/runtime model name is a suffix of the session model id.
 *
 * @param {string} modelId
 * @returns {string[]}
 */
export function modelCandidates(modelId) {
  const wanted = lower(modelId);
  if (!wanted) return [];
  const segments = wanted.split("/");
  const candidates = [];
  for (let i = 0; i < segments.length; i++) candidates.push(segments.slice(i).join("/"));
  return candidates;
}

/**
 * Find the catalog entry for a session model (case-insensitive), matching
 * the full id or any "/" suffix against the entry's id/aliases/backend/
 * runtime model ids. Mirrors the server plugin's model resolution.
 *
 * @param {ModelEntry[] | undefined} models
 * @param {string | undefined} modelId
 * @returns {ModelEntry | undefined}
 */
export function matchModelEntry(models, modelId) {
  const candidates = modelCandidates(modelId);
  if (candidates.length === 0) return undefined;
  const entries = (models ?? [])
    .filter((entry) => entry != null && typeof entry === "object")
    .map((entry) => ({ entry, keys: modelLookupKeys(entry) }));
  // Longest candidate first (same priority as the server plugin), then entry order.
  for (const candidate of candidates) {
    for (const { entry, keys } of entries) {
      if (keys.includes(candidate)) return entry;
    }
  }
  return undefined;
}

/**
 * Resolve the target id for a session model. When the id carries a target
 * prefix (litellm route "targetId/runtimeModel"), that target is preferred;
 * otherwise the entry's first targetId wins.
 *
 * @param {ModelEntry[] | undefined} models
 * @param {string | undefined} modelId
 * @returns {string | undefined}
 */
export function resolveTargetForModel(models, modelId) {
  const entry = matchModelEntry(models, modelId);
  if (!entry) return undefined;
  const targetIds = Array.isArray(entry.targetIds) ? entry.targetIds : [];
  if (targetIds.length === 0) return undefined;
  const candidates = modelCandidates(modelId);
  // The leading segment of the full id is the target prefix, if present.
  const hint = candidates.length > 1 ? candidates[0].split("/")[0] : undefined;
  if (hint) {
    const idx = targetIds.map(lower).indexOf(hint);
    if (idx !== -1) return targetIds[idx];
  }
  return targetIds[0];
}

function expiresAtMs(reservation) {
  const parsed = Date.parse(reservation?.expiresAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Pick the reservation relevant to a session model.
 *
 * Preference order:
 *   1. reservations whose modelIds intersect [modelId, ...extraModelKeys]
 *      (case-insensitive); extraModelKeys should carry the matched catalog
 *      entry's full key set (id, aliases, backend + runtime model ids);
 *   2. otherwise all reservations (target-only fallback);
 *   3. among those, keep only reservations whose targets include targetId
 *      (kept only if the filter leaves at least one candidate);
 *   4. if several remain, the nearest expiresAt wins.
 *
 * @param {ReservationLike[] | undefined} activeReservations
 * @param {string | undefined} modelId
 * @param {string[] | undefined} extraModelKeys
 * @param {string | undefined} targetId
 * @returns {ReservationLike | undefined}
 */
export function pickReservation(activeReservations, modelId, extraModelKeys, targetId) {
  const reservations = activeReservations ?? [];
  if (reservations.length === 0) return undefined;

  const wanted = new Set();
  for (const id of [modelId, ...(extraModelKeys ?? [])]) {
    const n = lower(id);
    if (n) wanted.add(n);
  }

  const modelMatches =
    wanted.size === 0
      ? []
      : reservations.filter((r) =>
          (r?.modelIds ?? []).some((id) => wanted.has(lower(id)))
        );

  let pool = modelMatches.length > 0 ? modelMatches : reservations;

  if (typeof targetId === "string" && targetId !== "") {
    const targetMatches = pool.filter((r) =>
      (r?.targets ?? []).some((t) => t?.id === targetId)
    );
    if (targetMatches.length > 0) pool = targetMatches;
  }

  if (pool.length === 0) return undefined;

  return pool.reduce((best, r) => (expiresAtMs(r) < expiresAtMs(best) ? r : best));
}

const WARN_STATES = new Set(["starting", "stopping", "warming", "pending"]);
const BAD_STATES = new Set(["stopped", "cold", "offline", "error", "failed"]);

/**
 * Map an observed target state to a display level.
 * @param {string | undefined} observed
 * @returns {"ok"|"warn"|"bad"|"unknown"}
 */
export function stateLevel(observed) {
  const s = lower(observed);
  if (s === "healthy") return "ok";
  if (WARN_STATES.has(s)) return "warn";
  if (BAD_STATES.has(s)) return "bad";
  return "unknown";
}

/**
 * Format a millisecond duration as mm:ss (or h:mm:ss at or over an hour),
 * flooring fractional seconds. Negative or non-finite input -> "0:00".
 *
 * @param {number} msLeft
 * @returns {string}
 */
export function formatCountdown(msLeft) {
  if (typeof msLeft !== "number" || !Number.isFinite(msLeft) || msLeft < 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(msLeft / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Format an ISO timestamp as local 12h wall clock "h:MM:SS AM/PM"
 * (e.g. 14:32:05 -> "2:32:05 PM"). Invalid input -> "-".
 *
 * @param {string | undefined} isoString
 * @returns {string}
 */
export function formatClock(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "-";
  const h24 = d.getHours();
  const meridiem = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")} ${meridiem}`;
}

const TARGET_MESSAGE_MAX_CHARS = 40;

/**
 * Format a USD-or-other currency amount compactly: USD -> "$0.80",
 * other -> "0.80 EUR". Non-finite input -> "".
 *
 * @param {number | undefined} value
 * @param {string | undefined} currency
 * @returns {string}
 */
function formatUsd(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const amount = value.toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency ?? "USD"}`;
}

function shortMessage(message) {
  if (typeof message !== "string") return "";
  const trimmed = message.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > TARGET_MESSAGE_MAX_CHARS) {
    return `${trimmed.slice(0, TARGET_MESSAGE_MAX_CHARS - 1)}…`;
  }
  return trimmed;
}

function msLeftUntil(isoString, now) {
  const t = Date.parse(isoString ?? "");
  if (!Number.isFinite(t)) return Number.NaN;
  return t - now;
}

/**
 * Build the collapsed one-line summary plus the expanded detail rows.
 * Pure and deterministic: `now` and every payload field come from the input.
 * Missing fields degrade to empty/unknown text and never throw.
 *
 * Unmanaged session model (isNeuronModel false or modelId missing): the
 * model row is marked " · not managed" (muted) and the reservation row slot
 * shows a muted `none for this model` note (with a count of active
 * reservations for other models, via `otherActiveCount`). A foreign
 * reservation passed in via `reservation` never renders its detail rows
 * (expires/keepalive/rate/cost) for an unmanaged model.
 *
 * @param {Object} input
 * @param {boolean} input.apiOk
 * @param {boolean} [input.stale]
 * @param {string} [input.modelId]
 * @param {string} [input.providerId]
 * @param {boolean} input.isNeuronModel
 * @param {string} [input.targetId]
 * @param {string} [input.targetDisplayName]
 * @param {string} [input.targetProvider]
 * @param {string} [input.targetObserved]
 * @param {string} [input.targetMessage]
 * @param {number} [input.activeUsers]
 * @param {{ reservationId: string, expiresAt: string, keepaliveMinutes?: number } | undefined} [input.reservation]
 * @param {{ estimatedCostUsd?: number, currency?: string, projectedRemainingCostUsd?: number, projectedTotalCostUsd?: number, estimatedHourlyCostUsd?: number } | undefined} [input.costEstimate]
 * @param {number} [input.otherActiveCount]
 * @param {number} input.now
 * @param {string} [input.sessionShortId]
 * @param {boolean} [input.sessionBusy]
 * @param {number | null | undefined} [input.lastRefreshedAt]
 * @returns {Summary}
 */
export function summarizeNeuron(input) {
  const {
    apiOk,
    stale = false,
    modelId,
    providerId,
    isNeuronModel,
    targetId,
    targetDisplayName,
    targetProvider,
    targetObserved,
    targetMessage,
    activeUsers,
    reservation,
    costEstimate,
    otherActiveCount = 0,
    now,
    sessionShortId,
    sessionBusy = false,
    lastRefreshedAt,
  } = input ?? {};

  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : 0;
  const observed =
    typeof targetObserved === "string" && targetObserved !== "" ? targetObserved : "";
  const hasTarget =
    typeof targetId === "string" && targetId !== "" && observed !== "";

  // Model naming: prefer the control-plane target displayName (from
  // /api/status); fall back to the opencode model id when the target
  // (and therefore its display name) is unknown.
  const displayName =
    typeof targetDisplayName === "string" && targetDisplayName !== "" ? targetDisplayName : "";

  // ── Collapsed line ──────────────────────────────────────────
  // Deliberately short: the header row shares the (narrow) sidebar width,
  // so the collapsed chip shows state + remaining time only. The model
  // name lives on the expanded model row (and in the prompt row).
  let collapsed;
  let level;
  if (!apiOk) {
    collapsed = "! unreachable";
    level = "warn";
  } else if (!isNeuronModel || !modelId) {
    collapsed = "○ not managed";
    level = "unknown";
  } else if (!hasTarget) {
    collapsed = "● unknown";
    level = "unknown";
  } else if (reservation) {
    const left = formatCountdown(msLeftUntil(reservation?.expiresAt, nowMs));
    collapsed = `● ${observed} · ${left} left`;
    level = stateLevel(observed);
  } else {
    collapsed = `● ${observed} · no reservation`;
    level = stateLevel(observed);
  }
  if (stale) collapsed = `${collapsed} (stale)`;

  // ── Expanded rows ───────────────────────────────────────────
  const rows = [];

  const modelValue =
    [providerId, modelId].filter((v) => typeof v === "string" && v !== "").join("/") || "";
  // The control-plane display name leads; the opencode model id stays in
  // parentheses for reference, e.g. `Small - Qwen 9B (litellm/gemma-4)`.
  const modelRowValue =
    displayName !== "" && modelValue !== "" ? `${displayName} (${modelValue})` : modelValue;
  const modelRow = { label: "model", value: modelRowValue };
  // Unmanaged session model: mark the model row muted — only when the value
  // is non-empty; empty values are left as-is.
  if ((!isNeuronModel || !modelId) && modelRowValue !== "") {
    modelRow.value = `${modelRowValue} · not managed`;
    modelRow.tone = "muted";
  }
  rows.push(modelRow);

  const reservationId =
    typeof reservation?.reservationId === "string" && reservation.reservationId !== ""
      ? reservation.reservationId
      : undefined;
  const expiresMsLeft = reservation ? msLeftUntil(reservation?.expiresAt, nowMs) : Number.NaN;

  if (isNeuronModel && modelId) {
    const stateTone = stateLevel(observed);
    const message = shortMessage(targetMessage);
    rows.push({
      label: "target state",
      value: observed !== "" ? (message ? `${observed} · ${message}` : observed) : "unknown",
      tone: stateTone === "unknown" ? undefined : stateTone,
    });
    rows.push({ label: "reservation", value: reservationId ?? "none" });
  } else {
    // Unmanaged session model: the reservation row slot shows a muted note
    // instead — a foreign (other-model) reservation never renders its
    // detail rows under this model.
    const count =
      typeof otherActiveCount === "number" && Number.isFinite(otherActiveCount)
        ? Math.max(0, Math.floor(otherActiveCount))
        : 0;
    let note = "none for this model";
    if (count > 0) note += ` (${count} active for other model${count === 1 ? "" : "s"})`;
    rows.push({ label: "reservation", value: note, tone: "muted" });
  }

  // Defense in depth: detail rows only for a managed session model — a
  // foreign reservation passed in can never render them for an unmanaged
  // model, even if a caller ignores the contract.
  if (isNeuronModel && modelId && reservation && reservationId !== undefined) {
    let expiresTone = "accent";
    if (Number.isFinite(expiresMsLeft) && expiresMsLeft < 30000) expiresTone = "bad";
    else if (Number.isFinite(expiresMsLeft) && expiresMsLeft < 120000) expiresTone = "warn";
    const clock = formatClock(reservation?.expiresAt);
    // Live countdown alongside the wall clock: `2:32:05 PM · 11:32 left`.
    const left =
      Number.isFinite(expiresMsLeft) ? ` · ${formatCountdown(expiresMsLeft)} left` : "";
    rows.push({ label: "expires", value: `${clock}${left}`, tone: expiresTone });
    if (
      typeof reservation.keepaliveMinutes === "number" &&
      Number.isFinite(reservation.keepaliveMinutes)
    ) {
      rows.push({ label: "keepalive", value: `${reservation.keepaliveMinutes} min` });
    }
    // Cost estimate (control plane), e.g. `rate $0.80 /hr` + `cost $0.46 left · $0.54 total`.
    const est =
      costEstimate && typeof costEstimate === "object" ? costEstimate : undefined;
    const currency =
      est && typeof est.currency === "string" && est.currency !== "" ? est.currency : undefined;
    const hourly = est?.estimatedHourlyCostUsd;
    if (typeof hourly === "number" && Number.isFinite(hourly)) {
      rows.push({ label: "rate", value: `${formatUsd(hourly, currency)} /hr` });
    }
    const remaining = est?.projectedRemainingCostUsd;
    const total = est?.projectedTotalCostUsd;
    const costParts = [];
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      costParts.push(`${formatUsd(remaining, currency)} left`);
    }
    if (typeof total === "number" && Number.isFinite(total)) {
      costParts.push(`${formatUsd(total, currency)} total`);
    }
    if (costParts.length > 0) {
      rows.push({ label: "cost", value: costParts.join(" · ") });
    }
  }

  // The display name now lives on the model row; the target row keeps
  // provider + active user count only.
  const hasTargetInfo =
    (typeof targetDisplayName === "string" && targetDisplayName !== "") ||
    (typeof targetProvider === "string" && targetProvider !== "") ||
    typeof activeUsers === "number";
  if (hasTargetInfo) {
    const provider = typeof targetProvider === "string" ? targetProvider : "";
    const users =
      typeof activeUsers === "number" && Number.isFinite(activeUsers) ? activeUsers : 0;
    rows.push({ label: "target", value: [provider, `users: ${users}`].join(" · ") });
  }

  if (typeof sessionShortId === "string" && sessionShortId !== "") {
    rows.push({
      label: "session",
      value: `${sessionShortId} ${sessionBusy ? "busy" : "idle"}`,
    });
  }

  let apiValue;
  let apiTone;
  if (apiOk && typeof lastRefreshedAt === "number" && Number.isFinite(lastRefreshedAt)) {
    const secsAgo = Math.max(0, Math.floor((nowMs - lastRefreshedAt) / 1000));
    apiValue = `ok · refreshed ${secsAgo}s ago`;
    apiTone = "ok";
  } else if (apiOk) {
    apiValue = "ok";
    apiTone = "ok";
  } else {
    apiValue = "unreachable";
    apiTone = "bad";
  }
  if (stale) apiValue = `${apiValue} · stale`;
  rows.push({ label: "api", value: apiValue, tone: apiTone });

  return { collapsed, level, rows };
}
