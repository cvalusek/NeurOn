import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AuthMethodRepository } from "../domain/interfaces.js";
import type { AuthMethod, AuthMethodType } from "../domain/types.js";

interface AuthMethodRow {
  id: string;
  display_name: string;
  type: string;
  enabled: number;
  config_json: string;
}

export class SqliteAuthMethodRepository implements AuthMethodRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async create(input: AuthMethod): Promise<AuthMethod> {
    this.db
      .prepare("insert into auth_methods (id, display_name, type, enabled, config_json) values (@id, @displayName, @type, @enabled, @configJson)")
      .run(toSqlParams(input));
    return cloneAuthMethod(input);
  }

  async get(id: string): Promise<AuthMethod | undefined> {
    const row = this.db.prepare("select * from auth_methods where id = ?").get(id) as AuthMethodRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(): Promise<AuthMethod[]> {
    const rows = this.db.prepare("select * from auth_methods order by display_name asc, id asc").all() as AuthMethodRow[];
    return rows.map(fromRow);
  }

  async update(id: string, input: AuthMethod): Promise<AuthMethod> {
    const result = this.db
      .prepare("update auth_methods set id = @id, display_name = @displayName, type = @type, enabled = @enabled, config_json = @configJson where id = @previousId")
      .run({ ...toSqlParams(input), previousId: id });
    if (result.changes === 0) throw new Error(`Auth method not found: ${id}`);
    return cloneAuthMethod(input);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("delete from auth_methods where id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists auth_methods (
        id text primary key,
        display_name text not null,
        type text not null,
        enabled integer not null,
        config_json text not null
      );
    `);
  }
}

function toSqlParams(method: AuthMethod) {
  return {
    id: method.id,
    displayName: method.displayName,
    type: method.type,
    enabled: method.enabled ? 1 : 0,
    configJson: JSON.stringify(method.config)
  };
}

function fromRow(row: AuthMethodRow): AuthMethod {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type as AuthMethodType,
    enabled: Boolean(row.enabled),
    config: JSON.parse(row.config_json) as AuthMethod["config"]
  };
}

function cloneAuthMethod(method: AuthMethod): AuthMethod {
  return JSON.parse(JSON.stringify(method)) as AuthMethod;
}
