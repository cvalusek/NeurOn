import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export class StorageOperationLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    private readonly token: string,
    private readonly handle: Awaited<ReturnType<typeof open>>
  ) {}

  static async acquire(lockPath: string, owner: string): Promise<StorageOperationLock> {
    const resolved = path.resolve(lockPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const token = randomUUID();
    try {
      const handle = await open(resolved, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ owner, token, acquiredAt: new Date().toISOString() }), "utf8");
      await handle.sync();
      return new StorageOperationLock(resolved, token, handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Storage operation lock already exists: ${resolved}. Refusing concurrent application or migration access.`);
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
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
