import type pg from "pg";
import type { ModelFavoriteRepository } from "../domain/interfaces.js";
import type { ModelFavorite } from "../domain/types.js";

interface Row { user_id: string; username: string; target_id: string; model_id: string; created_at: Date | string; }
export class PostgresModelFavoriteRepository implements ModelFavoriteRepository {
  constructor(private readonly pool: pg.Pool) {}
  async listForUser(userId: string): Promise<ModelFavorite[]> { return (await this.pool.query<Row>("select * from model_favorites where user_id=$1 order by created_at,target_id,model_id", [userId])).rows.map(fromRow); }
  async add(input: Omit<ModelFavorite, "createdAt"> & { createdAt?: Date }): Promise<ModelFavorite> {
    const createdAt = input.createdAt ?? new Date();
    const result = await this.pool.query<Row>("insert into model_favorites (user_id,username,target_id,model_id,created_at) values ($1,$2,$3,$4,$5) on conflict(user_id,target_id,model_id) do update set username=excluded.username returning *", [input.userId, input.username, input.targetId, input.modelId, createdAt]);
    return fromRow(result.rows[0]);
  }
  async remove(userId: string, targetId: string, modelId: string): Promise<boolean> { return (await this.pool.query("delete from model_favorites where user_id=$1 and target_id=$2 and model_id=$3", [userId, targetId, modelId])).rowCount !== 0; }
}
function fromRow(row: Row): ModelFavorite { return { userId: row.user_id, username: row.username, targetId: row.target_id, modelId: row.model_id, createdAt: new Date(row.created_at) }; }
