import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { StorageOperationLock } from "../repository/StorageOperationLock.js";
import {
  createConsistentSqliteBackup,
  inspectSqliteForMigration,
  migrateSqliteToPostgres
} from "../repository/sqliteToPostgresMigration.js";

type Command = "inspect" | "backup" | "migrate";

interface Arguments {
  command: Command;
  sqlitePath: string;
  backupDirectory?: string;
  databaseUrlEnv: string;
  lockPath: string;
  applicationStopped: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args.applicationStopped) {
    throw new Error("Refusing storage access without --confirm-application-stopped");
  }

  const lock = await StorageOperationLock.acquire(args.lockPath, `sqlite-to-postgres:${args.command}`);
  try {
    const inspection = inspectSqliteForMigration(args.sqlitePath);
    if (args.command === "inspect") {
      printResult({ command: args.command, source: inspection });
      return;
    }
    if (inspection.operationalSafety !== "passed") {
      throw new Error(
        `SQLite source has unsafe live lifecycle state; refusing cutover (activeReservations=${inspection.blockers.activeReservations}, inFlightProvisioningJobs=${inspection.blockers.inFlightProvisioningJobs}, openTargetActivations=${inspection.blockers.openTargetActivations})`
      );
    }

    const backupDirectory = args.backupDirectory;
    if (!backupDirectory) throw new Error(`--backup-dir is required for ${args.command}`);
    const backupPath = await createConsistentSqliteBackup(args.sqlitePath, backupDirectory);
    if (args.command === "backup") {
      printResult({ command: args.command, backupPath, source: inspection, backupVerification: "passed" });
      return;
    }

    const connectionString = process.env[args.databaseUrlEnv];
    if (!connectionString) throw new Error(`Required PostgreSQL connection environment variable is unset: ${args.databaseUrlEnv}`);
    const pool = new pg.Pool({ connectionString, max: 2, application_name: "neuron-sqlite-migration" });
    try {
      const migration = await migrateSqliteToPostgres({ sqlitePath: backupPath, pool });
      printResult({ command: args.command, backupPath, source: inspection, migration });
    } finally {
      await pool.end();
    }
  } finally {
    await lock.release();
  }
}

function parseArguments(values: string[]): Arguments {
  const [commandValue, ...rest] = values;
  if (!isCommand(commandValue)) {
    throw new Error("Usage: migrate-sqlite-to-postgres <inspect|backup|migrate> --sqlite <path> [--backup-dir <path>] [--database-url-env <name>] [--lock-path <path>] --confirm-application-stopped");
  }
  const options = new Map<string, string>();
  let applicationStopped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--confirm-application-stopped") {
      applicationStopped = true;
      continue;
    }
    if (!name.startsWith("--") || index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
      throw new Error(`Invalid migration argument: ${name}`);
    }
    if (options.has(name)) throw new Error(`Duplicate migration argument: ${name}`);
    options.set(name, rest[index + 1]);
    index += 1;
  }

  const sqlitePath = options.get("--sqlite");
  if (!sqlitePath) throw new Error("--sqlite is required");
  const allowed = new Set(["--sqlite", "--backup-dir", "--database-url-env", "--lock-path"]);
  for (const name of options.keys()) if (!allowed.has(name)) throw new Error(`Unknown migration argument: ${name}`);

  const databaseUrlEnv = options.get("--database-url-env") ?? "DATABASE_URL";
  if (!/^[A-Z][A-Z0-9_]*$/.test(databaseUrlEnv)) throw new Error("--database-url-env must name an uppercase environment variable");
  const resolvedSqlitePath = path.resolve(sqlitePath);
  return {
    command: commandValue,
    sqlitePath: resolvedSqlitePath,
    backupDirectory: options.get("--backup-dir") ? path.resolve(options.get("--backup-dir")!) : undefined,
    databaseUrlEnv,
    lockPath: path.resolve(options.get("--lock-path") ?? path.join(path.dirname(resolvedSqlitePath), "neuron-storage.lock")),
    applicationStopped
  };
}

function isCommand(value: string | undefined): value is Command {
  return value === "inspect" || value === "backup" || value === "migrate";
}

function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function safeMigrationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  const safePrefixes = [
    "Refusing ",
    "SQLite ",
    "PostgreSQL schema ",
    "PostgreSQL destination ",
    "Migration identity ",
    "Source and destination ",
    "Backup destination ",
    "Required PostgreSQL ",
    "Storage operation lock ",
    "--",
    "Invalid migration argument",
    "Duplicate migration argument",
    "Unknown migration argument",
    "Usage:"
  ];
  return safePrefixes.some((prefix) => message.startsWith(prefix))
    ? message
    : "Migration failed; PostgreSQL changes were rolled back. No row values were logged.";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${safeMigrationErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
