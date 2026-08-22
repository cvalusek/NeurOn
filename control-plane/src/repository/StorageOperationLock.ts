import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export class StorageOperationLock {
  private released = false;
  private readonly heartbeat: NodeJS.Timeout;

  private constructor(
    readonly lockPath: string,
    private readonly token: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
    heartbeatIntervalMs: number
  ) {
    this.heartbeat = setInterval(() => {
      const now = new Date();
      void this.handle.utimes(now, now).catch(() => undefined);
    }, heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  static async acquire(
    lockPath: string,
    owner: string,
    options: { staleAfterMs?: number; heartbeatIntervalMs?: number } = {}
  ): Promise<StorageOperationLock> {
    const resolved = path.resolve(lockPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const token = randomUUID();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= staleAfterMs) {
      throw new Error("Storage operation lock timing is invalid");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(resolved, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ owner, token, acquiredAt: new Date().toISOString() }), "utf8");
          await handle.sync();
          return new StorageOperationLock(resolved, token, handle, heartbeatIntervalMs);
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(resolved).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await inspectExistingLock(resolved);
        if (!existing) continue;
        if (Date.now() - existing.lastHeartbeatAt < staleAfterMs) {
          throw new Error(`Storage operation lock already exists: ${resolved}. Refusing concurrent application or migration access.`);
        }
        const displacedPath = `${resolved}.stale-${token}`;
        try {
          await rename(resolved, displacedPath);
          await unlink(displacedPath).catch(() => undefined);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(`Storage operation lock is stale but could not be recovered: ${resolved}`);
        }
      }
    }
    throw new Error(`Storage operation lock changed while it was being acquired: ${resolved}`);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.heartbeat);
    await this.handle.close().catch(() => undefined);
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const lock = JSON.parse(raw) as { token?: string };
      if (lock.token === this.token) await unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function inspectExistingLock(lockPath: string): Promise<{ lastHeartbeatAt: number } | undefined> {
  try {
    const [raw, metadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const parsed = JSON.parse(raw) as { acquiredAt?: string };
    const acquiredAt = parsed.acquiredAt ? Date.parse(parsed.acquiredAt) : Number.NaN;
    return { lastHeartbeatAt: Math.max(metadata.mtimeMs, Number.isFinite(acquiredAt) ? acquiredAt : 0) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    try {
      const metadata = await stat(lockPath);
      return { lastHeartbeatAt: metadata.mtimeMs };
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw statError;
    }
  }
}
