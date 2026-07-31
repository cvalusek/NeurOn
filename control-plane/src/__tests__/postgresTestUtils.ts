import pg from "pg";
import { nanoid } from "nanoid";

export const postgresTestUrl = process.env.TEST_DATABASE_URL;

export async function createPostgresTestSchema(): Promise<{
  schema: string;
  connectionString: string;
  pool: pg.Pool;
  cleanup(): Promise<void>;
}> {
  if (!postgresTestUrl) throw new Error("TEST_DATABASE_URL is required");
  const schema = `neuron_test_${nanoid(12).replace(/-/g, "_").toLowerCase()}`;
  const admin = new pg.Pool({ connectionString: postgresTestUrl, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({
    connectionString: postgresTestUrl,
    max: 4,
    options: `-c search_path=${schema}`
  });
  return {
    schema,
    connectionString: withSearchPath(postgresTestUrl, schema),
    pool,
    cleanup: async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  };
}

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
