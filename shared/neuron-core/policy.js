// ── Activity tracking (activity-gated keepalive) ──────────
// Keepalive refreshes only run while the session has had real agent work
// (messages, tool execution, message/part updates) within the last
// keepaliveMinutes. Mere process/session liveness does NOT count as
// activity. The activity map is part of the injected state object.

import { DEFAULT_DURATION_MINUTES } from "./config.js";

export function markActivity(state, sessionID) {
  if (!sessionID) return;
  state.sessionActivity.set(sessionID, Date.now());
}

export function isSessionActive(state, sessionID, client) {
  const last = state.sessionActivity.get(sessionID);
  if (!last) return false;
  const graceMs = (client?.config?.keepaliveMinutes ?? DEFAULT_DURATION_MINUTES) * 60 * 1000;
  return Date.now() - last <= graceMs;
}

// ── Keepalive policy arithmetic ───────────────────────────
// Extend cadence: refresh at 50% of the effective lifetime, floored at 30 s,
// and only while activity occurred within the keepalive grace window. Pure
// arithmetic — the adapter (OpenCode) drives these from its keepalive
// interval; the Codex/pi ports drive them from their own tickers.

export function effectiveKeepaliveMinutes(reservation) {
  return reservation.keepaliveMinutes ?? reservation.durationMinutes ?? DEFAULT_DURATION_MINUTES;
}

export function keepaliveIntervalMs(minutes) {
  return Math.max((minutes * 60 * 1000) / 2, 30000);
}

// Extend-due predicate for tick-style keepalives: due once at least half the
// effective lifetime has elapsed since the last extend, with the same 30 s
// floor as keepaliveIntervalMs.
export function isExtendDue(nowMs, lastExtendMs, lifetimeMs) {
  return nowMs - lastExtendMs >= Math.max(lifetimeMs / 2, 30000);
}

// ── Utilities ─────────────────────────────────────────────

// Format a human-readable warmup timeout from the config value.
// e.g. waitTimeoutMs=600000 → "10m"
export function formatWarmupTimeoutMs(ms) {
  const min = Math.ceil(ms / 60000);
  return `${min}m`;
}

// Format a timestamp (ISO string or Date) as a local 12-hour wall clock,
// e.g. "3:07:42 PM".
export function formatClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const hour12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${hour12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() >= 12 ? "PM" : "AM"}`;
}
