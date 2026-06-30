import pg from "pg";
import type { TargetProvisioningJobRepository } from "../domain/interfaces.js";
import type { TargetProvisioningJob } from "../domain/types.js";
import { cloneTargetProvisioningJob, targetProvisioningJobFromJson } from "./targetProvisioningJobUtils.js";

const { Pool } = pg;

interface JobRow {
  id: string;
  target_id: string;
  job_json: TargetProvisioningJob | string;
}

export class PostgresTargetProvisioningJobRepository implements TargetProvisioningJobRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      create table if not exists target_creation_jobs (
        id text primary key,
        target_id text not null,
        job_json jsonb not null
      );
      create index if not exists idx_target_creation_jobs_target_id
        on target_creation_jobs(target_id);
    `);
  }

  async create(input: TargetProvisioningJob): Promise<TargetProvisioningJob> {
    await this.pool.query("insert into target_creation_jobs (id, target_id, job_json) values ($1, $2, $3::jsonb)", [input.id, input.targetId, JSON.stringify(input)]);
    return cloneTargetProvisioningJob(input);
  }

  async get(id: string): Promise<TargetProvisioningJob | undefined> {
    const result = await this.pool.query<JobRow>("select * from target_creation_jobs where id = $1", [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async getForTarget(targetId: string): Promise<TargetProvisioningJob | undefined> {
    const result = await this.pool.query<JobRow>("select * from target_creation_jobs where target_id = $1 order by id desc limit 1", [targetId]);
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<TargetProvisioningJob[]> {
    const result = await this.pool.query<JobRow>("select * from target_creation_jobs order by id asc");
    return result.rows.map(fromRow).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async update(id: string, patch: Partial<TargetProvisioningJob>): Promise<TargetProvisioningJob> {
    const current = await this.get(id);
    if (!current) throw new Error(`Target provisioning job not found: ${id}`);
    const updated = { ...current, ...patch, id, updatedAt: patch.updatedAt ?? new Date() };
    await this.pool.query("update target_creation_jobs set target_id = $1, job_json = $2::jsonb where id = $3", [updated.targetId, JSON.stringify(updated), id]);
    return cloneTargetProvisioningJob(updated);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function fromRow(row: JobRow): TargetProvisioningJob {
  return targetProvisioningJobFromJson(row.job_json);
}
