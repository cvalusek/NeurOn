import type { RawData, WebSocket } from "ws";
import { withProviderRuntimeEndpoints } from "../capacity/providerRuntime.js";
import type { AssistantConfigRepository, CapacityProvider, TargetStatusRepository } from "../domain/interfaces.js";
import type { AssistantAudioConfig, AssistantConfig, AssistantDeploymentBinding, AuthenticatedUser, CapacityTarget, ModelDefinition } from "../domain/types.js";
import type { ModelCatalog } from "./ModelCatalog.js";
import type { ReservationService } from "./ReservationService.js";
import { ASSISTANT_STT_MAX_BYTES, assertRiffWave, parseAssistantAudioConfig } from "./assistantAudioConfig.js";

const MAX_TTS_TEXT_CHARACTERS = 8_000;
const MAX_TTS_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_REALTIME_EVENT_CHARACTERS = 16 * 1024 * 1024;
const MAX_REALTIME_INPUT_CHUNK_BYTES = 1024 * 1024;
const MAX_REALTIME_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_REALTIME_SESSION_MILLISECONDS = 10 * 60 * 1_000;
const WEBSOCKET_OPEN = 1;

type AudioRole = "stt" | "tts" | "realtime";

interface AudioBackend {
  target: CapacityTarget;
  binding: AssistantDeploymentBinding;
  config: AssistantConfig;
  apiBaseUrl: string;
  requestTimeoutMilliseconds: number;
}

export interface AssistantAudioStatus {
  stt: boolean;
  tts: boolean;
  realtime: boolean;
}

export interface AssistantAudioServiceOptions {
  assistantConfig: AssistantConfigRepository;
  catalog: ModelCatalog;
  reservationService: ReservationService;
  statuses: TargetStatusRepository;
  capacityProvider: CapacityProvider;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AssistantAudioService {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly runtimeTargetCache = new Map<string, { target: CapacityTarget; expiresAt: number }>();

  constructor(private readonly options: AssistantAudioServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async status(): Promise<AssistantAudioStatus> {
    const audio = parseAssistantAudioConfig((await this.options.assistantConfig.get())?.audio);
    return { stt: Boolean(audio?.stt), tts: Boolean(audio?.tts?.voice), realtime: Boolean(audio?.realtime) };
  }

  async validateConfiguration(audio: AssistantAudioConfig | undefined): Promise<AssistantAudioConfig | undefined> {
    const parsed = parseAssistantAudioConfig(audio);
    if (!parsed) return undefined;
    await Promise.all((Object.entries(parsed) as Array<[AudioRole, AssistantDeploymentBinding | undefined]>).map(async ([role, binding]) => {
      if (!binding) return;
      this.resolveDeployment(binding, role);
    }));
    return parsed;
  }

  async transcribe(wav: Buffer): Promise<string> {
    assertRiffWave(wav, ASSISTANT_STT_MAX_BYTES, "Dictation audio");
    const backend = await this.acquire("stt");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictation.wav");
    form.append("model", backend.binding.modelId);
    const response = await this.request(`${backend.apiBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: authorizationHeaders(backend.target),
      body: form
    }, backend.requestTimeoutMilliseconds);
    const result = JSON.parse(await responseTextWithinLimit(response, MAX_JSON_RESPONSE_BYTES, "Speech-to-text response")) as { text?: unknown };
    if (typeof result.text !== "string") throw new Error("Speech-to-text response did not contain a transcript");
    return result.text.trim();
  }

  async synthesize(textInput: string): Promise<Buffer> {
    const text = textInput.trim();
    if (!text || text.length > MAX_TTS_TEXT_CHARACTERS) throw new Error(`Text to read must be between 1 and ${MAX_TTS_TEXT_CHARACTERS.toLocaleString("en-US")} characters`);
    const backend = await this.acquire("tts");
    const tts = backend.config.audio?.tts;
    if (!tts?.voice) throw new Error("Assistant text-to-speech voice is not configured");
    const voice = tts.voice;
    const body: Record<string, unknown> = {
      model: backend.binding.modelId,
      input: text,
      response_format: "wav"
    };
    if (voice.mode === "packaged") {
      body.options = {
        speaker: voice.voiceId,
        ...(voice.instructions ? { instructions: voice.instructions } : {})
      };
    } else {
      body.voice_ref = { type: "base64", data: voice.reference.dataBase64 };
      body.reference_text = voice.reference.referenceText;
    }
    const response = await this.request(`${backend.apiBaseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authorizationHeaders(backend.target) },
      body: JSON.stringify(body)
    }, backend.requestTimeoutMilliseconds);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_TTS_RESPONSE_BYTES) throw new Error("Text-to-speech response exceeds NeurOn's audio size limit");
    const result = await responseBufferWithinLimit(response, MAX_TTS_RESPONSE_BYTES, "Text-to-speech response");
    assertRiffWave(result, MAX_TTS_RESPONSE_BYTES, "Text-to-speech response");
    return result;
  }

  bridgeRealtime(socket: WebSocket, _user: AuthenticatedUser): void {
    let closed = false;
    let inputEnded = false;
    let queuedBytes = 0;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let resolveWriter!: (value: WritableStreamDefaultWriter<Uint8Array>) => void;
    let rejectWriter!: (error: unknown) => void;
    const writerReady = new Promise<WritableStreamDefaultWriter<Uint8Array>>((resolve, reject) => { resolveWriter = resolve; rejectWriter = reject; });
    // A browser can leave while the model is still waking and before any PCM
    // handler awaits this promise. Attach the rejection handler immediately so
    // that ordinary navigation cannot become an unhandled process rejection.
    void writerReady.catch(() => undefined);
    const abort = new AbortController();
    let inputQueue = Promise.resolve();

    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : "Real-time voice session failed";
      this.sendControl(socket, { type: "error", message });
      if (socket.readyState === WEBSOCKET_OPEN) socket.close(1011, "Real-time voice session failed");
    };
    const endInput = () => {
      if (inputEnded) return;
      inputEnded = true;
      // Browser message events can deliver the final PCM chunk immediately
      // before the end control. Preserve that ordering when closing the
      // upstream request body so the legal zero-length HTTP terminator follows
      // every accepted audio byte.
      void inputQueue.then(() => writerReady).then((active) => active.close()).catch(() => undefined);
    };
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const control = JSON.parse(rawDataBuffer(data).toString("utf8")) as { type?: string };
          if (control.type === "end") endInput();
        } catch { fail(new Error("Real-time voice control message is invalid")); }
        return;
      }
      if (inputEnded) return fail(new Error("Real-time voice audio arrived after end of input"));
      const chunk = rawDataBuffer(data);
      if (chunk.length === 0 || chunk.length > MAX_REALTIME_INPUT_CHUNK_BYTES) return fail(new Error("Real-time voice audio chunk exceeds the accepted size"));
      queuedBytes += chunk.length;
      if (queuedBytes > MAX_REALTIME_QUEUED_BYTES) return fail(new Error("Real-time voice input is arriving faster than the model can accept it"));
      inputQueue = inputQueue.then(async () => {
        const active = await writerReady;
        await active.write(new Uint8Array(chunk));
      }).catch(fail).finally(() => { queuedBytes -= chunk.length; });
    });
    socket.on("close", () => {
      closed = true;
      abort.abort();
      rejectWriter(new Error("Browser closed the real-time voice session"));
      void writer?.abort().catch(() => undefined);
    });
    socket.on("error", () => abort.abort());
    this.sendControl(socket, { type: "status", phase: "waking", message: "NeurOn is waking the real-time voice model…" });

    void (async () => {
      try {
        const backend = await this.acquire("realtime");
        const realtime = backend.config.audio?.realtime;
        if (!realtime) throw new Error("Assistant real-time voice is not configured");
        if (closed) return;
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        writer = stream.writable.getWriter();
        resolveWriter(writer);
        const upstream = new URL(`${backend.apiBaseUrl}/audio/speech/live`);
        upstream.searchParams.set("model", realtime.modelId);
        upstream.searchParams.set("input", realtime.instructions);
        upstream.searchParams.set("sample_rate", "24000");
        upstream.searchParams.set("channels", "1");
        upstream.searchParams.set("sample_format", "s16le");
        upstream.searchParams.set("response_format", "pcm");
        upstream.searchParams.set("stream_format", "sse");
        upstream.searchParams.set("voice_id", realtime.voiceId ?? "NATF2");
        upstream.searchParams.set("busy_timeout_ms", "30000");
        const timeout = setTimeout(() => abort.abort(), Math.min(MAX_REALTIME_SESSION_MILLISECONDS, backend.config.reservationMinutes * 60_000));
        const responsePromise = this.fetchImpl(upstream, {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/octet-stream", ...authorizationHeaders(backend.target) },
          body: stream.readable,
          duplex: "half",
          signal: abort.signal
        } as RequestInit & { duplex: "half" });
        this.sendControl(socket, {
          type: "ready",
          sampleRate: 24_000,
          channels: 1,
          sampleFormat: "s16le",
          voiceId: realtime.voiceId ?? "NATF2"
        });
        try {
          const response = await responsePromise;
          if (!response.ok) throw await providerError(response, "Real-time voice model");
          if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
            throw new Error("Real-time voice model did not return an SSE event stream");
          }
          if (!response.body) throw new Error("Real-time voice model returned no event stream");
          await this.forwardSpeechEvents(socket, response.body, abort.signal);
        } finally { clearTimeout(timeout); }
      } catch (error) {
        if (!closed && !abort.signal.aborted) fail(error);
      } finally {
        endInput();
      }
    })();
  }

  private async forwardSpeechEvents(socket: WebSocket, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    while (!signal.aborted) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      if (buffer.length > MAX_REALTIME_EVENT_CHARACTERS && !eventBoundary(buffer)) {
        throw new Error("Real-time voice model returned an oversized event");
      }
      let boundary = eventBoundary(buffer);
      while (boundary) {
        if (boundary.index > MAX_REALTIME_EVENT_CHARACTERS) throw new Error("Real-time voice model returned an oversized event");
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:" )).map((line) => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") { sawDone = true; this.sendControl(socket, { type: "done" }); }
        else if (data) await this.forwardSpeechEvent(socket, data);
        boundary = eventBoundary(buffer);
      }
      if (result.done) break;
    }
    if (!sawDone && !signal.aborted) throw new Error("Real-time voice event stream ended before completion");
  }

  private async forwardSpeechEvent(socket: WebSocket, data: string): Promise<void> {
    let event: { type?: string; audio?: string; error?: { message?: string }; timing?: unknown };
    try { event = JSON.parse(data) as typeof event; }
    catch { throw new Error("Real-time voice model returned an invalid event"); }
    if (event.type === "speech.audio.delta") {
      if (typeof event.audio !== "string" || !event.audio) throw new Error("Real-time voice model returned an invalid audio delta");
      const audio = Buffer.from(event.audio, "base64");
      if (!audio.length) throw new Error("Real-time voice model returned an empty audio delta");
      await waitForSocketCapacity(socket);
      if (socket.readyState === WEBSOCKET_OPEN) socket.send(audio, { binary: true });
      return;
    }
    if (event.type === "speech.audio.done") return this.sendControl(socket, { type: "timing", timing: event.timing ?? null });
    if (event.type === "error") throw new Error(event.error?.message?.slice(0, 500) || "Real-time voice model failed");
  }

  private async acquire(role: AudioRole): Promise<AudioBackend> {
    const config = await this.options.assistantConfig.get();
    const audio = parseAssistantAudioConfig(config?.audio);
    const binding = audio?.[role];
    if (!config || !binding) throw new Error(`Assistant ${roleLabel(role)} is not configured`);
    const { target, model } = this.resolveDeployment(binding, role);
    const initialStatus = this.options.statuses.get(target.id);
    const initialWarm = initialStatus?.observed === "healthy" && initialStatus.desired === "on";
    const systemUser = audioSystemUser(role);
    const active = await this.options.reservationService.listActiveOwned(systemUser);
    const matching = active.find((reservation) => reservation.keepaliveMinutes === config.keepaliveMinutes && reservation.targetSelections?.some((selection) => selection.targetId === target.id && selection.modelIds.includes(model.id)));
    for (const reservation of active.filter((candidate) => candidate.id !== matching?.id)) await this.options.reservationService.markDone(reservation.id, systemUser);
    if (matching) await this.options.reservationService.extend(matching.id, systemUser, config.reservationMinutes, { fromNow: true });
    else await this.options.reservationService.createForUser(systemUser, {
      targetIds: [target.id], modelIds: [model.id], durationMinutes: config.reservationMinutes,
      keepaliveMinutes: config.keepaliveMinutes, synthetic: true
    });

    const deadline = Date.now() + config.reservationMinutes * 60_000;
    while (Date.now() <= deadline) {
      const status = this.options.statuses.get(target.id);
      if (status?.observed === "healthy" && status.desired === "on") {
        const cacheKey = `${target.id}\u0000${model.id}`;
        let runtimeTarget = target;
        if (!runtimeTarget.apiUrl) {
          const cached = this.runtimeTargetCache.get(cacheKey);
          runtimeTarget = cached && cached.expiresAt > Date.now()
            ? cached.target
            : withProviderRuntimeEndpoints(target, await this.options.capacityProvider.getTargetStatus(target));
          this.runtimeTargetCache.set(cacheKey, { target: runtimeTarget, expiresAt: Date.now() + 30_000 });
        }
        if (!runtimeTarget.apiUrl) throw new Error(`Assistant audio target ${target.id} has no direct API URL`);
        return {
          target: runtimeTarget,
          binding: { ...binding, modelId: model.id },
          config,
          apiBaseUrl: runtimeTarget.apiUrl.replace(/\/$/u, ""),
          requestTimeoutMilliseconds: (initialWarm ? binding.requestTimeoutSeconds ?? config.requestTimeoutSeconds : config.reservationMinutes * 60) * 1_000
        };
      }
      if (status?.observed === "failed") throw new Error(`Assistant audio target failed: ${status.message}`);
      await this.sleep(500);
    }
    throw new Error(`Assistant audio target ${target.id} did not become ready within the configured reservation duration`);
  }

  private resolveDeployment(binding: AssistantDeploymentBinding, role: AudioRole): { target: CapacityTarget; model: ModelDefinition } {
    const target = this.options.catalog.getTarget(binding.targetId);
    const model = target ? deploymentModel(this.options.catalog, target.id, binding.modelId) : undefined;
    if (!target || !model) throw new Error(`Assistant ${roleLabel(role)} deployment ${binding.targetId}/${binding.modelId} is not available`);
    return { target, model };
  }

  private async request(url: string, init: RequestInit, timeoutMilliseconds: number): Promise<Response> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMilliseconds);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: abort.signal });
      if (!response.ok) throw await providerError(response, "Assistant audio model");
      return response;
    } catch (error) {
      if (abort.signal.aborted) throw new Error("Assistant audio model did not respond before the configured timeout");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  private sendControl(socket: WebSocket, value: Record<string, unknown>): void {
    if (socket.readyState === WEBSOCKET_OPEN) socket.send(JSON.stringify(value));
  }
}

function audioSystemUser(role: AudioRole): AuthenticatedUser {
  return { id: `system:assistant-${role}`, username: `assistant-${role}`, isAdmin: true, permissions: ["*"], sessionVersion: 0 };
}

function roleLabel(role: AudioRole): string {
  if (role === "stt") return "speech-to-text";
  if (role === "tts") return "text-to-speech";
  return "real-time voice";
}

function deploymentModel(catalog: ModelCatalog, targetId: string, modelId: string): ModelDefinition | undefined {
  const normalized = normalizeModelId(modelId);
  const matches = catalog.listModelsForTarget(targetId).filter((model) =>
    [model.id, ...model.aliases, ...(model.backendModelIds ?? []), ...(model.runtimeModelIds ?? [])]
      .some((candidate) => normalizeModelId(candidate) === normalized)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeModelId(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function authorizationHeaders(target: CapacityTarget): Record<string, string> {
  const envName = target.modelWarmup?.apiKeyEnv ?? target.litellm?.apiKeyEnv;
  const value = target.modelWarmup?.apiKey ?? (envName ? process.env[envName] : undefined);
  return value ? { authorization: `Bearer ${value}` } : {};
}

async function providerError(response: Response, label: string): Promise<Error> {
  let message = "";
  try {
    const body = JSON.parse(await responseTextWithinLimit(response, MAX_PROVIDER_ERROR_BYTES, `${label} error`)) as { error?: { message?: unknown } | string };
    message = typeof body.error === "string" ? body.error : typeof body.error?.message === "string" ? body.error.message : "";
  } catch { /* response body is intentionally not logged */ }
  return new Error(`${label} returned HTTP ${response.status}${message ? `: ${message.slice(0, 500)}` : ""}`);
}

async function responseTextWithinLimit(response: Response, maximumBytes: number, label: string): Promise<string> {
  return (await responseBufferWithinLimit(response, maximumBytes, label)).toString("utf8");
}

async function responseBufferWithinLimit(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  if (!response.body) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > maximumBytes) throw new Error(`${label} exceeds NeurOn's size limit`);
    return value;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let reading = true;
  while (reading) {
    const { value, done } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds NeurOn's size limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

function rawDataBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}

function eventBoundary(value: string): { index: number; length: number } | undefined {
  const unix = value.indexOf("\n\n");
  const windows = value.indexOf("\r\n\r\n");
  if (unix < 0 && windows < 0) return undefined;
  if (windows >= 0 && (unix < 0 || windows <= unix)) return { index: windows, length: 4 };
  return { index: unix, length: 2 };
}

async function waitForSocketCapacity(socket: WebSocket): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (socket.readyState === WEBSOCKET_OPEN && socket.bufferedAmount > 4 * 1024 * 1024) {
    if (Date.now() >= deadline) throw new Error("Browser is not consuming real-time voice audio");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
