import pg from "pg";
import type { TargetModelDiscoveryRepository } from "../domain/interfaces.js";
import type { TargetModelDiscoveryRecord } from "../domain/types.js";
import { cloneTargetModelDiscoveryRecord, targetModelDiscoveryRecordFromJson } from "./targetModelDiscoveryUtils.js";

interface DiscoveryRow {
  target_id: string;
  discovery_json: TargetModelDiscoveryRecord | string;
  discovered_at: Date | string;
}

export class PostgresTargetModelDiscoveryRepository implements TargetModelDiscoveryRepository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async record(input: TargetModelDiscoveryRecord): Promise<TargetModelDiscoveryRecord> {
    await this.pool.query(
      `
      insert into target_model_discoveries (target_id, discovery_json, discovered_at)
      values ($1, $2::jsonb, $3)
      on conflict(target_id) do update set
        discovery_json = excluded.discovery_json,
        discovered_at = excluded.discovered_at
    `,
      [input.targetId, JSON.stringify(input), input.discoveredAt]
    );
    return cloneTargetModelDiscoveryRecord(input);
  }

  async get(targetId: string): Promise<TargetModelDiscoveryRecord | undefined> {
    const result = await this.pool.query<DiscoveryRow>("select * from target_model_discoveries where target_id = $1", [targetId]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<TargetModelDiscoveryRecord[]> {
    const result = await this.pool.query<DiscoveryRow>("select * from target_model_discoveries order by target_id asc");
    return result.rows.map(fromRow);
  }

  async delete(targetId: string): Promise<boolean> {
    const result = await this.pool.query("delete from target_model_discoveries where target_id = $1", [targetId]);
    return (result.rowCount ?? 0) > 0;
  }

}

function fromRow(row: DiscoveryRow): TargetModelDiscoveryRecord {
  return targetModelDiscoveryRecordFromJson(row.discovery_json);
}
