import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CapacityTargetRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";
import { cloneTarget } from "./targetRepositoryUtils.js";

interface TargetRow {
  id: string;
  target_json: string;
}

export class SqliteCapacityTargetRepository implements CapacityTargetRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async create(input: CapacityTarget): Promise<CapacityTarget> {
    this.db.prepare("insert into capacity_targets (id, target_json) values (?, ?)").run(input.id, JSON.stringify(input));
    return cloneTarget(input);
  }

  async get(id: string): Promise<CapacityTarget | undefined> {
    const row = this.db.prepare("select * from capacity_targets where id = ?").get(id) as TargetRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(): Promise<CapacityTarget[]> {
    const rows = this.db.prepare("select * from capacity_targets order by id asc").all() as TargetRow[];
    return rows.map(fromRow).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async update(id: string, input: CapacityTarget): Promise<CapacityTarget> {
    const result = this.db.prepare("update capacity_targets set id = ?, target_json = ? where id = ?").run(input.id, JSON.stringify(input), id);
    if (result.changes === 0) throw new Error(`Target not found: ${id}`);
    return cloneTarget(input);
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("delete from capacity_targets where id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists capacity_targets (
        id text primary key,
        target_json text not null
      );
    `);
  }
}

function fromRow(row: TargetRow): CapacityTarget {
  return JSON.parse(row.target_json) as CapacityTarget;
}
