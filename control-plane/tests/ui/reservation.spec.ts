import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/loadConfig.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const targetFile = path.join(rootDir, "examples", "capacity-targets.prefer-smol.json");
const password = "browser-secret";
let app: FastifyInstance;
let baseUrl: string;
let previousEnv: Record<string, string | undefined>;
let reconcile: (now?: Date) => Promise<void>;
let identityService: Awaited<ReturnType<typeof buildApp>>["identityService"];
let markTargetHealthy: () => void;

test.beforeEach(async () => {
  previousEnv = snapshotEnv();
  process.env.USE_FAKE_PROVIDER = "true";
  process.env.CAPACITY_TARGETS_FILE = targetFile;
  process.env.COOKIE_SECRET = "browser-test-cookie-secret";
  process.env.LITELLM_TRAFFIC_POLL_SECONDS = "0";

  const loaded = await loadConfig();
  loaded.config.capacityTargets[0].costEstimate = { hourlyUsd: 12 };
  loaded.config.capacityTargets[0].hostingMode = "dedicated";
  loaded.config.capacityTargets[0].models![0].contextWindowTokens = 32_000;
  loaded.config.capacityTargets[0].models![0].aliases = ["qwen-smol"];
  loaded.config.capacityTargets[0].models![0].technicalCapabilities = [{ label: "tools", title: "Tool calling" }];
  loaded.models[0].contextWindowTokens = 32_000;
  loaded.models[0].aliases = ["qwen-smol"];
  loaded.models[0].technicalCapabilities = [{ label: "tools", title: "Tool calling" }];
  loaded.config.modelSelectionCatalog = {
    schemaVersion: 1,
    models: [{ modelId: "qwen-smol", intelligence: 72, domains: { coding: 84 }, quantization: { format: "Q4_K_M", qualityRetentionPercent: 97, reference: "BF16" }, provenance: { source: "synthetic browser fixture" } }],
    deployments: [{
      targetId: "prefer-smol",
      modelId: "qwen-smol",
      performance: { decodeTokensPerSecond: 55, timeToFirstTokenSeconds: 0.8, sampleCount: 20 },
      provenance: { source: "synthetic browser fixture" }
    }]
  };
  const built = await buildApp(loaded.config, loaded.models);
  identityService = built.identityService;
  app = built.app;
  app.log.level = "silent";
  reconcile = (now?: Date) => built.reconciler.reconcile(now);
  const statuses = Reflect.get(built.reconciler, "statuses") as { set(status: { targetId: string; desired: "on"; observed: "healthy"; message: string }): void };
  markTargetHealthy = () => statuses.set({ targetId: "prefer-smol", desired: "on", observed: "healthy", message: "Ready" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async ({ page }, testInfo) => {
  // Keep the interaction timeout meaningful while giving browser/server teardown
  // its own allowance on slower operator workstations.
  testInfo.setTimeout(testInfo.timeout + 30_000);
  try {
    await page.close({ runBeforeUnload: false });
    // The app pages poll status. Once the page is closed, terminate any HTTP
    // keep-alive sockets left behind by Chromium before asking Fastify to close.
    app?.server.closeIdleConnections();
    app?.server.closeAllConnections();
    await app?.close();
  } finally {
    restoreEnv(previousEnv);
  }
});

test("requires sign-in before showing protected pages", async ({ page }) => {
  await createTestAccount("ui-user");
  await page.goto(`${baseUrl}/api-keys`);

  await expect(page).toHaveURL(`${baseUrl}/login`);
  await page.getByLabel("Username").fill("ui-user");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid username or password")).toBeVisible();

  await page.getByLabel("Username").fill("ui-user");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseUrl}/welcome`);
  await expect(page.locator("header")).toContainText("ui-user");
});

test("creates, extends, and ends a reservation from the rendered UI", async ({ page }) => {
  await signIn(page, "ui-user");
  await createSmolProfile(page);

  await expect(page.getByRole("heading", { name: "Start capacity" })).toBeVisible();
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
  await expect(page.locator("#start-form")).toContainText("PreFer Smol");
  await expect(page.locator("#start-form")).toContainText("qwen-smol");
  await expect(page.locator("#start-cost-estimate")).toContainText("Estimated cost: $0.80");
  await expect(page.getByRole("link", { name: "Open direct model host" })).toHaveCount(0);

  await page.locator('[aria-label="Duration"]').getByRole("button", { name: "5 min", exact: true }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("5");
  await expect(page.locator("#start-cost-estimate")).toContainText("Estimated cost: $1.40");
  await page.getByRole("button", { name: "Reserve" }).click();

  await expect(page.locator("#current-reservation")).toContainText("ui-user");
  await expect(page.locator("#current-reservation")).toContainText("active");
  await expect(page.locator("#current-reservation")).toContainText("PreFer Smol");
  await expect(page.locator("#current-reservation")).toContainText("qwen-smol");
  await expect(page.locator("#current-reservation")).toContainText("LiteLLM");
  await expect(page.locator("#current-reservation")).toContainText("Direct model host");
  await expect(page.locator("#current-reservation")).toContainText("Use");
  await expect(page.locator("#current-reservation").getByRole("link", { name: "Connect" })).toHaveText("↗");
  await expect(page.locator("#current-reservation").getByRole("link", { name: "Open direct model host" })).toHaveCount(0);
  markTargetHealthy();
  await page.reload();
  await expect(page.locator("#current-reservation").getByRole("link", { name: "Open direct model host" })).toHaveAttribute("href", "http://host.docker.internal:8080/");
  await expect(page.locator("#server-status")).toContainText("Users: ui-user");

  await page.locator("#current-reservation").getByRole("button", { name: "+1 min", exact: true }).click();
  await expect(page.locator("#current-reservation")).toContainText("active");

  await page.locator("#current-reservation").getByRole("button", { name: "I'm done" }).click();
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
  await expect(page.locator("#server-status")).not.toContainText("Users: ui-user");
});

test("supports custom reservation duration and keepalive controls", async ({ page }) => {
  await signIn(page, "custom-user");
  await createSmolProfile(page);

  await page.locator('[data-custom-duration="true"]').click();
  await expect(page.locator("#custom-duration-wrap")).toBeVisible();
  await page.locator("#custom-duration").fill("7");
  await expect(page.locator("#duration-minutes")).toHaveValue("7");

  await page.locator('[data-custom-keepalive="true"]').click();
  await expect(page.locator("#custom-keepalive-wrap")).toBeVisible();
  await page.locator("#custom-keepalive").fill("4");
  await expect(page.locator("#keepalive-minutes")).toHaveValue("4");
  await expect(page.locator("#start-cost-estimate")).toContainText("Estimated cost: $2.20");

  await page.getByRole("button", { name: "Reserve" }).click();

  await expect(page.locator("#current-reservation")).toContainText("custom-user");
  await expect(page.locator("#current-reservation")).toContainText("active");
});

test("guides users without profiles into profile creation", async ({ page }) => {
  await signIn(page, "validation-user");
  await expect(page.getByRole("heading", { name: "Shared model capacity without paying for idle time" })).toBeVisible();
  await page.getByRole("button", { name: "Create your first profile" }).click();
  await expect(page).toHaveURL(/\/profiles\/new\?onboarding=1$/);
  await expect(page.locator("#profile-modal")).toBeVisible();
});

test("filters and recommends target-model deployments in the profile builder", async ({ page }) => {
  await signIn(page, "selection-user");
  await page.getByRole("button", { name: "Create your first profile" }).click();
  const modal = page.locator("#profile-modal");

  await expect(modal.locator(".target-price")).toContainText("$12.00/hr");
  await expect(modal.locator("[data-deployment-key='prefer-smol::qwen-smol']")).toContainText("Intelligence 72");
  await expect(modal.locator("[data-deployment-key='prefer-smol::qwen-smol']")).toContainText("Decode 55 t/s");
  await expect(modal.locator("[data-deployment-key='prefer-smol::qwen-smol']")).toContainText("Tools");
  await expect(modal.locator("[data-profile-fit-score]")).toContainText("Fit 91");
  await expect(modal.getByRole("button", { name: "Browse & filter" })).toHaveAttribute("aria-pressed", "true");
  await expect(modal.locator("#profile-wizard")).toBeHidden();
  await modal.locator("#profile-model-search").fill("tools qwen");
  await expect(modal.locator("#profile-filter-status")).toContainText("1 of 1");
  await modal.locator("#profile-model-search").fill("not-in-the-catalog");
  await expect(modal.locator("#profile-filter-status")).toContainText("0 of 1");
  await expect(modal.locator("[data-profile-model]")).toBeChecked();
  await expect(modal.locator("[data-deployment-key='prefer-smol::qwen-smol']")).toHaveClass(/does-not-match/);
  await modal.locator("#profile-model-search").fill("");
  await modal.locator("#profile-model-sort").selectOption("cost");
  await modal.getByRole("button", { name: "Help me choose" }).click();
  await expect(modal.locator("#profile-wizard")).toBeVisible();
  await expect(modal.locator(".triangle-snap")).toHaveCount(7);
  await expect(modal.getByRole("button", { name: /Best fit/ })).toBeVisible();

  await modal.locator("#profile-hosting-mode").selectOption("multi-model");
  await expect(modal.locator("#profile-filter-status")).toContainText("0 of 1");
  await expect(modal.locator("#profile-recommendations")).toContainText("No deployment satisfies");

  await modal.locator("#profile-hosting-mode").selectOption("dedicated");
  await modal.locator("#profile-max-cost").fill("1");
  await expect(modal.locator("#profile-max-cost-output")).toHaveText("$12.00/hr maximum");
  await modal.locator('[data-profile-domain][value="coding"]').check();
  await expect(modal.locator("#profile-filter-status")).toContainText("1 of 1");
  await modal.getByRole("img", { name: /Good, Fast, and Cheap ranking preference/ }).press("ArrowRight");
  await expect(modal.locator("[data-profile-fit-score]")).not.toContainText("Fit 100");
  await modal.getByRole("button", { name: /Best fit/ }).click();
  await expect(modal.locator("[data-profile-model]")).toBeChecked();
  await expect(modal.locator("[data-profile-target]")).toBeChecked();
});

test("keeps the assistant available across the app and sends structured current-screen state", async ({ page }) => {
  const clientErrors: string[] = [];
  page.on("pageerror", (error) => clientErrors.push(error.message));
  await page.route("**/api/profile-advisor/status", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, backend: { targetId: "prefer-smol", modelId: "qwen-smol" } }) }));
  const requestBodies: Record<string, unknown>[] = [];
  let polls = 0;
  const requestId = "9de0942a-364e-4e6c-8b4e-852cf583c7ad";
  await page.route("**/api/profile-advisor/requests", async (route) => {
    requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({
      id: requestId, phase: "waking", message: "The Assistant is sleeping. NeurOn is waking it…",
      conversation: { contextMessage: "[NeurOn browser and user-state snapshot]\n{}", contextSnapshot: { screen: { path: "/profiles/new", surface: "profile_create" } } },
      debug: { startedAt: new Date().toISOString(), initialTargetState: "cold", contextUpdate: "snapshot", historyMessages: 0, historyCharacters: 0, summaryCharacters: 0 }
    }) });
  });
  await page.route("**/api/profile-advisor/requests/**", async (route) => {
    polls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(polls <= 4
      ? { id: requestId, phase: "thinking", message: "The Assistant is awake and thinking…" }
      : { id: requestId, phase: "complete", message: "The Assistant finished.", result: { type: "answer", message: "I can see the profile builder controls." } }) });
  });
  await signIn(page, "assistant-user");
  await page.getByRole("button", { name: "Create your first profile" }).click();
  await expect(page).toHaveURL(/\/profiles\/new\?onboarding=1$/);
  await expect(page.locator("#profile-modal")).toBeVisible();
  expect(clientErrors).toEqual([]);
  await page.getByRole("button", { name: "Ask NeurOn" }).click();
  const assistantInput = page.locator("[data-assistant-form] textarea");
  await assistantInput.fill("What am I configuring on this screen?");
  await assistantInput.press("Shift+Enter");
  await expect(assistantInput).toHaveValue("What am I configuring on this screen?\n");
  await assistantInput.press("Backspace");
  await assistantInput.press("Enter");

  await expect(page.locator("[data-assistant-messages]")).toContainText(/sleeping|thinking/);
  await expect(page.locator(".assistant-spinner")).toBeVisible();
  await expect(page.locator("[data-assistant-messages]")).toContainText("I can see the profile builder controls.");
  expect(requestBodies[0]).toMatchObject({
    request: "What am I configuring on this screen?",
    screen: { path: "/profiles/new", surface: "profile_create", profileRequirements: { domains: [], technicalCapabilities: [], weights: { intelligence: 1 / 3, speed: 1 / 3, cost: 1 / 3 } } },
    currentDraft: { selections: [{ targetId: "prefer-smol", modelIds: ["qwen-smol"] }] }
  });
  expect(JSON.stringify(requestBodies[0])).not.toContain("<main");
  await page.getByRole("button", { name: "Toggle Assistant diagnostics" }).click();
  await expect(page.locator("[data-assistant-debug]")).toContainText("conversationMessages");

  await page.goto(`${baseUrl}/api-keys`);
  await expect(page.locator("[data-assistant-toggle]")).toBeVisible();
  await expect(page.locator("[data-assistant-toggle]")).toHaveText("Assistant open");
  await expect(page.locator("[data-assistant-messages]")).toContainText("I can see the profile builder controls.");
  await page.locator("[data-assistant-form] textarea").fill("What did I just ask?");
  await page.locator("[data-assistant-form] textarea").press("Enter");
  await expect.poll(() => requestBodies.length).toBe(2);
  expect(requestBodies[1]).toMatchObject({ conversation: { history: expect.arrayContaining([
    { role: "user", content: "What am I configuring on this screen?" },
    { role: "assistant", content: "I can see the profile builder controls." }
  ]) } });
  await page.getByRole("button", { name: "Clear assistant chat" }).click();
  await expect(page.locator("[data-assistant-messages]")).not.toContainText("I can see the profile builder controls.");
  await expect(page.locator("[data-assistant-messages]")).toContainText("I will always ask before saving or starting capacity.");
});

test("points to an ordinary navigation link before the assistant follows it", async ({ page }) => {
  const requestId = "c9f0ce96-b2db-4bc8-b14b-6c6398a31b42";
  await page.route("**/api/profile-advisor/status", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));
  await page.route("**/api/profile-advisor/requests", async (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: requestId, phase: "thinking", message: "The Assistant is awake and thinking…" }) }));
  await page.route("**/api/profile-advisor/requests/**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: requestId, phase: "complete", message: "Done", result: { type: "open_page", path: "/profiles", message: "Opening Profiles." } }) }));
  await signIn(page, "guided-navigation-user");
  await page.getByRole("button", { name: "Ask NeurOn" }).click();
  await page.locator("[data-assistant-form] textarea").fill("Show me Profiles");
  await page.locator("[data-assistant-form] textarea").press("Enter");

  const destination = page.locator('a[href="/profiles"]');
  await expect(destination).toHaveClass(/assistant-guided-target/);
  await expect(destination.locator(".assistant-guide-arrow")).toHaveText("→");
  await expect(page).toHaveURL(`${baseUrl}/profiles`);
  await expect(page.locator("[data-assistant-messages]")).toContainText("Opening Profiles.");
});

test("updates visible timing choices when selecting a profile", async ({ page }) => {
  await signIn(page, "profile-default-user");
  await page.evaluate(async () => {
    for (const profile of [
      { name: "Short", defaultDurationMinutes: 5, defaultKeepaliveMinutes: 15 },
      { name: "Long", defaultDurationMinutes: 30, defaultKeepaliveMinutes: 1 }
    ]) {
      await fetch("/api/reservation-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...profile, selections: [{ targetId: "prefer-smol", modelIds: [] }] })
      });
    }
  });
  await page.goto(baseUrl);
  await expect(page.locator('[data-duration="30"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-keepalive="1"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#profile-picker > summary").click();
  await page.locator('[data-select-profile]', { hasText: "Short" }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("5");
  await expect(page.locator('[data-duration="5"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#keepalive-minutes")).toHaveValue("15");
  await expect(page.locator('[data-keepalive="15"]')).toHaveAttribute("aria-pressed", "true");
});

test("shows and manages multiple active reservations", async ({ page }) => {
  await signIn(page, "multi-reservation-user");
  await createSmolProfile(page);
  await page.getByRole("button", { name: "Reserve capacity" }).click();
  await page.getByRole("button", { name: "Reserve capacity" }).click();
  await expect(page.locator("#current-reservation .reservation-card")).toHaveCount(2);
  await expect(page.locator("#current-reservation").getByRole("button", { name: "I'm done" })).toHaveCount(2);
  await page.locator("#current-reservation").getByRole("button", { name: "I'm done" }).first().click();
  await expect(page.locator("#current-reservation .reservation-card")).toHaveCount(1);
});

test("shows and completes the standalone reservation page", async ({ page }) => {
  await signIn(page, "detail-user");
  await reserveSmolModel(page);

  const reservationId = await page.evaluate(async () => {
    const response = await fetch("/api/status");
    const data = await response.json();
    return data.activeReservations[0].reservationId as string;
  });

  await page.goto(`${baseUrl}/reservations/${reservationId}`);
  await expect(page.getByRole("heading", { name: new RegExp(`Reservation ${reservationId}`) })).toBeVisible();
  await expect(page.locator("#reservation-status")).toContainText("active");
  await expect(page.getByRole("heading", { name: "Connect", exact: true })).toBeVisible();
  await expect(page.locator(".reservation-routing")).toContainText("LiteLLM");
  await expect(page.locator(".reservation-routing")).toContainText("prefer/qwen-smol");
  await expect(page.locator(".reservation-routing")).toContainText("Direct model host");
  await expect(page.getByRole("link", { name: "Open direct model host" })).toHaveAttribute("href", "http://host.docker.internal:8080/");
  await expect(page.locator("#target-status")).toContainText("PreFer Smol");

  await page.getByRole("button", { name: "I'm done" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
});

test("shows reservation cost and activation history", async ({ page }) => {
  await signIn(page, "cost-user");
  await createSmolProfile(page);
  await page.locator('[data-duration="30"]').click();
  await page.getByRole("button", { name: "Reserve capacity" }).click();
  await expect(page.locator("#current-reservation")).toContainText("active");

  const costWindowStart = new Date(Date.now() + 1_000);
  await reconcile(costWindowStart);
  await reconcile(new Date(costWindowStart.getTime() + 15 * 60_000));

  await page.reload();
  await expect(page.locator("#current-reservation")).toContainText("Cost so far:");
  await expect(page.locator("#current-reservation")).toContainText("$3.00");
  await expect(page.locator("#current-reservation")).toContainText("Projected total:");

  await page.goto(`${baseUrl}/admin/activations`);
  await expect(page.getByRole("heading", { name: "Activations" })).toBeVisible();
  await expect(page.locator("#activation-list")).toContainText("PreFer Smol");
  await expect(page.locator("#activation-list")).toContainText("$3.00");
  await expect(page.locator("#activation-list")).toContainText("cost-user");
  await expect(page.locator("#activation-list")).toContainText("qwen-smol");

  const reservationId = await page.locator("#activation-list a[href^='/reservations/']").first().textContent();
  await page.goto(`${baseUrl}/reservations/${reservationId}`);
  await expect(page.locator("#reservation-cost-so-far")).toContainText("$3.00");
  await expect(page.locator("#reservation-cost-projected")).toContainText("$");
});

test("presents daily usage as a focused summary with selectable breakdowns", async ({ page }) => {
  await page.route("**/api/admin/usage?days=*", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      windowDays: 30,
      generatedAt: "2026-08-17T12:00:00.000Z",
      timezone: "UTC",
      daily: [{ key: "2026-08-16", label: "2026-08-16", reservationCount: 2, activatedMinutes: 150, estimatedCostUsd: 9.5 }],
      users: [{ key: "alice", label: "alice", reservationCount: 2, activatedMinutes: 150, estimatedCostUsd: 9.5 }],
      providers: [{ key: "aws", label: "aws", reservationCount: 2, activatedMinutes: 150, estimatedCostUsd: 9.5 }],
      targets: [{ key: "gpu-1", label: "GPU 1", reservationCount: 2, activatedMinutes: 150, estimatedCostUsd: 9.5 }],
      models: [{ key: "model-1", label: "Model 1", reservationCount: 2, activatedMinutes: 150, estimatedCostUsd: 9.5 }]
    })
  }));
  await signIn(page, "usage-user");
  await page.goto(`${baseUrl}/admin/usage`);

  await expect(page.getByRole("heading", { name: "Usage report" })).toBeVisible();
  await expect(page.locator(".usage-summary")).toContainText("$9.50");
  await expect(page.locator(".usage-summary")).toContainText("2.5 hr");
  await expect(page.getByRole("tab", { name: "Daily" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Targets" }).click();
  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  await expect(page.locator("#usage-report")).toContainText("GPU 1");
  await expect(page.locator("#usage-report")).not.toContainText("alice");
});

test("generates and revokes personal API keys", async ({ page }) => {
  await signIn(page, "key-user");
  await page.getByRole("link", { name: "API keys" }).click();

  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.getByLabel("Name").fill("Codex browser key");
  await page.getByRole("button", { name: "Generate key" }).click();

  const token = page.locator("#created-api-key");
  await expect(token).toContainText(/^sk-neuron-/);
  const fullToken = await token.textContent();
  expect(fullToken).toMatch(/^sk-neuron-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/);
  await expect(page.locator("tbody")).toContainText("Codex browser key");
  await expect(page.locator("tbody")).toContainText("Never");
  await expect(page.locator("tbody")).not.toContainText(fullToken ?? "");

  await page.goto(`${baseUrl}/api-keys`);
  await expect(page.locator("#created-api-key")).toHaveCount(0);
  await expect(page.locator("tbody")).toContainText("Codex browser key");

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
});

test("copies model aliases, API keys, and declarative snippets", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await signIn(page, "copy-user");
  await createSmolProfile(page);

  await page.getByRole("button", { name: "Review" }).click();
  const review = page.locator("#profile-review-modal");
  await review.locator("[data-copy='qwen-smol']").first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("qwen-smol");
  await review.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "API keys" }).click();
  await page.getByLabel("Name").fill("Copy key");
  await page.getByRole("button", { name: "Generate key" }).click();
  const generatedKey = await page.locator("#created-api-key").textContent();
  await page.getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(generatedKey);

  await page.getByRole("link", { name: "Targets" }).click();
  const configuredTarget = page.locator("details.drilldown", { hasText: "PreFer Smol" });
  await configuredTarget.locator(":scope > summary").click();
  await configuredTarget.getByRole("button", { name: "JSON" }).click();
  await configuredTarget.locator('[data-tab-panel="json"]').getByRole("button", { name: "Copy JSON" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('"id": "prefer-smol"');

  await configuredTarget.getByRole("button", { name: "ENV" }).click();
  await configuredTarget.locator('[data-tab-panel="env"]').getByRole("button", { name: "Copy ENV" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("CAPACITY_TARGET");
});

test("shows admin status with active and completed reservations", async ({ page }) => {
  await signIn(page, "admin-user");
  await reserveSmolModel(page);
  await page.goto(`${baseUrl}/admin/reservations`);

  await expect(page.getByRole("heading", { name: "Reservations" })).toBeVisible();
  await expect(page.locator("#reservation-history")).toContainText("prefer-smol");
  await expect(page.locator("#reservation-history")).toContainText("admin-user");
  await expect(page.locator("#reservation-history")).toContainText("qwen-smol");

  await page.goto(baseUrl);
  await page.locator("#current-reservation").getByRole("button", { name: "I'm done" }).click();
  await page.goto(`${baseUrl}/admin/reservations`);

  await expect(page.locator("#reservation-history")).toContainText("done");
  await expect(page.locator("#reservation-history")).toContainText("admin-user");
});

test("runs admin target lifecycle actions from the target page", async ({ page }) => {
  await signIn(page, "lifecycle-admin");
  await page.goto(`${baseUrl}/admin/targets`);

  const target = page.locator("details.drilldown", { hasText: "PreFer Smol" });
  await expect(target.locator('[data-target-status="prefer-smol"]')).toContainText("Not checked");
  await target.locator(":scope > summary").click();

  await target.getByRole("button", { name: "Reconcile" }).click();
  await expect(target.locator('[data-target-status="prefer-smol"]')).toContainText("Stopped");

  await target.getByRole("button", { name: "Force stop" }).click();
  await expect(target.locator('[data-target-status="prefer-smol"]')).toContainText("Force stopped");
});

test("creates, edits, and deletes providers from the admin UI", async ({ page }) => {
  await signIn(page, "provider-admin");
  await page.getByRole("link", { name: "Providers" }).click();

  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.getByText("No providers configured")).toBeVisible();

  await page.getByRole("button", { name: "Add provider" }).click();
  const modal = page.locator("#provider-modal");
  await expect(modal).toBeVisible();
  await modal.locator('select[name="type"]').selectOption("docker");
  await expect(modal.locator("#provider-type-note")).toContainText("Docker providers use the local Docker daemon");
  await modal.locator('input[name="id"]').fill("docker-local");
  await modal.locator('input[name="displayName"]').fill("Docker Local");
  await modal.getByLabel("Allow this provider to provision resources").check();
  await modal.getByRole("button", { name: "Add provider" }).click();

  const provider = page.locator("details.drilldown", { hasText: "Docker Local" });
  await expect(provider).toContainText("docker-local");
  await expect(provider).toContainText("persisted");
  await provider.locator("summary").click();

  await provider.getByRole("button", { name: "Targets" }).click();
  await expect(provider.locator('[data-tab-panel="targets"]')).toContainText("Add target");
  await expect(provider.locator('[data-tab-panel="targets"] a', { hasText: "Add target" })).toHaveAttribute("href", "/admin/targets");

  await provider.getByRole("button", { name: "Edit" }).click();
  const editPanel = provider.locator('[data-tab-panel="edit"]');
  await editPanel.locator('input[name="displayName"]').fill("Docker Shared");
  await editPanel.getByRole("button", { name: "Save provider" }).click();
  await expect(page.locator("details.drilldown", { hasText: "Docker Shared" })).toBeVisible();

  const renamed = page.locator("details.drilldown", { hasText: "Docker Shared" });
  await renamed.locator("summary").click();
  await renamed.getByRole("button", { name: "Delete" }).click();
  await renamed.locator('[data-tab-panel="delete"] input[name="confirmName"]').fill("docker-local");
  await renamed.locator('[data-tab-panel="delete"]').getByRole("button", { name: "Delete provider" }).click();
  await expect(page.getByText("No providers configured")).toBeVisible();
});

test("copies config-backed providers and targets into persisted storage", async ({ page }) => {
  await signIn(page, "copy-db-admin");
  await createDockerProvider(page);

  await page.getByRole("link", { name: "Providers" }).click();
  const provider = page.locator("details.drilldown", { hasText: "Docker Local" });
  await expect(provider).toContainText("persisted");

  await page.getByRole("link", { name: "Targets" }).click();
  let configTarget = page.locator("details.drilldown", { hasText: "PreFer Smol" });
  await expect(configTarget).toContainText("config");
  await configTarget.locator(":scope > summary").click();
  await configTarget.getByRole("button", { name: "Edit" }).click();
  await expect(configTarget.locator('[data-tab-panel="edit"]')).toContainText("LiteLLM model route prefixes");
  await configTarget.getByRole("button", { name: "Copy to DB" }).click();

  configTarget = page.locator("details.drilldown", { hasText: "PreFer Smol" });
  await expect(configTarget).toContainText("persisted");
  await configTarget.locator(":scope > summary").click();
  await configTarget.getByRole("button", { name: "Edit" }).click();
  await expect(configTarget.locator('[data-tab-panel="edit"]')).toContainText("This target is stored in the database.");
});

test("creates, edits, and deletes targets from the admin UI", async ({ page }) => {
  await signIn(page, "target-admin");
  await createDockerProvider(page);
  await page.getByRole("link", { name: "Targets" }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  await page.getByRole("button", { name: "Add target" }).click();
  const modal = page.locator("#target-modal");
  await expect(modal).toBeVisible();
  await modal.locator('select[name="providerId"]').selectOption("docker-local");
  await modal.locator('select[name="runtimeProfileId"]').selectOption("prefer");
  await expect(modal.locator("#docker-target-fields")).toBeVisible();
  await expect(modal.locator("#target-runtime-profile-note")).toContainText("volume prefer-model-cache -> /models");
  await expect(modal.locator('input[name="dockerModelVolume"]')).toHaveValue("prefer-model-cache");

  await modal.locator('input[name="id"]').fill("docker-qwen");
  await modal.locator('input[name="displayName"]').fill("Docker Qwen");
  await modal.locator('input[name="dockerContainerName"]').fill("prefer-qwen");
  await modal.locator("summary", { hasText: "Overrides" }).click();
  await expect(modal).toContainText("LiteLLM model route prefixes");
  expect(await modal.locator('input[name="trafficModelPrefixes"]').evaluate((input) => {
    const bounds = input.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await modal.locator('input[name="modelIds"]').fill("qwen-smol");
  await modal.locator('input[name="trafficModelPrefixes"]').fill("clint-desktop/");
  await modal.getByRole("button", { name: "Add target" }).click();

  await expect(page.locator(".secret-box")).toContainText("docker-qwen");
  let target = page.locator("details.drilldown", { hasText: "Docker Qwen" });
  await expect(target).toContainText("persisted");
  await target.locator(":scope > summary").click();

  await expect(target.locator('[data-target-status="docker-qwen"]')).toContainText("Not checked");
  await expect(target.locator('[data-target-status="docker-qwen"]')).toContainText("No discovery cache");

  await target.getByRole("button", { name: "JSON" }).click();
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("prefer-qwen");
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("clint-desktop/");

  await target.getByRole("button", { name: "Edit" }).click();
  const editPanel = target.locator('[data-tab-panel="edit"]');
  await editPanel.locator('input[name="displayName"]').fill("Docker Qwen Updated");
  await editPanel.locator("summary", { hasText: "Overrides" }).click();
  await editPanel.locator('input[name="modelIds"]').fill("qwen-smol,other-smol");
  await editPanel.locator('input[name="trafficModelPrefixes"]').fill("clint-desktop/,prefer/");
  await editPanel.getByRole("button", { name: "Save target" }).click();

  target = page.locator("details.drilldown", { hasText: "Docker Qwen Updated" });
  await expect(target).toBeVisible();
  await target.locator(":scope > summary").click();
  await target.getByRole("button", { name: "View" }).click();
  await expect(target.locator('[data-tab-panel="view"]')).toContainText("qwen-smol, other-smol");
  await expect(target.locator('[data-tab-panel="view"]')).toContainText("clint-desktop/, prefer/");

  await target.getByRole("button", { name: "Delete" }).click();
  await target.locator('[data-tab-panel="delete"] input[name="confirmName"]').fill("docker-qwen");
  await target.locator('[data-tab-panel="delete"]').getByRole("button", { name: "Delete target" }).click();
  await expect(page.locator("details.drilldown", { hasText: "Docker Qwen Updated" })).toHaveCount(0);
});

test("creates a target from a provider detail panel using Docker connect-existing", async ({ page }) => {
  await signIn(page, "provider-target-admin");
  await createDockerProvider(page);

  const provider = page.locator("details.drilldown", { hasText: "Docker Local" });
  await provider.locator("summary").click();
  await provider.getByRole("button", { name: "Targets" }).click();
  const addTarget = provider.getByRole("link", { name: "Add target" });
  await expect(addTarget).toHaveAttribute("href", "/admin/targets");
  await addTarget.click();
  await expect(page).toHaveURL(`${baseUrl}/admin/targets`);
  await page.getByRole("button", { name: "Add target" }).click();

  const modal = page.locator("#target-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator('select[name="providerId"]')).toHaveValue("docker-local");
  await modal.locator('select[name="runtimeProfileId"]').selectOption("prefer");
  await expect(modal.locator('[data-connection-fields="existing"]#docker-target-fields')).toBeVisible();
  await expect(modal.locator('input[name="dockerModelVolume"]')).toHaveValue("prefer-model-cache");
  await modal.locator('input[name="id"]').fill("provider-panel-target");
  await modal.locator('input[name="displayName"]').fill("Provider Panel Target");
  await modal.locator('input[name="dockerContainerName"]').fill("provider-panel-target");
  await modal.getByRole("button", { name: "Add target" }).click();

  await expect(page).toHaveURL(/\/admin\/targets\?created=provider-panel-target$/);
  await expect(page.locator(".secret-box")).toContainText("provider-panel-target");
  await expect(page.locator(".secret-box")).toContainText("NeurOn will use the capacity you connected");
  await expect(page.locator(".secret-box").getByRole("button", { name: "Provision target" })).toHaveCount(0);
  const target = page.locator("details.drilldown", { hasText: "Provider Panel Target" });
  await target.locator(":scope > summary").click();
  await target.getByRole("button", { name: "JSON" }).click();
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("provider-panel-target");
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("prefer-model-cache");
});

async function signIn(page: Page, username: string) {
  await createTestAccount(username);
  await page.goto(baseUrl);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseUrl}/welcome`);
}

async function createTestAccount(username: string) {
  const invitation = await identityService.createInvitation(undefined, {
    intendedUsername: username,
    initialRoleId: "role_owner"
  });
  await identityService.register(invitation.token, { username, password });
}

async function reserveSmolModel(page: Page) {
  await createSmolProfile(page);
  await page.getByRole("button", { name: "Reserve" }).click();
  await expect(page.locator("#current-reservation")).toContainText("active");
  markTargetHealthy();
  await page.reload();
}

async function createSmolProfile(page: Page) {
  if (page.url().endsWith("/welcome")) {
    await page.getByRole("button", { name: "Create your first profile" }).click();
  } else {
    await page.getByRole("button", { name: "Create profile" }).click();
  }
  const modal = page.locator("#profile-modal");
  await modal.getByLabel("Name", { exact: true }).fill("Smol profile");
  await modal.getByRole("button", { name: "Review profile" }).click();
  const review = page.locator("#profile-save-review-modal");
  await expect(review).toBeVisible();
  const liteLlm = review.locator(".routing-block").first();
  await expect(liteLlm.locator(".routing-identifier").nth(0)).toContainText("Use");
  await expect(liteLlm.locator(".routing-identifier").nth(0)).toContainText("prefer/qwen-smol");
  await expect(liteLlm.locator(".routing-identifier").nth(1)).toContainText("Fallback");
  await expect(liteLlm.locator(".routing-identifier").nth(1)).toContainText("qwen-smol");
  await expect(liteLlm).not.toContainText("ID");
  await expect(review.getByRole("link", { name: "Connect" })).toHaveText("↗");
  await expect(review.getByRole("link", { name: "Open direct model host" })).toHaveCount(0);
  await review.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator("#start-form")).toContainText("Smol profile");
}

async function createDockerProvider(page: Page, options: { allowProvisioning?: boolean } = {}) {
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Add provider" }).click();
  const modal = page.locator("#provider-modal");
  await modal.locator('select[name="type"]').selectOption("docker");
  await modal.locator('input[name="id"]').fill("docker-local");
  await modal.locator('input[name="displayName"]').fill("Docker Local");
  if (options.allowProvisioning) await modal.getByLabel("Allow this provider to provision resources").check();
  await modal.getByRole("button", { name: "Add provider" }).click();
  await expect(page.locator("details.drilldown", { hasText: "Docker Local" })).toBeVisible();
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    USE_FAKE_PROVIDER: process.env.USE_FAKE_PROVIDER,
    CAPACITY_TARGETS_FILE: process.env.CAPACITY_TARGETS_FILE,
    COOKIE_SECRET: process.env.COOKIE_SECRET,
    LITELLM_TRAFFIC_POLL_SECONDS: process.env.LITELLM_TRAFFIC_POLL_SECONDS
  };
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
