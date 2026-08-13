import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildApp } from "../src/app.js";
import type { AppConfig, CapacityTarget, ModelDefinition } from "../src/domain/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "docs", "images");
const previousFakeProvider = process.env.USE_FAKE_PROVIDER;

process.env.USE_FAKE_PROVIDER = "true";
const demoTarget: CapacityTarget = {
  id: "prefer-smol",
  displayName: "PreFer Smol",
  provider: "docker",
  providerId: "docker-docs",
  modelIds: ["qwen-smol"],
  healthUrl: "http://docs.invalid/health",
  costEstimate: { hourlyUsd: 12 }
};
const demoModels: ModelDefinition[] = [{
  id: "qwen-smol",
  displayName: "Qwen Smol",
  aliases: ["qwen-smol"],
  contextLabel: "256k",
  contextWindowTokens: 256_000,
  targetIds: [demoTarget.id]
}];
const demoConfig: AppConfig = {
  port: 0,
  sharedPassword: "docs-demo-password",
  cookieSecret: "docs-demo-cookie-secret",
  storage: { driver: "memory" },
  awsRegion: "us-east-1",
  litellmTrafficPollSeconds: 0,
  litellmTrafficLookbackSeconds: 300,
  modelSelectionCatalog: {
    schemaVersion: 1,
    models: [{
      modelId: "qwen-smol",
      intelligence: 84,
      domains: { coding: 91, reasoning: 86 },
      provenance: { source: "Synthetic documentation fixture", version: "1" }
    }],
    deployments: [{
      targetId: "prefer-smol",
      modelId: "qwen-smol",
      contextWindowTokens: 256_000,
      quantization: { format: "FP8", qualityRetentionPercent: 98.7, reference: "Synthetic reference" },
      performance: { decodeTokensPerSecond: 78, prefillTokensPerSecond: 1_240, timeToFirstTokenSeconds: 0.42 },
      provenance: { source: "Synthetic documentation fixture", version: "1" }
    }]
  },
  capacityProviders: [{ id: "docker-docs", displayName: "Docker", type: "docker", config: {} }],
  capacityTargets: [demoTarget],
  reconcilerIntervalSeconds: 15,
  reservationStatusPollSeconds: 5,
  adminStatusPollSeconds: 5,
  healthCheckTimeoutSeconds: 1,
  healthCheckIntervalSeconds: 15,
  adminUsers: ["docs-user"],
  authMethods: [],
  updates: { enabled: false, repository: "cvalusek/NeurOn", checkIntervalSeconds: 900 }
};
const built = await buildApp(demoConfig, demoModels);
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(outputDirectory, { recursive: true });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const address = built.app.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine documentation preview address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 1 });

  await page.goto(baseUrl);
  await page.getByLabel("Username").fill("docs-user");
  await page.getByLabel("Password").fill("docs-demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Shared model capacity without paying for idle time" }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "welcome.png"), fullPage: true });

  await page.getByRole("button", { name: "Create your first profile" }).click();
  const modal = page.locator("#profile-modal");
  await modal.getByLabel("Name").fill("Daily coding");
  await modal.getByLabel("Description").fill("PreFer Smol for quick coding and review");
  await page.screenshot({ path: path.join(outputDirectory, "profile-create.png"), fullPage: true });

  await modal.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("heading", { name: "Start capacity" }).waitFor();
  await page.locator('[data-duration="15"]').click();
  await page.getByRole("button", { name: "Reserve capacity" }).click();
  await built.reconciler.reconcile();
  await page.reload();
  await page.locator("#current-reservation").getByText("active", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "home-reservation.png"), fullPage: true });
} finally {
  await browser.close();
  await built.app.close();
  if (previousFakeProvider === undefined) delete process.env.USE_FAKE_PROVIDER;
  else process.env.USE_FAKE_PROVIDER = previousFakeProvider;
}
