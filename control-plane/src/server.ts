import { buildApp } from "./app.js";
import { loadConfig, loadStorageConfig, resolveStorageOperationLockPath } from "./config/loadConfig.js";
import { StorageOperationLock } from "./repository/StorageOperationLock.js";

const storageLock = await StorageOperationLock.acquire(
  resolveStorageOperationLockPath(loadStorageConfig(), process.env.STORAGE_OPERATION_LOCK_PATH),
  "neuron-app"
);

try {
  const { config, models } = await loadConfig();
  const shutdownRequest: { current?: (reason: string) => void } = {};
  const { app, reconciler, trafficPoller, bootstrapRuntimeModels } = await buildApp(config, models, {
    requestShutdown: (reason) => shutdownRequest.current?.(reason)
  });
  let shuttingDown = false;
  app.addHook("onClose", async () => {
    shuttingDown = true;
    reconciler.stop();
    trafficPoller?.stop();
    await storageLock.release();
  });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down control plane");
    reconciler.stop();
    trafficPoller?.stop();
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
  shutdownRequest.current = (reason) => void shutdown(reason);

  if (config.maintenanceMode) {
    app.log.warn({ storageDriver: config.storage.driver }, "control plane is running in maintenance mode; provider and reconciliation loops are disabled");
  } else {
    trafficPoller?.start(config.litellmTrafficPollSeconds);
    void bootstrapRuntimeModels().finally(() => {
      if (!shuttingDown) reconciler.start(config.reconcilerIntervalSeconds);
    });
  }
} catch (error) {
  await storageLock.release();
  throw error;
}
