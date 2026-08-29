import type { AssistantConfigRepository } from "../domain/interfaces.js";
import type { AssistantConfig } from "../domain/types.js";
import { parseAssistantAudioConfig } from "../services/assistantAudioConfig.js";
import { cloneAssistantConfig } from "./assistantConfigUtils.js";

export class InMemoryAssistantConfigRepository implements AssistantConfigRepository {
  private config?: AssistantConfig;

  async get(): Promise<AssistantConfig | undefined> {
    return this.config ? cloneAssistantConfig(this.config) : undefined;
  }

  async save(input: Omit<AssistantConfig, "id" | "updatedAt"> & { updatedAt?: Date }): Promise<AssistantConfig> {
    this.config = { ...input, audio: parseAssistantAudioConfig(input.audio), id: "default", updatedAt: input.updatedAt ?? new Date() };
    return cloneAssistantConfig(this.config);
  }

  async clear(): Promise<boolean> {
    const existed = Boolean(this.config);
    this.config = undefined;
    return existed;
  }
}
