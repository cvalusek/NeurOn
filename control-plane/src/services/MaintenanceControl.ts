import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppConfig } from "../domain/types.js";

const maintenanceStateSchema = z.object({
  schemaVersion: z.literal(1),
  maintenanceMode: z.boolean(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().trim().min(1).max(200)
});

export interface MaintenanceControlStatus {
  effectiveMode: boolean;
  configuredMode: boolean;
  forced: boolean;
  overrideMode?: boolean;
  updatedAt?: string;
  updatedBy?: string;
  stateError?: string;
  restartRequired: boolean;
}

export async function loadMaintenanceControl(
  statePath: string,
  configuredMode: boolean,
  forced: boolean
): Promise<MaintenanceControlStatus> {
  try {
    const stored = maintenanceStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    const effectiveMode = forced ? true : stored.maintenanceMode;
    return {
      effectiveMode,
      configuredMode,
      forced,
      overrideMode: stored.maintenanceMode,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      restartRequired: false
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { effectiveMode: forced || configuredMode, configuredMode, forced, restartRequired: false };
    }
    return {
      effectiveMode: true,
      configuredMode,
      forced,
      stateError: "The maintenance control file is invalid; NeurOn failed closed in maintenance mode.",
      restartRequired: false
    };
  }
}

export class MaintenanceControl {
  private statusValue: MaintenanceControlStatus;

  constructor(
    private readonly statePath: string | undefined,
    initial: MaintenanceControlStatus
  ) {
    this.statusValue = { ...initial };
  }

  static fromConfig(config: AppConfig): MaintenanceControl {
    if (!config.maintenanceControl) throw new Error("Maintenance control configuration is unavailable");
    return new MaintenanceControl(config.maintenanceControl.statePath, {
      effectiveMode: Boolean(config.maintenanceMode),
      configuredMode: config.maintenanceControl.configuredMode,
      forced: config.maintenanceControl.forced,
      overrideMode: config.maintenanceControl.overrideMode,
      updatedAt: config.maintenanceControl.updatedAt,
      updatedBy: config.maintenanceControl.updatedBy,
      stateError: config.maintenanceControl.stateError,
      restartRequired: false
    });
  }

  static transient(effectiveMode: boolean): MaintenanceControl {
    return new MaintenanceControl(undefined, {
      effectiveMode,
      configuredMode: effectiveMode,
      forced: false,
      restartRequired: false
    });
  }

  status(): MaintenanceControlStatus {
    return { ...this.statusValue };
  }

  async requestMode(maintenanceMode: boolean, updatedBy: string, now = new Date()): Promise<MaintenanceControlStatus> {
    if (!maintenanceMode && this.statusValue.forced) {
      throw new Error("Maintenance mode is forced by deployment configuration and cannot be disabled in the application");
    }
    const record = maintenanceStateSchema.parse({
      schemaVersion: 1,
      maintenanceMode,
      updatedAt: now.toISOString(),
      updatedBy
    });
    if (this.statePath) {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.${nanoid(8)}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryPath, this.statePath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    this.statusValue = {
      ...this.statusValue,
      overrideMode: maintenanceMode,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      stateError: undefined,
      restartRequired: maintenanceMode !== this.statusValue.effectiveMode
    };
    return this.status();
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
