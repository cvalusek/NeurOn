import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { ModelFavorite } from "../domain/types.js";

interface Row { username: string; target_id: string; model_id: string; created_at: string; }
export class SqliteModelFavoriteRepository implements ModelFavoriteRepository {
  private readonly db: Database.Database;
  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath); this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON");
    this.db.exec("create table if not exists model_favorites (username text not null, target_id text not null, model_id text not null, created_at text not null, primary key(username, target_id, model_id)); create index if not exists idx_model_favorites_username on model_favorites(username, created_at);");
  }
  async listForUser(username: string): Promise<ModelFavorite[]> { return (this.db.prepare("select * from model_favorites where username=? order by created_at, target_id, model_id").all(username) as Row[]).map(fromRow); }
  async add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite> {
    const createdAt = input.createdAt ?? new Date();
    this.db.prepare("insert into model_favorites (username, target_id, model_id, created_at) values (?, ?, ?, ?) on conflict(username, target_id, model_id) do nothing").run(input.username, input.targetId, input.modelId, createdAt.toISOString());
    const row = this.db.prepare("select * from model_favorites where username=? and target_id=? and model_id=?").get(input.username, input.targetId, input.modelId) as Row;
    return fromRow(row);
  }
  async remove(username: string, targetId: string, modelId: string): Promise<boolean> { return this.db.prepare("delete from model_favorites where username=? and target_id=? and model_id=?").run(username, targetId, modelId).changes > 0; }
  close(): void { this.db.close(); }
}
function fromRow(row: Row): ModelFavorite { return { username: row.username, targetId: row.target_id, modelId: row.model_id, createdAt: new Date(row.created_at) }; }
