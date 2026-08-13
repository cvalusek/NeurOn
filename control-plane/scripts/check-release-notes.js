import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const changesDirectory = path.join(root, "changes");
const fragments = readdirSync(changesDirectory).filter((name) => name.endsWith(".md") && name !== "README.md");

for (const fragment of fragments) {
  const text = readFileSync(path.join(changesDirectory, fragment), "utf8").trim();
  if (!/^#\s+\S+/u.test(text)) throw new Error(`Release note ${fragment} must begin with a level-one heading`);
}

const baseRevision = process.argv[2];
if (!baseRevision || /^0+$/u.test(baseRevision)) process.exit(0);

const changed = execFileSync("git", ["diff", "--name-only", `${baseRevision}...HEAD`], { cwd: path.resolve(root, ".."), encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);
const survivingChanges = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseRevision}...HEAD`], { cwd: path.resolve(root, ".."), encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);
const meaningful = changed.some((name) =>
  /^control-plane\/(src\/|Dockerfile$|docker-compose[^/]*\.ya?ml$|package(?:-lock)?\.json$)/u.test(name)
);
const changedFragment = survivingChanges.some((name) => /^control-plane\/changes\/[^/]+\.md$/u.test(name) && !name.endsWith("/README.md"));

if (meaningful && !changedFragment) throw new Error("User- or operator-visible control-plane changes require a Markdown fragment in control-plane/changes/");
