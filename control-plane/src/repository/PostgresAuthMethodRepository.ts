import pg from "pg";
import type { AuthMethodRepository } from "../domain/interfaces.js";
import type { AuthMethod, AuthMethodType } from "../domain/types.js";

const { Pool } = pg;

interface AuthMethodRow {
  id: string;
  display_name: string;
  type: string;
  enabled: boolean;
  config_json: AuthMethod["config"] | string;
}

export class PostgresAuthMethodRepository implements AuthMethodRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists auth_methods (
        id text primary key,
        display_name text not null,
        type text not null,
        enabled boolean not null,
        config_json jsonb not null
      );
    `);
  }

  async create(input: AuthMethod): Promise<AuthMethod> {
    await this.pool.query("insert into auth_methods (id, display_name, type, enabled, config_json) values ($1, $2, $3, $4, $5)", toSqlValues(input));
    return cloneAuthMethod(input);
  }

  async get(id: string): Promise<AuthMethod | undefined> {
    const result = await this.pool.query<AuthMethodRow>("select * from auth_methods where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<AuthMethod[]> {
    const result = await this.pool.query<AuthMethodRow>("select * from auth_methods order by display_name asc, id asc");
    return result.rows.map(fromRow);
  }

  async update(id: string, input: AuthMethod): Promise<AuthMethod> {
    const result = await this.pool.query("update auth_methods set id = $1, display_name = $2, type = $3, enabled = $4, config_json = $5 where id = $6", [...toSqlValues(input), id]);
    if ((result.rowCount ?? 0) === 0) throw new Error(`Auth method not found: ${id}`);
    return cloneAuthMethod(input);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from auth_methods where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSqlValues(method: AuthMethod): unknown[] {
  return [method.id, method.displayName, method.type, method.enabled, method.config];
}

function fromRow(row: AuthMethodRow): AuthMethod {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type as AuthMethodType,
    enabled: row.enabled,
    config: typeof row.config_json === "string" ? JSON.parse(row.config_json) as AuthMethod["config"] : row.config_json
  };
}

function cloneAuthMethod(method: AuthMethod): AuthMethod {
  return JSON.parse(JSON.stringify(method)) as AuthMethod;
}
