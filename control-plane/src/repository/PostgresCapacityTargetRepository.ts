import pg from "pg";
import type { CapacityTargetRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";
import { cloneTarget } from "./targetRepositoryUtils.js";

interface TargetRow {
  id: string;
  target_json: CapacityTarget | string;
}

export class PostgresCapacityTargetRepository implements CapacityTargetRepository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async create(input: CapacityTarget): Promise<CapacityTarget> {
    await this.pool.query("insert into capacity_targets (id, target_json) values ($1, $2::jsonb)", [input.id, JSON.stringify(input)]);
    return cloneTarget(input);
  }

  async get(id: string): Promise<CapacityTarget | undefined> {
    const result = await this.pool.query<TargetRow>("select * from capacity_targets where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<CapacityTarget[]> {
    const result = await this.pool.query<TargetRow>("select * from capacity_targets order by id asc");
    return result.rows.map(fromRow).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async update(id: string, input: CapacityTarget): Promise<CapacityTarget> {
    const result = await this.pool.query("update capacity_targets set id = $1, target_json = $2::jsonb where id = $3", [input.id, JSON.stringify(input), id]);
    if (result.rowCount === 0) throw new Error(`Target not found: ${id}`);
    return cloneTarget(input);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from capacity_targets where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

}

function fromRow(row: TargetRow): CapacityTarget {
  return typeof row.target_json === "string" ? JSON.parse(row.target_json) as CapacityTarget : row.target_json;
}
