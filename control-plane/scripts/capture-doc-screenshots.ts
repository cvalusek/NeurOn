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
  hostingMode: "dedicated",
  aliasPriority: 10,
  healthUrl: "http://docs.invalid/health",
  costEstimate: { hourlyUsd: 1.25 }
};
const demoAudioTargets: CapacityTarget[] = [
  { id: "prefer-dictation", displayName: "PreFer Dictation", provider: "docker", providerId: "docker-docs", modelIds: ["qwen3-asr-0.6b"], healthUrl: "http://docs.invalid/asr/health", apiUrl: "http://docs.invalid/asr/v1", costEstimate: { hourlyUsd: 0.65 } },
  { id: "prefer-voice", displayName: "PreFer Voice", provider: "docker", providerId: "docker-docs", modelIds: ["qwen3-tts-1.7b-customvoice"], healthUrl: "http://docs.invalid/tts/health", apiUrl: "http://docs.invalid/tts/v1", costEstimate: { hourlyUsd: 0.85 } },
  { id: "prefer-live-voice", displayName: "PreFer Live Voice", provider: "docker", providerId: "docker-docs", modelIds: ["personaplex-7b-v1"], healthUrl: "http://docs.invalid/live/health", apiUrl: "http://docs.invalid/live/v1", costEstimate: { hourlyUsd: 1.6 } }
];
const demoModels: ModelDefinition[] = [{
  id: "qwen-smol",
  displayName: "Qwen Smol",
  aliases: ["qwen-smol"],
  contextLabel: "256k",
  contextWindowTokens: 256_000,
  technicalCapabilities: [{ label: "tools", title: "Tool calling" }],
  targetIds: [demoTarget.id]
}, {
  id: "qwen3-asr-0.6b",
  displayName: "Qwen3 ASR 0.6B",
  aliases: ["qwen3-asr"],
  technicalCapabilities: [{ label: "speech-to-text", title: "Speech to text" }],
  targetIds: ["prefer-dictation"]
}, {
  id: "qwen3-tts-1.7b-customvoice",
  displayName: "Qwen3 TTS CustomVoice 1.7B",
  aliases: ["qwen3-tts"],
  technicalCapabilities: [{ label: "text-to-speech", title: "Text to speech" }],
  targetIds: ["prefer-voice"]
}, {
  id: "personaplex-7b-v1",
  displayName: "PersonaPlex 7B",
  aliases: ["personaplex"],
  technicalCapabilities: [{ label: "realtime-speech", title: "Real-time speech" }],
  targetIds: ["prefer-live-voice"]
}];
const demoConfig: AppConfig = {
  port: 0,
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
      quantization: { format: "FP8", qualityRetentionPercent: 98.7, reference: "Synthetic reference" },
      provenance: { source: "Synthetic documentation fixture", version: "1" }
    }],
    deployments: [{
      targetId: "prefer-smol",
      modelId: "qwen-smol",
      performance: { decodeTokensPerSecond: 78, prefillTokensPerSecond: 1_240, timeToFirstTokenSeconds: 0.42 },
      provenance: { source: "Synthetic documentation fixture", version: "1" }
    }]
  },
  runtimeProfiles: [
    {
      id: "prefer",
      name: "PreFer llama.cpp",
      type: "docker",
      image: "ghcr.io/cvalusek/prefer:latest",
      volumes: { "/models": "prefer-model-cache" },
      catalog: { pluginId: "prefer", engine: "llama.cpp", schemaVersion: "prefer.deployment-inventory.v1", repository: "cvalusek/PreFer", inventoryPath: "docker/llama-cpp/deployment-inventory.generated.json", imageRepository: "ghcr.io/cvalusek/prefer" }
    },
    {
      id: "prefer-audio",
      name: "PreFer audio.cpp",
      type: "docker",
      image: "ghcr.io/cvalusek/prefer:audio-cuda12",
      port: 8080,
      health: "/health",
      api: "/v1",
      volumes: { "/models": "prefer-audio-model-cache", "/voices": "prefer-audio-voices" },
      catalog: { pluginId: "prefer", engine: "audio.cpp", schemaVersion: "prefer.audio-deployment-inventory.v1", repository: "cvalusek/PreFer", inventoryPath: "docker/audio-cpp/deployment-inventory.generated.json", imageRepository: "ghcr.io/cvalusek/prefer" }
    }
  ],
  capacityProviders: [
    { id: "docker-docs", displayName: "Docker", type: "docker", config: {} },
    { id: "runpod-docs", displayName: "RunPod", type: "runpod", provisioning: { enabled: true }, config: {} }
  ],
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
const built = await buildApp(demoConfig, demoModels, {
  developmentLocalAccounts: [{ username: "docs-user", password: "docs-demo-password", owner: true }]
});
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(outputDirectory, { recursive: true });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const address = built.app.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine documentation preview address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 1 });
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto(baseUrl);
  await page.getByLabel("Username").fill("docs-user");
  await page.getByLabel("Password").fill("docs-demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto(`${baseUrl}/admin/targets`);
  await page.getByRole("button", { name: "Add target" }).click();
  const targetModal = page.locator("#target-modal");
  await targetModal.getByText("Provision new", { exact: true }).click();
  await targetModal.locator('select[name="providerId"]').selectOption("runpod-docs");
  await targetModal.locator('select[name="runtimeProfileId"]').selectOption("prefer-audio");
  await page.screenshot({ path: path.join(outputDirectory, "target-provisioning.png"), fullPage: true });

  await page.goto(`${baseUrl}/welcome`);
  await page.getByRole("heading", { name: "Shared model capacity without paying for idle time" }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "welcome.png") });

  await page.getByRole("button", { name: "Create your first profile" }).click();
  const modal = page.locator("#profile-modal");
  await modal.getByLabel("Name", { exact: true }).fill("Daily coding");
  await modal.getByLabel("Description").fill("PreFer Smol for quick coding and review");
  await modal.getByLabel("Description").evaluate((element) => (element as HTMLInputElement).blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(outputDirectory, "profile-create.png") });
  await page.getByRole("button", { name: "Ask NeurOn" }).click();
  await page.screenshot({ path: path.join(outputDirectory, "profile-assistant.png") });
  await page.getByRole("button", { name: "Collapse assistant" }).click();
  await modal.getByRole("button", { name: "Help me choose" }).click();
  await page.getByRole("img", { name: /Good, Fast, and Cheap ranking preference/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, "model-selection.png") });

  await modal.getByRole("button", { name: "Review profile" }).click();
  await page.getByRole("button", { name: "Create profile" }).click();
  await page.getByRole("heading", { name: "Start capacity" }).waitFor();
  await page.locator('[data-duration="15"]').click();
  await page.getByRole("button", { name: "Reserve capacity" }).click();
  await built.reconciler.reconcile();
  await page.reload();
  await page.locator("#current-reservation").getByText("active", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "home-reservation.png") });

  await page.goto(`${baseUrl}/client-setup`);
  await page.getByRole("heading", { name: "Connect" }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, "client-setup.png") });

  const assistantSaved = await page.evaluate(async (audioTargets) => {
    for (const target of audioTargets) {
      const response = await fetch("/admin/targets", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          connectionMode: "existing",
          id: target.id,
          displayName: target.displayName,
          providerId: "docker-docs",
          runtimeProfileId: "prefer-audio",
          modelIds: target.modelIds.join(","),
          healthUrl: target.healthUrl ?? "",
          apiUrl: target.apiUrl ?? "",
          dockerContainerName: target.id,
          dockerModelVolume: "prefer-audio-model-cache"
        })
      });
      if (!response.ok) return false;
    }
    const response = await fetch("/api/admin/assistant-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: "prefer-smol",
        modelId: "qwen-smol",
        reservationMinutes: 15,
        keepaliveMinutes: 5,
        requestTimeoutSeconds: 60,
        audio: {
          stt: { targetId: "prefer-dictation", modelId: "qwen3-asr-0.6b" },
          tts: { targetId: "prefer-voice", modelId: "qwen3-tts-1.7b-customvoice", voice: { mode: "packaged", voiceId: "Vivian", instructions: "Warm, concise, conversational" } },
          realtime: { targetId: "prefer-live-voice", modelId: "personaplex-7b-v1", voiceId: "NATF2", instructions: "Help the user understand and configure shared model capacity.", sampleRate: 24000 }
        }
      })
    });
    return response.ok;
  }, demoAudioTargets);
  if (!assistantSaved) throw new Error("Could not seed the isolated documentation Assistant configuration");
  await page.goto(`${baseUrl}/admin/assistant`);
  await page.getByRole("heading", { name: "Assistant", exact: true }).waitFor();
  await page.locator(".profile-save-bar").evaluate((element) => { (element as HTMLElement).style.position = "static"; });
  await page.screenshot({ path: path.join(outputDirectory, "assistant-config.png"), fullPage: true });
  if (pageErrors.length > 0) throw new Error(`Documentation UI raised browser errors: ${pageErrors.map((error) => error.message).join(" | ")}`);
} finally {
  await browser.close();
  await built.app.close();
  if (previousFakeProvider === undefined) delete process.env.USE_FAKE_PROVIDER;
  else process.env.USE_FAKE_PROVIDER = previousFakeProvider;
}
