import type pg from "pg";
import type { AssistantConfigRepository } from "../domain/interfaces.js";
import type { AssistantConfig } from "../domain/types.js";
import { cloneAssistantConfig } from "./assistantConfigUtils.js";

interface AssistantRow {
  id: string;
  target_id: string;
  model_id: string;
  reservation_minutes: number;
  keepalive_minutes: number;
  request_timeout_seconds: number;
  additional_instructions: string | null;
  updated_at: Date | string;
}

export class PostgresAssistantConfigRepository implements AssistantConfigRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<AssistantConfig | undefined> {
    const result = await this.pool.query<AssistantRow>("select * from assistant_config where id = 'default'");
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async save(input: Omit<AssistantConfig, "id" | "updatedAt"> & { updatedAt?: Date }): Promise<AssistantConfig> {
    const config: AssistantConfig = { ...input, id: "default", updatedAt: input.updatedAt ?? new Date() };
    await this.pool.query(`
      insert into assistant_config (id, target_id, model_id, reservation_minutes, keepalive_minutes, request_timeout_seconds, additional_instructions, updated_at)
      values ('default', $1, $2, $3, $4, $5, $6, $7)
      on conflict(id) do update set
        target_id=excluded.target_id,
        model_id=excluded.model_id,
        reservation_minutes=excluded.reservation_minutes,
        keepalive_minutes=excluded.keepalive_minutes,
        request_timeout_seconds=excluded.request_timeout_seconds,
        additional_instructions=excluded.additional_instructions,
        updated_at=excluded.updated_at
    `, [config.targetId, config.modelId, config.reservationMinutes, config.keepaliveMinutes, config.requestTimeoutSeconds, config.additionalInstructions ?? null, config.updatedAt]);
    return cloneAssistantConfig(config);
  }

  async clear(): Promise<boolean> {
    const result = await this.pool.query("delete from assistant_config where id = 'default'");
    return (result.rowCount ?? 0) > 0;
  }
}

function fromRow(row: AssistantRow): AssistantConfig {
  return {
    id: "default",
    targetId: row.target_id,
    modelId: row.model_id,
    reservationMinutes: row.reservation_minutes,
    keepaliveMinutes: row.keepalive_minutes,
    requestTimeoutSeconds: row.request_timeout_seconds,
    additionalInstructions: row.additional_instructions ?? undefined,
    updatedAt: new Date(row.updated_at)
  };
}
