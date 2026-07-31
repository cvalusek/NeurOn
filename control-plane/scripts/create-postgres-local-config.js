#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const destination = path.join(repositoryRoot, ".env.postgres.local");
const username = "neuron";
const database = "neuron";
const password = randomBytes(32).toString("hex");
const connection = `postgresql://${username}:${password}@postgres:5432`;
const content = [
  `POSTGRES_USER=${username}`,
  `POSTGRES_PASSWORD=${password}`,
  `POSTGRES_DB=${database}`,
  `DATABASE_URL=${connection}/${database}`,
  `POSTGRES_DRY_RUN_DATABASE_URL=${connection}/neuron_dry_run`,
  `TEST_DATABASE_URL=${connection}/neuron_test`,
  "POSTGRES_POOL_MAX=10",
  ""
].join("\n");

let handle;
try {
  handle = await open(destination, "wx", 0o600);
  await handle.writeFile(content, "utf8");
  await handle.sync();
} catch (error) {
  if (error?.code === "EEXIST") {
    process.stderr.write(`Local PostgreSQL configuration already exists at ${destination}; it was not changed.\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await handle?.close();
}

if (!process.exitCode) process.stdout.write(`Created ignored local PostgreSQL configuration at ${destination}.\n`);
