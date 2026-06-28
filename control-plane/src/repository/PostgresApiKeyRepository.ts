import { nanoid } from "nanoid";
import pg from "pg";
import type { ApiKeyRepository } from "../domain/interfaces.js";
import type { ApiKey } from "../domain/types.js";

const { Pool } = pg;

interface ApiKeyRow {
  id: string;
  username: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
}

export class PostgresApiKeyRepository implements ApiKeyRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists api_keys (
        id text primary key,
        username text not null,
        name text not null,
        prefix text not null,
        key_hash text not null,
        created_at timestamptz not null,
        last_used_at timestamptz
      );

      create index if not exists idx_api_keys_username_created_at
        on api_keys(username, created_at);
    `);
  }

  async create(input: Omit<ApiKey, "id"> & { id?: string }): Promise<ApiKey> {
    const key = { ...input, id: input.id ?? nanoid(12) };
    await this.pool.query(
      `insert into api_keys (
        id, username, name, prefix, key_hash, created_at, last_used_at
      ) values ($1, $2, $3, $4, $5, $6, $7)`,
      toSqlValues(key)
    );
    return cloneApiKey(key);
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const result = await this.pool.query<ApiKeyRow>("select * from api_keys where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listForUser(username: string): Promise<ApiKey[]> {
    const result = await this.pool.query<ApiKeyRow>("select * from api_keys where username = $1 order by created_at asc, id asc", [username]);
    return result.rows.map(fromRow);
  }

  async deleteForUser(id: string, username: string): Promise<boolean> {
    const result = await this.pool.query("delete from api_keys where id = $1 and username = $2", [id, username]);
    return (result.rowCount ?? 0) > 0;
  }

  async touchLastUsedAt(id: string, lastUsedAt: Date): Promise<void> {
    await this.pool.query("update api_keys set last_used_at = $1 where id = $2", [lastUsedAt, id]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSqlValues(key: ApiKey): unknown[] {
  return [key.id, key.username, key.name, key.prefix, key.keyHash, key.createdAt, key.lastUsedAt ?? null];
}

function fromRow(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
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
