import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AssistantConfigRepository } from "../domain/interfaces.js";
import type { AssistantConfig } from "../domain/types.js";
import { assistantConfigFromLegacyTarget, cloneAssistantConfig, withoutLegacyAssistant } from "./assistantConfigUtils.js";

interface AssistantRow {
  id: string;
  target_id: string;
  model_id: string;
  reservation_minutes: number;
  keepalive_minutes: number;
  request_timeout_seconds: number;
  additional_instructions: string | null;
  updated_at: string;
}

export class SqliteAssistantConfigRepository implements AssistantConfigRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async get(): Promise<AssistantConfig | undefined> {
    const row = this.db.prepare("select * from assistant_config where id = 'default'").get() as AssistantRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async save(input: Omit<AssistantConfig, "id" | "updatedAt"> & { updatedAt?: Date }): Promise<AssistantConfig> {
    const config: AssistantConfig = { ...input, id: "default", updatedAt: input.updatedAt ?? new Date() };
    this.db.prepare(`
      insert into assistant_config (id, target_id, model_id, reservation_minutes, keepalive_minutes, request_timeout_seconds, additional_instructions, updated_at)
      values ('default', ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        target_id=excluded.target_id,
        model_id=excluded.model_id,
        reservation_minutes=excluded.reservation_minutes,
        keepalive_minutes=excluded.keepalive_minutes,
        request_timeout_seconds=excluded.request_timeout_seconds,
        additional_instructions=excluded.additional_instructions,
        updated_at=excluded.updated_at
    `).run(config.targetId, config.modelId, config.reservationMinutes, config.keepaliveMinutes, config.requestTimeoutSeconds, config.additionalInstructions ?? null, config.updatedAt.toISOString());
    return cloneAssistantConfig(config);
  }

  async clear(): Promise<boolean> {
    return this.db.prepare("delete from assistant_config where id = 'default'").run().changes > 0;
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec(`
        create table if not exists assistant_config (
          id text primary key check (id = 'default'),
          target_id text not null,
          model_id text not null,
          reservation_minutes integer not null check (reservation_minutes between 1 and 720),
          keepalive_minutes integer not null check (keepalive_minutes between 1 and 60),
          request_timeout_seconds integer not null check (request_timeout_seconds between 1 and 600),
          additional_instructions text,
          updated_at text not null
        );
      `);
      const assistantColumns = new Set((this.db.prepare("pragma table_info(assistant_config)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!assistantColumns.has("additional_instructions")) this.db.exec("alter table assistant_config add column additional_instructions text");
      const targetTable = this.db.prepare("select 1 from sqlite_master where type='table' and name='capacity_targets'").get();
      if (!targetTable) return;
      const rows = this.db.prepare("select id, target_json from capacity_targets order by id").all() as Array<{ id: string; target_json: string }>;
      const legacy = rows.flatMap((row) => {
        const target = JSON.parse(row.target_json) as unknown;
        const config = assistantConfigFromLegacyTarget(target, row.id);
        return config ? [{ row, target, config }] : [];
      });
      if (legacy.length > 1) throw new Error("More than one legacy target contains assistant configuration");
      const existing = this.db.prepare("select * from assistant_config where id = 'default'").get() as AssistantRow | undefined;
      if (!existing && legacy[0]?.config) {
        const config = legacy[0].config;
        this.db.prepare("insert into assistant_config (id, target_id, model_id, reservation_minutes, keepalive_minutes, request_timeout_seconds, additional_instructions, updated_at) values ('default', ?, ?, ?, ?, ?, null, ?)")
          .run(config.targetId, config.modelId, config.reservationMinutes, config.keepaliveMinutes, config.requestTimeoutSeconds, config.updatedAt.toISOString());
      } else if (existing && legacy[0]?.config) {
        const config = legacy[0].config;
        if (existing.target_id !== config.targetId || existing.model_id !== config.modelId) throw new Error("Stored and legacy assistant configuration disagree");
      }
      for (const entry of legacy) {
        this.db.prepare("update capacity_targets set target_json = ? where id = ?").run(JSON.stringify(withoutLegacyAssistant(entry.target)), entry.row.id);
      }
    })();
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
