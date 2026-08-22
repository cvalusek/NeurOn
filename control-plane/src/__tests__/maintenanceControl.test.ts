import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaintenanceControl, MaintenanceControl } from "../services/MaintenanceControl.js";

describe("maintenance control", () => {
  it("uses deployment configuration until an administrator stores an override", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-maintenance-"));
    const statePath = path.join(directory, "maintenance.json");
    const initial = await loadMaintenanceControl(statePath, true, false);
    const control = new MaintenanceControl(statePath, initial);

    expect(control.status()).toMatchObject({ effectiveMode: true, configuredMode: true, restartRequired: false });
    await control.requestMode(false, "admin", new Date("2026-08-22T22:00:00Z"));
    expect(control.status()).toMatchObject({ effectiveMode: true, overrideMode: false, updatedBy: "admin", restartRequired: true });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      schemaVersion: 1,
      maintenanceMode: false,
      updatedAt: "2026-08-22T22:00:00.000Z",
      updatedBy: "admin"
    });

    await expect(loadMaintenanceControl(statePath, true, false)).resolves.toMatchObject({
      effectiveMode: false,
      configuredMode: true,
      overrideMode: false,
      restartRequired: false
    });
  });

  it("fails closed for invalid state and honors a forced deployment gate", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-maintenance-"));
    const statePath = path.join(directory, "maintenance.json");
    await writeFile(statePath, "not json", "utf8");
    await expect(loadMaintenanceControl(statePath, false, false)).resolves.toMatchObject({ effectiveMode: true, stateError: expect.stringContaining("failed closed") });

    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, maintenanceMode: false, updatedAt: "2026-08-22T22:00:00.000Z", updatedBy: "admin" }), "utf8");
    const forced = await loadMaintenanceControl(statePath, false, true);
    const control = new MaintenanceControl(statePath, forced);
    expect(control.status()).toMatchObject({ effectiveMode: true, forced: true, overrideMode: false });
    await expect(control.requestMode(false, "admin")).rejects.toThrow("forced by deployment configuration");
  });
});
