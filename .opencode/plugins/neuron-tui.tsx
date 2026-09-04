/** @jsxImportSource @opentui/solid */
import { createSignal, createEffect } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import {
  isProviderAllowed,
  matchModelEntry,
  parseAllowedProviders,
  pickReservation,
  resolveTargetForModel,
  summarizeNeuron,
} from "./neuron-tui/logic.js"

const DEFAULT_BASE_URL = "http://localhost:8090"
const POLL_MS = 2500
const REQUEST_TIMEOUT_MS = 3000
const MODELS_TTL_MS = 60000

/**
 * Read an env var without a hard dependency on the `process` global's types.
 * The TUI runs in the same local process as the server plugin, so the
 * NEURON_API_* env vars set for the server plugin are shared.
 */
function env(name: string): string | undefined {
  try {
    const p = (globalThis as Record<string, any>)["process"]
    const value = p?.env?.[name]
    return typeof value === "string" && value !== "" ? value : undefined
  } catch {
    return undefined
  }
}

type ModelEntry = {
  id?: string
  aliases?: string[]
  backendModelIds?: string[]
  runtimeModelIds?: string[]
  targetIds?: string[]
}

function colorFor(level: string, theme: TuiThemeCurrent): string {
  if (level === "ok") return theme.success
  if (level === "warn") return theme.warning
  if (level === "bad") return theme.error
  return theme.textMuted
}

function toneColor(tone: string | undefined, theme: TuiThemeCurrent): string {
  if (tone === "ok") return theme.success
  if (tone === "warn") return theme.warning
  if (tone === "bad") return theme.error
  if (tone === "accent") return theme.accent
  return theme.text
}

const tui: TuiPlugin = async (api) => {
  const [tick, setTick] = createSignal(0)
  // Collapsed by default — the one-line summary carries state + countdown.
  const [collapsed, setCollapsed] = createSignal(true)
  const [configOk, setConfigOk] = createSignal(false)
  const [data, setData] = createSignal<any>(undefined)
  const [models, setModels] = createSignal<any[]>([])
  const [refreshedAt, setRefreshedAt] = createSignal<number | null>(null)
  const [apiOk, setApiOk] = createSignal(false)
  const [stale, setStale] = createSignal(false)

  let config: { baseUrl: string; apiKey: string } | null = null
  const baseUrl = env("NEURON_API_BASE_URL") ?? DEFAULT_BASE_URL
  const apiKey = env("NEURON_API_KEY")
  if (apiKey && (baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
    config = { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey }
    setConfigOk(true)
  }
  // Same filter the server plugin applies: only session models routed to
  // these opencode providers are treated as NeurOn-managed (empty = all).
  const allowedProviders = parseAllowedProviders(env("NEURON_ALLOWED_PROVIDERS"))

  createEffect(() => {
    void tick()
    void configOk()
  })

  const refresh = () => {
    setTick((value) => value + 1)
    api.renderer.requestRender()
  }

  let statusInFlight = false
  const fetchStatus = async () => {
    if (config === null || statusInFlight) return
    statusInFlight = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${config.baseUrl}/api/status`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`NeurOn API ${response.status} for /api/status`)
      const json = await response.json()
      setData(json)
      setApiOk(true)
      setStale(false)
      setRefreshedAt(Date.now())
    } catch {
      // Fail open: keep the last known payload and flag it stale.
      setApiOk(false)
      setStale(true)
    } finally {
      clearTimeout(timer)
      statusInFlight = false
    }
  }

  let modelsInFlight = false
  let modelsFetchedAt = 0
  const fetchModels = async () => {
    if (config === null || modelsInFlight) return
    // At most every 60s while successful; a failed fetch resets the stamp so
    // the next poll retries.
    if (modelsFetchedAt > 0 && Date.now() - modelsFetchedAt < MODELS_TTL_MS) return
    modelsInFlight = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${config.baseUrl}/api/models`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`NeurOn API ${response.status} for /api/models`)
      const json = await response.json()
      setModels(Array.isArray(json?.models) ? json.models : [])
      modelsFetchedAt = Date.now()
    } catch {
      modelsFetchedAt = 0
    } finally {
      clearTimeout(timer)
      modelsInFlight = false
    }
  }

  const poll = () => {
    void fetchModels()
      .then(() => fetchStatus())
      .then(refresh)
  }

  const unsubs = [
    api.event.on("session.status", refresh),
    api.event.on("session.idle", refresh),
    api.event.on("message.updated", refresh),
    api.event.on("session.created", refresh),
    api.event.on("tui.session.select", refresh),
  ]
  let interval: ReturnType<typeof setInterval> | undefined
  if (configOk()) {
    poll()
    interval = setInterval(poll, POLL_MS)
  }
  api.lifecycle.onDispose(() => {
    for (const unsubscribe of unsubs) unsubscribe()
    if (interval !== undefined) clearInterval(interval)
  })

  function Row(props: { label: string; value: string; valueColor?: string }) {
    const t = api.theme.current
    return (
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={t.textMuted}>{props.label}</text>
        <text fg={props.valueColor ?? t.text}>{props.value}</text>
      </box>
    )
  }

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(props) {
        void tick()
        const route = api.route.current
        const sessionID = props?.session_id ?? (route.name === "session" ? route.params?.sessionID : undefined)
        if (typeof sessionID !== "string") return <box />
        const session = api.state.session.get(sessionID)
        // Main window only: subagent sessions carry a parentID.
        if (!session || session.parentID !== undefined) return <box />
        const theme = api.theme.current

        if (!configOk()) {
          return (
            <box width="100%" flexDirection="column" border={true} borderColor={theme.borderActive} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>! NeurOn plugin not configured</text>
            </box>
          )
        }

        const model = session.model
        const modelId = model?.id
        // matchModelEntry handles litellm route names (target prefix +
        // runtime model id) the same way the server plugin does, and the
        // NEURON_ALLOWED_PROVIDERS filter gates whether the session model
        // is NeurOn-managed at all (e.g. local homellm models are not).
        const providerOk = isProviderAllowed(allowedProviders, model?.providerID, modelId)
        const entry: ModelEntry | undefined =
          modelId !== undefined && providerOk ? matchModelEntry(models() ?? [], modelId) : undefined
        const targetId =
          modelId !== undefined ? resolveTargetForModel(models() ?? [], modelId) : undefined
        const status = data()
        const targets = Array.isArray(status?.capacityTargets) ? status.capacityTargets : []
        const target =
          targetId !== undefined ? targets.find((t: any) => t?.id === targetId) : undefined
        const entryKeys = entry
          ? [
              entry.id,
              ...(entry.aliases ?? []),
              ...(entry.backendModelIds ?? []),
              ...(entry.runtimeModelIds ?? []),
            ].filter((k): k is string => typeof k === "string")
          : []
        const activeReservations = Array.isArray(status?.activeReservations)
          ? status.activeReservations
          : []
        // Only compute/pass a real reservation when the session model is
        // managed — otherwise another model's reservation would render its
        // detail rows (expires/keepalive/rate/cost) under the unmanaged
        // model row.
        const reservation =
          entry !== undefined ? pickReservation(activeReservations, modelId, entryKeys, targetId) : undefined
        // Unmanaged model: every active reservation belongs to another model
        // (surfaced as a muted note, never as detail rows).
        const otherActiveCount = entry === undefined ? activeReservations.length : 0

        const summary = summarizeNeuron({
          apiOk: apiOk() && configOk(),
          stale: stale(),
          modelId,
          providerId: model?.providerID,
          isNeuronModel: entry !== undefined,
          otherActiveCount,
          targetId,
          targetDisplayName: target?.displayName,
          targetProvider: target?.provider,
          targetObserved: target?.observed,
          targetMessage: target?.message,
          activeUsers: Array.isArray(target?.activeUsers) ? target.activeUsers.length : undefined,
          reservation: reservation
            ? {
                reservationId: reservation.reservationId,
                expiresAt: reservation.expiresAt,
                keepaliveMinutes: reservation.keepaliveMinutes,
              }
            : undefined,
          costEstimate:
            reservation?.costEstimate && typeof reservation.costEstimate === "object"
              ? reservation.costEstimate
              : undefined,
          now: Date.now(),
          sessionShortId: sessionID.slice(0, 12),
          sessionBusy: api.state.session.status(sessionID)?.type === "busy",
          lastRefreshedAt: refreshedAt(),
        })

        const header = (
          <box height={1} flexDirection="row" justifyContent="space-between" onMouseDown={() => { setCollapsed(!collapsed()); refresh() }}>
            <text fg={theme.text}><b>{`${collapsed() ? "▶" : "▼"} NeurOn`}</b></text>
            {collapsed() ? (
              <text fg={colorFor(summary.level, theme)}>{summary.collapsed}</text>
            ) : <></>}
          </box>
        )
        return (
          <box width="100%" flexDirection="column" border={true} borderColor={theme.borderActive} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
            {header}
            {collapsed() ? <></> : (
              <box flexDirection="column">
                {summary.rows.map((row) => (
                  <Row label={row.label} value={row.value} valueColor={toneColor(row.tone, theme)} />
                ))}
              </box>
            )}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "neuron-tui",
  tui,
}

export default plugin
