import { buildHassleOffApp } from "./app.js";
import { loadHassleOffConfig } from "./config.js";

const config = loadHassleOffConfig();
const { app, startWatchdog } = buildHassleOffApp(config);
startWatchdog();
await app.listen({ port: config.port, host: "0.0.0.0" });
