import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ApiKeyRepository } from "../domain/interfaces.js";
import type { ApiKey } from "../domain/types.js";

interface ApiKeyRow {
  id: string;
  user_id: string;
  username: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export class SqliteApiKeyRepository implements ApiKeyRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async create(input: Omit<ApiKey, "id"> & { id?: string }): Promise<ApiKey> {
    const key = { ...input, id: input.id ?? nanoid(12) };
    this.db
      .prepare(
        `insert into api_keys (
          id, user_id, username, name, prefix, key_hash, created_at, last_used_at
        ) values (
          @id, @userId, @username, @name, @prefix, @keyHash, @createdAt, @lastUsedAt
        )`
      )
      .run(toSqlParams(key));
    return cloneApiKey(key);
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const row = this.db.prepare("select * from api_keys where id = ?").get(id) as ApiKeyRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async listForUser(userId: string): Promise<ApiKey[]> {
    const rows = this.db.prepare("select * from api_keys where user_id = ? order by created_at asc, id asc").all(userId) as ApiKeyRow[];
    return rows.map(fromRow);
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const result = this.db.prepare("delete from api_keys where id = ? and user_id = ?").run(id, userId);
    return result.changes > 0;
  }

  async touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void> {
    this.db.prepare("update api_keys set last_used_at = ? where id = ?").run(lastUsedAt.toISOString(), id);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists api_keys (
        id text primary key,
        user_id text,
        username text not null,
        name text not null,
        prefix text not null,
        key_hash text not null,
        created_at text not null,
        last_used_at text
      );

      create index if not exists idx_api_keys_username_created_at
        on api_keys(username, created_at);
    `);
    const columns = this.db.prepare("pragma table_info(api_keys)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "user_id")) this.db.exec("alter table api_keys add column user_id text");
  }
}

function toSqlParams(key: ApiKey) {
  return {
    id: key.id,
    userId: key.userId,
    username: key.username,
    name: key.name,
    prefix: key.prefix,
    keyHash: key.keyHash,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null
  };
}

function fromRow(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined
  };
}

function cloneApiKey(key: ApiKey): ApiKey {
  return {
    ...key,
    createdAt: new Date(key.createdAt),
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : undefined
  };
}
