import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CapacityProviderRepository } from "../domain/interfaces.js";
import type { CapacityProviderDefinition } from "../domain/types.js";
import { cloneProvider } from "./InMemoryCapacityProviderRepository.js";

interface ProviderRow {
  id: string;
  display_name: string;
  type: string;
  provisioning_enabled: number | null;
  config: string | null;
  credential_id: string | null;
}

export class SqliteCapacityProviderRepository implements CapacityProviderRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async create(input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    this.db
      .prepare("insert into capacity_providers (id, display_name, type, provisioning_enabled, config, credential_id) values (@id, @displayName, @type, @provisioningEnabled, @config, @credentialId)")
      .run(toSqlParams(input));
    return cloneProvider(input);
  }

  async get(id: string): Promise<CapacityProviderDefinition | undefined> {
    const row = this.db.prepare("select * from capacity_providers where id = ?").get(id) as ProviderRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(): Promise<CapacityProviderDefinition[]> {
    const rows = this.db.prepare("select * from capacity_providers order by display_name asc, id asc").all() as ProviderRow[];
    return rows.map(fromRow);
  }

  async update(id: string, input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    const result = this.db
      .prepare("update capacity_providers set id = @id, display_name = @displayName, type = @type, provisioning_enabled = @provisioningEnabled, config = @config, credential_id = @credentialId where id = @previousId")
      .run({ ...toSqlParams(input), previousId: id });
    if (result.changes === 0) throw new Error(`Provider not found: ${id}`);
    return cloneProvider(input);
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("delete from capacity_providers where id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists capacity_providers (
        id text primary key,
        display_name text not null,
        type text not null,
        provisioning_enabled integer not null default 0,
        config text,
        credential_id text
      );
    `);
    const columns = this.db.prepare("pragma table_info(capacity_providers)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "provisioning_enabled")) {
      this.db.exec("alter table capacity_providers add column provisioning_enabled integer not null default 0");
    }
  }
}

function toSqlParams(provider: CapacityProviderDefinition) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    type: provider.type,
    provisioningEnabled: provider.provisioning?.enabled ? 1 : 0,
    config: provider.config ? JSON.stringify(provider.config) : null,
    credentialId: provider.credentialId ?? null
  };
}

function fromRow(row: ProviderRow): CapacityProviderDefinition {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type,
    provisioning: { enabled: Boolean(row.provisioning_enabled) },
    config: row.config ? JSON.parse(row.config) as CapacityProviderDefinition["config"] : undefined,
    credentialId: row.credential_id ?? undefined
  };
}
