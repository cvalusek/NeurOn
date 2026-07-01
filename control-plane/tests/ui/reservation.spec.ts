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

test.beforeEach(async () => {
  previousEnv = snapshotEnv();
  process.env.USE_FAKE_PROVIDER = "true";
  process.env.CAPACITY_TARGETS_FILE = targetFile;
  process.env.SHARED_PASSWORD = password;
  process.env.COOKIE_SECRET = "browser-test-cookie-secret";
  process.env.LITELLM_TRAFFIC_POLL_SECONDS = "0";

  const loaded = await loadConfig();
  const built = await buildApp(loaded.config, loaded.models);
  app = built.app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  await app?.close();
  restoreEnv(previousEnv);
});

test("requires sign-in before showing protected pages", async ({ page }) => {
  await page.goto(`${baseUrl}/api-keys`);

  await expect(page).toHaveURL(`${baseUrl}/login`);
  await page.getByLabel("Username").fill("ui-user");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid credentials")).toBeVisible();

  await page.getByLabel("Username").fill("ui-user");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator("header")).toContainText("ui-user");
});

test("creates, extends, and ends a reservation from the rendered UI", async ({ page }) => {
  await signIn(page, "ui-user");

  await expect(page.getByRole("heading", { name: "Start capacity" })).toBeVisible();
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
  await expect(page.locator("#start-form")).toContainText("PreFer Smol");
  await expect(page.locator("#start-form")).toContainText("Qwen Smol");

  await page.locator("label.option", { hasText: "Qwen Smol" }).click();
  await page.locator('[aria-label="Duration"]').getByRole("button", { name: "5 min", exact: true }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("5");
  await page.getByRole("button", { name: "Reserve" }).click();

  await expect(page.locator("#current-reservation")).toContainText("ui-user");
  await expect(page.locator("#current-reservation")).toContainText("active");
  await expect(page.locator("#current-reservation")).toContainText("PreFer Smol");
  await expect(page.locator("#current-reservation")).toContainText("qwen-smol");
  await expect(page.locator("#server-status")).toContainText("Users: ui-user");

  await page.locator("#current-reservation").getByRole("button", { name: "+1 min", exact: true }).click();
  await expect(page.locator("#current-reservation")).toContainText("active");

  await page.locator("#current-reservation").getByRole("button", { name: "I'm done" }).click();
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
  await expect(page.locator("#server-status")).not.toContainText("Users: ui-user");
});

test("supports custom reservation duration and keepalive controls", async ({ page }) => {
  await signIn(page, "custom-user");

  await page.locator("label.option", { hasText: "Qwen Smol" }).click();
  await page.locator('[data-custom-duration="true"]').click();
  await expect(page.locator("#custom-duration-wrap")).toBeVisible();
  await page.locator("#custom-duration").fill("7");
  await expect(page.locator("#duration-minutes")).toHaveValue("7");

  await page.locator('[data-custom-keepalive="true"]').click();
  await expect(page.locator("#custom-keepalive-wrap")).toBeVisible();
  await page.locator("#custom-keepalive").fill("4");
  await expect(page.locator("#keepalive-minutes")).toHaveValue("4");

  await page.getByRole("button", { name: "Reserve" }).click();

  await expect(page.locator("#current-reservation")).toContainText("custom-user");
  await expect(page.locator("#current-reservation")).toContainText("active");
});

test("prevents reserving a configured-model target without selecting a model", async ({ page }) => {
  await signIn(page, "validation-user");

  await page.getByRole("button", { name: "Reserve" }).click();

  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
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
  await expect(page.locator("#reservation-models")).toContainText("qwen-smol");
  await expect(page.locator("#target-status")).toContainText("prefer-smol");

  await page.getByRole("button", { name: "I'm done" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator("#current-reservation")).toContainText("No active reservation");
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

  await page.locator("#start-form [data-copy='qwen-smol']").first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("qwen-smol");

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
  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.locator("#admin-status")).toContainText("prefer-smol");
  await expect(page.locator("#admin-status")).toContainText("admin-user");
  await expect(page.locator("#admin-status")).toContainText("qwen-smol");

  await page.getByRole("link", { name: "Home" }).click();
  await page.locator("#current-reservation").getByRole("button", { name: "I'm done" }).click();
  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page.locator("#admin-status")).toContainText("done");
  await expect(page.locator("#admin-status")).toContainText("admin-user");
});

test("runs admin target lifecycle actions from the dashboard", async ({ page }) => {
  await signIn(page, "lifecycle-admin");
  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page.locator("#admin-status")).toContainText("prefer-smol");

  await page.getByRole("button", { name: "Reconcile" }).click();
  await expect(page.locator("#admin-status")).toContainText("Stopped");

  await page.getByRole("button", { name: "Force stop" }).click();
  await expect(page.locator("#admin-status")).toContainText("Force stopped");
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
  await expect(provider.locator('[data-tab-panel="targets"]')).toContainText("Create target");

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
  let provider = page.locator("details.drilldown", { hasText: "Docker Local" });
  await expect(provider).toContainText("persisted");

  await page.getByRole("link", { name: "Targets" }).click();
  let configTarget = page.locator("details.drilldown", { hasText: "PreFer Smol" });
  await expect(configTarget).toContainText("config");
  await configTarget.locator(":scope > summary").click();
  await configTarget.getByRole("button", { name: "Edit" }).click();
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

  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  await page.getByRole("button", { name: "Add target" }).click();
  const modal = page.locator("#target-modal");
  await expect(modal).toBeVisible();
  await modal.locator('select[name="providerId"]').selectOption("docker-local");
  await expect(modal.locator("#docker-target-fields")).toBeVisible();
  await expect(modal.locator("#target-runtime-profile-note")).toContainText("volume prefer-model-cache -> /models");
  await expect(modal.locator('input[name="dockerModelVolume"]')).toHaveValue("prefer-model-cache");

  await modal.locator('input[name="id"]').fill("docker-qwen");
  await modal.locator('input[name="displayName"]').fill("Docker Qwen");
  await modal.locator('input[name="dockerContainerName"]').fill("prefer-qwen");
  await modal.locator("summary", { hasText: "Overrides" }).click();
  await modal.locator('input[name="modelIds"]').fill("qwen-smol");
  await modal.getByRole("button", { name: "Add target" }).click();

  await expect(page.locator(".secret-box")).toContainText("docker-qwen");
  let target = page.locator("details.drilldown", { hasText: "Docker Qwen" });
  await expect(target).toContainText("persisted");
  await target.locator(":scope > summary").click();

  await target.getByRole("button", { name: "Status" }).click();
  await expect(target.locator('[data-tab-panel="status"]')).toContainText("Not checked");

  await target.getByRole("button", { name: "JSON" }).click();
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("prefer-qwen");

  await target.getByRole("button", { name: "Edit" }).click();
  const editPanel = target.locator('[data-tab-panel="edit"]');
  await editPanel.locator('input[name="displayName"]').fill("Docker Qwen Updated");
  await editPanel.locator("summary", { hasText: "Overrides" }).click();
  await editPanel.locator('input[name="modelIds"]').fill("qwen-smol,other-smol");
  await editPanel.getByRole("button", { name: "Save target" }).click();

  target = page.locator("details.drilldown", { hasText: "Docker Qwen Updated" });
  await expect(target).toBeVisible();
  await target.locator(":scope > summary").click();
  await target.getByRole("button", { name: "View" }).click();
  await expect(target.locator('[data-tab-panel="view"]')).toContainText("qwen-smol, other-smol");

  await target.getByRole("button", { name: "Delete" }).click();
  await target.locator('[data-tab-panel="delete"] input[name="confirmName"]').fill("docker-qwen");
  await target.locator('[data-tab-panel="delete"]').getByRole("button", { name: "Delete target" }).click();
  await expect(page.locator("details.drilldown", { hasText: "Docker Qwen Updated" })).toHaveCount(0);
});

test("creates a target from a provider detail panel and provisions the created target", async ({ page }) => {
  await signIn(page, "provider-target-admin");
  await createDockerProvider(page, { allowProvisioning: true });

  const provider = page.locator("details.drilldown", { hasText: "Docker Local" });
  await provider.locator("summary").click();
  await provider.getByRole("button", { name: "Targets" }).click();
  await provider.getByRole("button", { name: "Create target" }).click();

  const modal = page.locator("#provider-target-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator('select[name="providerId"]')).toHaveValue("docker-local");
  await expect(modal.locator('[data-provider-fields="docker"]')).toBeVisible();
  await modal.locator('input[name="id"]').fill("provider-panel-target");
  await modal.locator('input[name="displayName"]').fill("Provider Panel Target");
  await modal.locator('input[name="dockerContainerName"]').fill("provider-panel-target");
  await modal.locator('select[name="runtimeProfileVariantId"]').selectOption("smol");
  await modal.getByRole("button", { name: "Create target" }).click();

  await expect(page).toHaveURL(/\/admin\/targets\?created=provider-panel-target$/);
  await expect(page.locator(".secret-box")).toContainText("provider-panel-target");
  const target = page.locator("details.drilldown", { hasText: "Provider Panel Target" });
  await target.locator(":scope > summary").click();
  await target.getByRole("button", { name: "JSON" }).click();
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("LLAMA_ARG_MODELS_PRESET");
  await expect(target.locator('[data-tab-panel="json"]')).toContainText("/presets/smol.ini");
  await page.locator(".secret-box").getByRole("button", { name: "Provision target" }).click();
  await expect(page.locator(".secret-box").getByRole("button")).toContainText("Provisioned");
});

async function signIn(page: Page, username: string) {
  await page.goto(baseUrl);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
}

async function reserveSmolModel(page: Page) {
  await page.locator("label.option", { hasText: "Qwen Smol" }).click();
  await page.getByRole("button", { name: "Reserve" }).click();
  await expect(page.locator("#current-reservation")).toContainText("active");
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
    SHARED_PASSWORD: process.env.SHARED_PASSWORD,
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
