import { buildApp } from "./app.js";
import { loadConfig } from "./config/loadConfig.js";

const { config, models } = await loadConfig();
const { app, reconciler, trafficPoller, bootstrapRuntimeModels } = await buildApp(config, models);
trafficPoller?.start(config.litellmTrafficPollSeconds);
await app.listen({ port: config.port, host: "0.0.0.0" });
void bootstrapRuntimeModels().finally(() => {
  reconciler.start(config.reconcilerIntervalSeconds);
});
