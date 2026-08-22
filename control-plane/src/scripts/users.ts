import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStorageConfig, resolveStorageOperationLockPath } from "../config/loadConfig.js";
import { createReservationRepository } from "../repository/createReservationRepository.js";
import { StorageOperationLock } from "../repository/StorageOperationLock.js";
import { IdentityService } from "../services/IdentityService.js";

interface Arguments {
  username: string;
  baseUrl: URL;
  expiresInMinutes: number;
  lockPath?: string;
  applicationStopped: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args.applicationStopped) throw new Error("Refusing user administration without --confirm-application-stopped");
  const storage = loadStorageConfig();
  if (storage.driver === "memory") throw new Error("Offline user administration requires SQLite or PostgreSQL storage");
  const lockPath = resolveLockPath(args.lockPath, storage);
  const lock = await StorageOperationLock.acquire(lockPath, "users:create-owner-link");
  try {
    const repositories = await createReservationRepository(storage);
    try {
      const identities = new IdentityService(repositories.identities);
      const existing = await repositories.identities.getUserByUsername(args.username);
      const created = await identities.createInvitation(undefined, {
        userId: existing?.id,
        intendedUsername: existing ? undefined : args.username,
        initialRoleId: "role_owner",
        expiresInMinutes: args.expiresInMinutes,
        maxUses: 1
      });
      const registrationUrl = new URL("/register", args.baseUrl);
      registrationUrl.hash = `token=${created.token}`;
      process.stdout.write(`${JSON.stringify({
        outcome: existing ? "owner-claim-link-created" : "owner-registration-link-created",
        username: args.username,
        expiresAt: created.invitation.expiresAt.toISOString(),
        registrationUrl: registrationUrl.toString(),
        note: "The registration URL is shown once. Copy it now; NeurOn stores only its hash."
      }, null, 2)}\n`);
    } finally {
      await repositories.close();
    }
  } finally {
    await lock.release();
  }
}

function parseArguments(values: string[]): Arguments {
  const [command, ...rest] = values;
  if (command !== "create-owner-link") throw new Error("Usage: users create-owner-link --username <name> --base-url <url> [--expires-minutes <minutes>] [--lock-path <path>] --confirm-application-stopped");
  const options = new Map<string, string>();
  let applicationStopped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--confirm-application-stopped") { applicationStopped = true; continue; }
    const value = rest[index + 1];
    if (!name.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid user administration argument: ${name}`);
    if (options.has(name)) throw new Error(`Duplicate user administration argument: ${name}`);
    options.set(name, value);
    index += 1;
  }
  for (const name of options.keys()) if (!["--username", "--base-url", "--expires-minutes", "--lock-path"].includes(name)) throw new Error(`Unknown user administration argument: ${name}`);
  const username = options.get("--username")?.trim();
  if (!username || username.length > 120) throw new Error("--username is required and must be 120 characters or fewer");
  const baseUrl = new URL(options.get("--base-url") ?? "");
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error("--base-url must be an HTTP(S) URL without credentials");
  const expiresInMinutes = Number(options.get("--expires-minutes") ?? "60");
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 5 || expiresInMinutes > 43_200) throw new Error("--expires-minutes must be between 5 and 43200");
  return {
    username,
    baseUrl,
    expiresInMinutes,
    lockPath: options.get("--lock-path") ? path.resolve(options.get("--lock-path")!) : undefined,
    applicationStopped
  };
}

function resolveLockPath(explicitPath: string | undefined, storage: ReturnType<typeof loadStorageConfig>): string {
  return resolveStorageOperationLockPath(storage, explicitPath ?? process.env.STORAGE_OPERATION_LOCK_PATH);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : "User administration failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
