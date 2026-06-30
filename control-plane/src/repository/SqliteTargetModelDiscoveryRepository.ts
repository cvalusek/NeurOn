import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TargetModelDiscoveryRepository } from "../domain/interfaces.js";
import type { TargetModelDiscoveryRecord } from "../domain/types.js";
import { cloneTargetModelDiscoveryRecord, targetModelDiscoveryRecordFromJson } from "./targetModelDiscoveryUtils.js";

interface DiscoveryRow {
  target_id: string;
  discovery_json: string;
  discovered_at: string;
}

export class SqliteTargetModelDiscoveryRepository implements TargetModelDiscoveryRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async record(input: TargetModelDiscoveryRecord): Promise<TargetModelDiscoveryRecord> {
    this.db
      .prepare(
        `
        insert into target_model_discoveries (target_id, discovery_json, discovered_at)
        values (?, ?, ?)
        on conflict(target_id) do update set
          discovery_json = excluded.discovery_json,
          discovered_at = excluded.discovered_at
      `
      )
      .run(input.targetId, JSON.stringify(input), input.discoveredAt.toISOString());
    return cloneTargetModelDiscoveryRecord(input);
  }

  async get(targetId: string): Promise<TargetModelDiscoveryRecord | undefined> {
    const row = this.db.prepare("select * from target_model_discoveries where target_id = ?").get(targetId) as DiscoveryRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(): Promise<TargetModelDiscoveryRecord[]> {
    const rows = this.db.prepare("select * from target_model_discoveries order by target_id asc").all() as DiscoveryRow[];
    return rows.map(fromRow);
  }

  async delete(targetId: string): Promise<boolean> {
    return this.db.prepare("delete from target_model_discoveries where target_id = ?").run(targetId).changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists target_model_discoveries (
        target_id text primary key,
        discovery_json text not null,
        discovered_at text not null
      );
    `);
  }
}

function fromRow(row: DiscoveryRow): TargetModelDiscoveryRecord {
  return targetModelDiscoveryRecordFromJson(row.discovery_json);
}
