import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelMetadataRepository } from "../domain/interfaces.js";
import type { ModelCapabilityMetadata, ModelDeploymentMetadata, StoredModelCapabilityMetadata, StoredModelDeploymentMetadata } from "../domain/types.js";
import { storedCapability, storedDeployment } from "./modelMetadataUtils.js";

interface MetadataRow { metadata_json: string; updated_at: string; }

export class SqliteModelMetadataRepository implements ModelMetadataRepository {
  private readonly db: Database.Database;
  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath); this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON"); this.migrate();
  }
  async listCapabilities(): Promise<StoredModelCapabilityMetadata[]> {
    return (this.db.prepare("select metadata_json, updated_at from model_capability_metadata order by model_id").all() as MetadataRow[])
      .map((row) => storedCapability(JSON.parse(row.metadata_json) as ModelCapabilityMetadata, new Date(row.updated_at)));
  }
  async listDeployments(): Promise<StoredModelDeploymentMetadata[]> {
    return (this.db.prepare("select metadata_json, updated_at from model_deployment_metadata order by target_id, model_id").all() as MetadataRow[])
      .map((row) => storedDeployment(JSON.parse(row.metadata_json) as ModelDeploymentMetadata, new Date(row.updated_at)));
  }
  async upsertCapability(input: ModelCapabilityMetadata, updatedAt = new Date()): Promise<StoredModelCapabilityMetadata> {
    this.db.prepare("insert into model_capability_metadata (model_id, metadata_json, updated_at) values (?, ?, ?) on conflict(model_id) do update set metadata_json=excluded.metadata_json, updated_at=excluded.updated_at")
      .run(input.modelId, JSON.stringify(input), updatedAt.toISOString());
    return storedCapability(input, updatedAt);
  }
  async upsertDeployment(input: ModelDeploymentMetadata, updatedAt = new Date()): Promise<StoredModelDeploymentMetadata> {
    this.db.prepare("insert into model_deployment_metadata (target_id, model_id, metadata_json, updated_at) values (?, ?, ?, ?) on conflict(target_id, model_id) do update set metadata_json=excluded.metadata_json, updated_at=excluded.updated_at")
      .run(input.targetId, input.modelId, JSON.stringify(input), updatedAt.toISOString());
    return storedDeployment(input, updatedAt);
  }
  async deleteCapability(modelId: string): Promise<boolean> { return this.db.prepare("delete from model_capability_metadata where model_id=?").run(modelId).changes > 0; }
  async deleteDeployment(targetId: string, modelId: string): Promise<boolean> { return this.db.prepare("delete from model_deployment_metadata where target_id=? and model_id=?").run(targetId, modelId).changes > 0; }
  close(): void { this.db.close(); }
  private migrate(): void { this.db.exec(`
    create table if not exists model_capability_metadata (model_id text primary key, metadata_json text not null, updated_at text not null);
    create table if not exists model_deployment_metadata (target_id text not null, model_id text not null, metadata_json text not null, updated_at text not null, primary key(target_id, model_id));
  `); }
}
