import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TargetProvisioningJobRepository } from "../domain/interfaces.js";
import type { TargetProvisioningJob } from "../domain/types.js";
import { cloneTargetProvisioningJob, targetProvisioningJobFromJson } from "./targetProvisioningJobUtils.js";

interface JobRow {
  id: string;
  target_id: string;
  job_json: string;
}

export class SqliteTargetProvisioningJobRepository implements TargetProvisioningJobRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  async create(input: TargetProvisioningJob): Promise<TargetProvisioningJob> {
    this.db.prepare("insert into target_creation_jobs (id, target_id, job_json) values (?, ?, ?)").run(input.id, input.targetId, JSON.stringify(input));
    return cloneTargetProvisioningJob(input);
  }

  async get(id: string): Promise<TargetProvisioningJob | undefined> {
    const row = this.db.prepare("select * from target_creation_jobs where id = ?").get(id) as JobRow | undefined;
    return row ? targetProvisioningJobFromJson(row.job_json) : undefined;
  }

  async getForTarget(targetId: string): Promise<TargetProvisioningJob | undefined> {
    const row = this.db.prepare("select * from target_creation_jobs where target_id = ? order by id desc limit 1").get(targetId) as JobRow | undefined;
    return row ? targetProvisioningJobFromJson(row.job_json) : undefined;
  }

  async list(): Promise<TargetProvisioningJob[]> {
    const rows = this.db.prepare("select * from target_creation_jobs order by id asc").all() as JobRow[];
    return rows.map((row) => targetProvisioningJobFromJson(row.job_json)).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async update(id: string, patch: Partial<TargetProvisioningJob>): Promise<TargetProvisioningJob> {
    const current = await this.get(id);
    if (!current) throw new Error(`Target provisioning job not found: ${id}`);
    const updated = { ...current, ...patch, id, updatedAt: patch.updatedAt ?? new Date() };
    this.db.prepare("update target_creation_jobs set target_id = ?, job_json = ? where id = ?").run(updated.targetId, JSON.stringify(updated), id);
    return cloneTargetProvisioningJob(updated);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists target_creation_jobs (
        id text primary key,
        target_id text not null,
        job_json text not null
      );
      create index if not exists idx_target_creation_jobs_target_id
        on target_creation_jobs(target_id);
    `);
  }
}
