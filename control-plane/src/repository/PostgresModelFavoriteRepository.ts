import type pg from "pg";
import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { ModelFavorite } from "../domain/types.js";

interface Row { username: string; target_id: string; model_id: string; created_at: Date | string; }
export class PostgresModelFavoriteRepository implements ModelFavoriteRepository {
  constructor(private readonly pool: pg.Pool) {}
  async listForUser(username: string): Promise<ModelFavorite[]> { return (await this.pool.query<Row>("select * from model_favorites where username=$1 order by created_at,target_id,model_id", [username])).rows.map(fromRow); }
  async add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite> {
    const createdAt = input.createdAt ?? new Date();
    const result = await this.pool.query<Row>("insert into model_favorites (username,target_id,model_id,created_at) values ($1,$2,$3,$4) on conflict(username,target_id,model_id) do update set username=excluded.username returning *", [input.username, input.targetId, input.modelId, createdAt]);
    return fromRow(result.rows[0]);
  }
  async remove(username: string, targetId: string, modelId: string): Promise<boolean> { return (await this.pool.query("delete from model_favorites where username=$1 and target_id=$2 and model_id=$3", [username, targetId, modelId])).rowCount !== 0; }
}
function fromRow(row: Row): ModelFavorite { return { username: row.username, targetId: row.target_id, modelId: row.model_id, createdAt: new Date(row.created_at) }; }
