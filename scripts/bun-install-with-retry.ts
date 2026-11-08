// Runs `bun install --frozen-lockfile` in CI with bounded retries.
//
// Lifecycle scripts download release binaries (for example Electron's postinstall fetches
// from GitHub releases), and github.com intermittently answers those with HTTP 504. The
// lockfile pins every package, so a retry installs the same tree; the Bun package cache
// makes repeated attempts cheap. A failed attempt can leave packages linked whose lifecycle
// script never finished, and a plain retry reports "no changes" without rerunning it (seen
// with Electron), so every retry starts from removed node_modules folders. Uses only Node
// built-ins because it runs before install.
//
// Usage: node scripts/bun-install-with-retry.ts [maxAttempts=5]

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const maxAttempts = Math.max(1, Number.parseInt(process.argv[2] ?? "5", 10) || 5);
const baseDelayMs = 30_000;
// Mirrors the root package.json workspaces: apps/*, packages/*, scripts.
const workspaceParents = ["apps", "packages"];
const workspaceDirs = ["scripts"];

function nodeModulesDirs(): Array<string> {
  const dirs = ["node_modules", ...workspaceDirs.map((dir) => join(dir, "node_modules"))];
  for (const parent of workspaceParents) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name, "node_modules"));
    }
  }
  return dirs.filter((dir) => existsSync(dir));
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync("bun", ["install", "--frozen-lockfile"], { stdio: "inherit" });
  if (result.status === 0) process.exit(0);
  const reason = result.error?.message ?? `exit code ${result.status ?? result.signal}`;
  if (attempt === maxAttempts) {
    console.error(`bun install failed after ${attempt} attempts (${reason}).`);
    process.exit(result.status ?? 1);
  }
  const delayMs = baseDelayMs * attempt;
  console.error(
    `bun install failed (attempt ${attempt}/${maxAttempts}: ${reason}); retrying in ${delayMs / 1000}s.`,
  );
  for (const dir of nodeModulesDirs()) rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
