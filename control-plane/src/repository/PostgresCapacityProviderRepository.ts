import pg from "pg";
import type { CapacityProviderRepository } from "../domain/interfaces.js";
import type { CapacityProviderDefinition } from "../domain/types.js";
import { cloneProvider } from "./InMemoryCapacityProviderRepository.js";

const { Pool } = pg;

interface ProviderRow {
  id: string;
  display_name: string;
  type: string;
  provisioning_enabled: boolean | null;
  config: Record<string, unknown> | string | null;
  credential_id: string | null;
}

export class PostgresCapacityProviderRepository implements CapacityProviderRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists capacity_providers (
        id text primary key,
        display_name text not null,
        type text not null,
        provisioning_enabled boolean not null default false,
        config jsonb,
        credential_id text
      );
    `);
    await this.pool.query("alter table capacity_providers add column if not exists provisioning_enabled boolean not null default false");
  }

  async create(input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    await this.pool.query(
      "insert into capacity_providers (id, display_name, type, provisioning_enabled, config, credential_id) values ($1, $2, $3, $4, $5::jsonb, $6)",
      toSqlValues(input)
    );
    return cloneProvider(input);
  }

  async get(id: string): Promise<CapacityProviderDefinition | undefined> {
    const result = await this.pool.query<ProviderRow>("select * from capacity_providers where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<CapacityProviderDefinition[]> {
    const result = await this.pool.query<ProviderRow>("select * from capacity_providers order by display_name asc, id asc");
    return result.rows.map(fromRow);
  }

  async update(id: string, input: CapacityProviderDefinition): Promise<CapacityProviderDefinition> {
    const result = await this.pool.query(
      "update capacity_providers set id = $1, display_name = $2, type = $3, provisioning_enabled = $4, config = $5::jsonb, credential_id = $6 where id = $7",
      [...toSqlValues(input), id]
    );
    if (result.rowCount === 0) throw new Error(`Provider not found: ${id}`);
    return cloneProvider(input);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from capacity_providers where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSqlValues(provider: CapacityProviderDefinition): unknown[] {
  return [
    provider.id,
    provider.displayName,
    provider.type,
    provider.provisioning?.enabled ?? false,
    provider.config ? JSON.stringify(provider.config) : null,
    provider.credentialId ?? null
  ];
}

function fromRow(row: ProviderRow): CapacityProviderDefinition {
  const config = typeof row.config === "string" ? JSON.parse(row.config) as CapacityProviderDefinition["config"] : row.config as CapacityProviderDefinition["config"];
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type,
    provisioning: { enabled: Boolean(row.provisioning_enabled) },
    config: config ?? undefined,
    credentialId: row.credential_id ?? undefined
  };
}
