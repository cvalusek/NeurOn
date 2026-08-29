import { z } from "zod";
import type { AssistantAudioConfig, AssistantVoiceReference } from "../domain/types.js";

export const ASSISTANT_VOICE_REFERENCE_MAX_BYTES = 5_242_880;
export const ASSISTANT_VOICE_REFERENCE_MAX_ENCODED_CHARACTERS = 6_994_604;
export const ASSISTANT_STT_MAX_BYTES = 32 * 1024 * 1024;

export const CUSTOM_VOICE_IDS = [
  "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"
] as const;

export const PERSONAPLEX_VOICE_IDS = [
  "NATF0", "NATF1", "NATF2", "NATF3",
  "NATM0", "NATM1", "NATM2", "NATM3",
  "VARF0", "VARF1", "VARF2", "VARF3", "VARF4",
  "VARM0", "VARM1", "VARM2", "VARM3", "VARM4"
] as const;

const bindingFields = {
  targetId: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(500),
  requestTimeoutSeconds: z.number().int().min(1).max(600).optional()
};

const voiceReferenceSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.literal("audio/wav"),
  dataBase64: z.string().min(1).max(ASSISTANT_VOICE_REFERENCE_MAX_ENCODED_CHARACTERS),
  referenceText: z.string().trim().min(1).max(4_000)
}).strict();

const ttsVoiceSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("packaged"),
    voiceId: z.enum(CUSTOM_VOICE_IDS),
    instructions: z.string().trim().max(2_000).optional()
  }).strict(),
  z.object({ mode: z.literal("reference"), reference: voiceReferenceSchema }).strict()
]);

export const assistantAudioConfigSchema = z.object({
  stt: z.object(bindingFields).strict().optional(),
  tts: z.object({
    ...bindingFields,
    voice: ttsVoiceSchema
  }).strict().optional(),
  realtime: z.object({
    ...bindingFields,
    voiceId: z.enum(PERSONAPLEX_VOICE_IDS).default("NATF2"),
    instructions: z.string().trim().min(1).max(4_000),
    sampleRate: z.literal(24_000).default(24_000)
  }).strict().optional()
}).strict();

export const assistantAudioUpdateSchema = z.object({
  stt: z.object(bindingFields).strict().optional(),
  tts: z.object({
    ...bindingFields,
    voice: z.union([
      ttsVoiceSchema,
      z.object({
        mode: z.literal("reference"),
        keepExisting: z.literal(true),
        referenceText: z.string().trim().min(1).max(4_000).optional()
      }).strict()
    ])
  }).strict().optional(),
  realtime: z.object({
    ...bindingFields,
    voiceId: z.enum(PERSONAPLEX_VOICE_IDS).default("NATF2"),
    instructions: z.string().trim().min(1).max(4_000),
    sampleRate: z.literal(24_000).default(24_000)
  }).strict().optional()
}).strict();

export type AssistantAudioUpdate = z.infer<typeof assistantAudioUpdateSchema>;

export function parseAssistantAudioConfig(value: unknown): AssistantAudioConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = assistantAudioConfigSchema.parse(value);
  if (parsed.tts?.voice?.mode === "reference") decodeAssistantVoiceReference(parsed.tts.voice.reference);
  return parsed;
}

export function mergeAssistantAudioUpdate(update: AssistantAudioUpdate, existing: AssistantAudioConfig | undefined): AssistantAudioConfig {
  if (update.tts?.voice.mode !== "reference" || !("keepExisting" in update.tts.voice)) return update as AssistantAudioConfig;
  const currentReference = existing?.tts?.voice.mode === "reference" ? existing.tts.voice.reference : undefined;
  if (!currentReference) throw new Error("Upload a WAV reference voice before selecting reference cloning");
  return {
    ...update,
    tts: {
      ...update.tts,
      voice: {
        mode: "reference",
        reference: {
          ...currentReference,
          referenceText: update.tts.voice.referenceText ?? currentReference.referenceText
        }
      }
    }
  };
}

export function decodeAssistantVoiceReference(reference: AssistantVoiceReference): Buffer {
  const data = reference.dataBase64;
  if (data.length > ASSISTANT_VOICE_REFERENCE_MAX_ENCODED_CHARACTERS) throw new Error("Assistant reference voice exceeds the encoded size limit");
  if (!isStandardBase64(data)) {
    throw new Error("Assistant reference voice must use standard base64");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.length > ASSISTANT_VOICE_REFERENCE_MAX_BYTES) throw new Error("Assistant reference voice exceeds the 5 MiB decoded limit");
  assertRiffWave(decoded, ASSISTANT_VOICE_REFERENCE_MAX_BYTES, "Assistant reference voice");
  return decoded;
}

function isStandardBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const accepted = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!accepted) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return false;
  return padding === 0 ? contentLength % 4 === 0 : padding === 1 ? contentLength % 4 === 3 : contentLength % 4 === 2;
}

export function assertRiffWave(value: Buffer, maximumBytes: number, label: string): void {
  if (value.length === 0 || value.length > maximumBytes) throw new Error(`${label} exceeds the accepted WAV size`);
  if (value.length < 12 || value.subarray(0, 4).toString("ascii") !== "RIFF" || value.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error(`${label} must be a nonempty RIFF/WAVE file`);
  }
}
