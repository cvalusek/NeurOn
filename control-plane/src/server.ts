import { buildApp } from "./app.js";
import { loadConfig } from "./config/loadConfig.js";
import { StorageOperationLock } from "./repository/StorageOperationLock.js";

const storageLock = await StorageOperationLock.acquire(
  process.env.STORAGE_OPERATION_LOCK_PATH ?? "data/neuron-storage.lock",
  "neuron-app"
);

try {
  const { config, models } = await loadConfig();
  const { app, reconciler, trafficPoller, bootstrapRuntimeModels } = await buildApp(config, models);
  app.addHook("onClose", async () => storageLock.release());
  await app.listen({ port: config.port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down control plane");
    try {
      await app.close();
    } catch (error) {
      app.log.error({ error }, "control plane shutdown failed");
      process.exitCode = 1;
      await storageLock.release().catch(() => undefined);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (config.maintenanceMode) {
    app.log.warn({ storageDriver: config.storage.driver }, "control plane is running in maintenance mode; provider and reconciliation loops are disabled");
  } else {
    trafficPoller?.start(config.litellmTrafficPollSeconds);
    void bootstrapRuntimeModels().finally(() => {
      reconciler.start(config.reconcilerIntervalSeconds);
    });
  }
} catch (error) {
  await storageLock.release();
  throw error;
}
