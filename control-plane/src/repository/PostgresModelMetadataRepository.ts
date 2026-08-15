import type pg from "pg";
import type { ModelMetadataRepository } from "../domain/interfaces.js";
import type { ModelCapabilityMetadata, ModelDeploymentMetadata, StoredModelCapabilityMetadata, StoredModelDeploymentMetadata } from "../domain/types.js";
import { storedCapability, storedDeployment } from "./modelMetadataUtils.js";

interface MetadataRow { metadata_json: ModelCapabilityMetadata | ModelDeploymentMetadata | string; updated_at: Date | string; }
export class PostgresModelMetadataRepository implements ModelMetadataRepository {
  constructor(private readonly pool: pg.Pool) {}
  async listCapabilities(): Promise<StoredModelCapabilityMetadata[]> {
    const result = await this.pool.query<MetadataRow>("select metadata_json, updated_at from model_capability_metadata order by model_id");
    return result.rows.map((row) => storedCapability(parse<ModelCapabilityMetadata>(row.metadata_json), new Date(row.updated_at)));
  }
  async listDeployments(): Promise<StoredModelDeploymentMetadata[]> {
    const result = await this.pool.query<MetadataRow>("select metadata_json, updated_at from model_deployment_metadata order by target_id, model_id");
    return result.rows.map((row) => storedDeployment(parse<ModelDeploymentMetadata>(row.metadata_json as ModelDeploymentMetadata | string), new Date(row.updated_at)));
  }
  async upsertCapability(input: ModelCapabilityMetadata, updatedAt = new Date()): Promise<StoredModelCapabilityMetadata> {
    await this.pool.query("insert into model_capability_metadata (model_id, metadata_json, updated_at) values ($1,$2::jsonb,$3) on conflict(model_id) do update set metadata_json=excluded.metadata_json, updated_at=excluded.updated_at", [input.modelId, JSON.stringify(input), updatedAt]);
    return storedCapability(input, updatedAt);
  }
  async upsertDeployment(input: ModelDeploymentMetadata, updatedAt = new Date()): Promise<StoredModelDeploymentMetadata> {
    await this.pool.query("insert into model_deployment_metadata (target_id, model_id, metadata_json, updated_at) values ($1,$2,$3::jsonb,$4) on conflict(target_id,model_id) do update set metadata_json=excluded.metadata_json, updated_at=excluded.updated_at", [input.targetId, input.modelId, JSON.stringify(input), updatedAt]);
    return storedDeployment(input, updatedAt);
  }
  async deleteCapability(modelId: string): Promise<boolean> { return (await this.pool.query("delete from model_capability_metadata where model_id=$1", [modelId])).rowCount !== 0; }
  async deleteDeployment(targetId: string, modelId: string): Promise<boolean> { return (await this.pool.query("delete from model_deployment_metadata where target_id=$1 and model_id=$2", [targetId, modelId])).rowCount !== 0; }
}
function parse<T>(value: T | string): T { return typeof value === "string" ? JSON.parse(value) as T : value; }
