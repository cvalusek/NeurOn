import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AssistantConfig, CapacityProviderStatus, CapacityTarget, ModelDefinition } from "../domain/types.js";
import { InMemoryAssistantConfigRepository } from "../repository/InMemoryAssistantConfigRepository.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetStatusRepository } from "../repository/InMemoryTargetStatusRepository.js";
import { AssistantAudioService } from "../services/AssistantAudioService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import {
  ASSISTANT_VOICE_REFERENCE_MAX_BYTES,
  decodeAssistantVoiceReference,
  mergeAssistantAudioUpdate,
  parseAssistantAudioConfig
} from "../services/assistantAudioConfig.js";
import { testUser } from "./testUsers.js";

const target: CapacityTarget = {
  id: "audio-target",
  displayName: "Audio target",
  provider: "docker",
  modelIds: ["qwen-asr", "qwen-tts", "personaplex"],
  litellm: { apiKeyEnv: "NEURON_ASSISTANT_AUDIO_TEST_KEY" },
  apiUrl: "http://audio.test/v1",
  healthUrl: "http://audio.test/health"
};

const models: ModelDefinition[] = target.modelIds.map((id) => ({ id, displayName: id, aliases: [id], targetIds: [target.id] }));

function wav(payloadBytes = 4): Buffer {
  const value = Buffer.alloc(44 + payloadBytes);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVE", 8, "ascii");
  value.write("fmt ", 12, "ascii");
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(24_000, 24);
  value.writeUInt32LE(48_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36, "ascii");
  value.writeUInt32LE(payloadBytes, 40);
  return value;
}

function baseConfig(audio: AssistantConfig["audio"]): Omit<AssistantConfig, "id" | "updatedAt"> {
  return {
    targetId: target.id,
    modelId: "qwen-tts",
    reservationMinutes: 15,
    keepaliveMinutes: 5,
    requestTimeoutSeconds: 90,
    audio
  };
}

function harness(fetchImpl: typeof fetch) {
  const assistantConfig = new InMemoryAssistantConfigRepository();
  const reservations = new InMemoryReservationRepository();
  const statuses = new InMemoryTargetStatusRepository();
  statuses.set({ targetId: target.id, desired: "on", observed: "healthy", message: "ready", lastCheckedAt: new Date() });
  const catalog = new ModelCatalog(models, [target]);
  const reservationService = new ReservationService(reservations, catalog);
  const capacityProvider = {
    provisionTarget: vi.fn(), ensureTargetOn: vi.fn(), ensureTargetOff: vi.fn(), forceStopTarget: vi.fn(),
    getTargetStatus: vi.fn(async (): Promise<CapacityProviderStatus> => ({ observed: "healthy", message: "ready" }))
  };
  const service = new AssistantAudioService({ assistantConfig, catalog, reservationService, statuses, capacityProvider, fetchImpl, sleep: async () => undefined });
  return { service, assistantConfig, reservations, capacityProvider };
}

describe("assistant audio configuration", () => {
  it("accepts only a standard-base64 RIFF/WAVE reference within the 5 MiB limit", () => {
    const reference = { fileName: "voice.wav", mimeType: "audio/wav" as const, dataBase64: wav().toString("base64"), referenceText: "Exact words." };
    expect(decodeAssistantVoiceReference(reference)).toEqual(wav());
    expect(() => decodeAssistantVoiceReference({ ...reference, dataBase64: "abc_" })).toThrow(/standard base64/);
    expect(() => decodeAssistantVoiceReference({ ...reference, dataBase64: Buffer.from("not a wave").toString("base64") })).toThrow(/RIFF\/WAVE/);
    expect(() => decodeAssistantVoiceReference({ ...reference, dataBase64: wav(ASSISTANT_VOICE_REFERENCE_MAX_BYTES).toString("base64") })).toThrow(/5 MiB/);
  });

  it("preserves an existing private reference only for the explicit same-reference update", () => {
    const existing = parseAssistantAudioConfig({
      tts: { targetId: target.id, modelId: "qwen-tts", voice: { mode: "reference", reference: { fileName: "voice.wav", mimeType: "audio/wav", dataBase64: wav().toString("base64"), referenceText: "Old text" } } }
    });
    expect(mergeAssistantAudioUpdate({
      tts: { targetId: target.id, modelId: "qwen-tts", voice: { mode: "reference", keepExisting: true, referenceText: "Corrected text" } }
    }, existing)).toMatchObject({ tts: { voice: { mode: "reference", reference: { dataBase64: wav().toString("base64"), referenceText: "Corrected text" } } } });
    expect(() => mergeAssistantAudioUpdate({
      tts: { targetId: target.id, modelId: "qwen-tts", voice: { mode: "reference", keepExisting: true } }
    }, undefined)).toThrow(/Upload a WAV/);
  });
});

describe("AssistantAudioService", () => {
  it("uses the normal audio endpoints, exact configured models and speakers, and reuses per-role synthetic reservations", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith("/audio/transcriptions")) return new Response(JSON.stringify({ text: "transcribed words" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/audio/speech")) return new Response(new Uint8Array(wav()), { status: 200, headers: { "content-type": "audio/wav" } });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const previousKey = process.env.NEURON_ASSISTANT_AUDIO_TEST_KEY;
    process.env.NEURON_ASSISTANT_AUDIO_TEST_KEY = "test-runtime-key";
    try {
      const { service, assistantConfig, reservations } = harness(fetchImpl);
      await assistantConfig.save(baseConfig({
        stt: { targetId: target.id, modelId: "qwen-asr" },
        tts: { targetId: target.id, modelId: "qwen-tts", voice: { mode: "packaged", voiceId: "Vivian", instructions: "Calm and clear" } }
      }));

      await expect(service.transcribe(wav())).resolves.toBe("transcribed words");
      await expect(service.synthesize("Read this once.")).resolves.toEqual(wav());
      await expect(service.synthesize("Read this twice.")).resolves.toEqual(wav());

      const transcription = requests[0]!;
      expect(transcription.url).toBe("http://audio.test/v1/audio/transcriptions");
      expect(new Headers(transcription.init.headers).get("authorization")).toBe("Bearer test-runtime-key");
      expect(transcription.init.body).toBeInstanceOf(FormData);
      expect((transcription.init.body as FormData).get("model")).toBe("qwen-asr");
      expect((transcription.init.body as FormData).get("file")).toBeInstanceOf(Blob);
      expect(new Headers(requests[1]!.init.headers).get("authorization")).toBe("Bearer test-runtime-key");
      expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
        model: "qwen-tts",
        input: "Read this once.",
        response_format: "wav",
        options: { speaker: "Vivian", instructions: "Calm and clear" }
      });
      expect(await reservations.list()).toMatchObject([
        { username: "assistant-stt", synthetic: true, modelIds: ["qwen-asr"] },
        { username: "assistant-tts", synthetic: true, modelIds: ["qwen-tts"] }
      ]);
    } finally {
      if (previousKey === undefined) delete process.env.NEURON_ASSISTANT_AUDIO_TEST_KEY;
      else process.env.NEURON_ASSISTANT_AUDIO_TEST_KEY = previousKey;
    }
  });

  it("sends a cloned voice as an inline base64 object and never as a bare string", async () => {
    let speechBody: Record<string, unknown> | undefined;
    const { service, assistantConfig } = harness(async (_input, init) => {
      speechBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array(wav()), { status: 200, headers: { "content-type": "audio/wav" } });
    });
    const voice = wav().toString("base64");
    await assistantConfig.save(baseConfig({
      tts: { targetId: target.id, modelId: "qwen-tts", voice: { mode: "reference", reference: { fileName: "voice.wav", mimeType: "audio/wav", dataBase64: voice, referenceText: "Reference words" } } }
    }));

    await service.synthesize("Hello");

    expect(speechBody).toMatchObject({
      model: "qwen-tts",
      voice_ref: { type: "base64", data: voice },
      reference_text: "Reference words"
    });
    expect(typeof speechBody?.voice_ref).toBe("object");
  });

  it("parses split SSE boundaries and forwards PersonaPlex PCM plus control messages over the browser socket", async () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"speech.audio.delta","audio":"${audio.toString("base64")}"}\r\n`));
        controller.enqueue(encoder.encode("\r\ndata: {\"type\":\"speech.audio.done\",\"timing\":{\"request_start_to_first_audio_ms\":42}}\n\ndata: [DONE]\n\n"));
        controller.close();
      }
    });
    const { service, assistantConfig } = harness(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await assistantConfig.save(baseConfig({ realtime: { targetId: target.id, modelId: "personaplex", voiceId: "NATF2", instructions: "Be a concise capacity assistant.", sampleRate: 24_000 } }));
    const socket = new FakeSocket();

    service.bridgeRealtime(socket as never, testUser());
    await vi.waitFor(() => expect(socket.sent.some((entry) => Buffer.isBuffer(entry) && entry.equals(audio))).toBe(true));

    const controls = socket.sent.filter((entry): entry is string => typeof entry === "string").map((entry) => JSON.parse(entry) as { type: string; timing?: unknown });
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "status" }),
      expect.objectContaining({ type: "ready", sampleRate: 24_000, sampleFormat: "s16le" }),
      expect.objectContaining({ type: "timing", timing: { request_start_to_first_audio_ms: 42 } }),
      expect.objectContaining({ type: "done" })
    ]));
    socket.close();
  });

  it("forwards browser PCM into one chunked PersonaPlex request and closes input only on the explicit end control", async () => {
    const upstreamInput: Buffer[] = [];
    let upstreamUrl = "";
    const { service, assistantConfig } = harness(async (input, init) => {
      upstreamUrl = String(input);
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        upstreamInput.push(Buffer.from(chunk.value));
        chunk = await reader.read();
      }
      return new Response("data: {\"type\":\"speech.audio.done\",\"timing\":{\"overlap_ms\":1}}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    await assistantConfig.save(baseConfig({ realtime: { targetId: target.id, modelId: "personaplex", voiceId: "VARM2", instructions: "Guide the operator.", sampleRate: 24_000 } }));
    const socket = new FakeSocket();

    service.bridgeRealtime(socket as never, testUser());
    await vi.waitFor(() => expect(socket.sent.some((entry) => typeof entry === "string" && JSON.parse(entry).type === "ready")).toBe(true));
    socket.emit("message", Buffer.from([1, 2]), true);
    socket.emit("message", Buffer.from([3, 4]), true);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "end" })), false);
    await vi.waitFor(() => expect(socket.sent.some((entry) => typeof entry === "string" && JSON.parse(entry).type === "done")).toBe(true));

    expect(Buffer.concat(upstreamInput)).toEqual(Buffer.from([1, 2, 3, 4]));
    const url = new URL(upstreamUrl);
    expect(url.pathname).toBe("/v1/audio/speech/live");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "personaplex",
      input: "Guide the operator.",
      sample_rate: "24000",
      channels: "1",
      sample_format: "s16le",
      response_format: "pcm",
      stream_format: "sse",
      voice_id: "VARM2"
    });
    socket.close();
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(value: unknown): void { this.sent.push(value); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
}
