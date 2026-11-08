// Runs `bun install --frozen-lockfile` in CI with bounded retries.
//
// Lifecycle scripts download release binaries (for example Electron's postinstall fetches
// from GitHub releases), and github.com intermittently answers those with HTTP 504. The
// lockfile pins every package, so a retry installs the same tree; the Bun package cache
// makes repeated attempts cheap. Uses only Node built-ins because it runs before install.
//
// Usage: node scripts/bun-install-with-retry.ts [maxAttempts=5]

import { spawnSync } from "node:child_process";

const maxAttempts = Math.max(1, Number.parseInt(process.argv[2] ?? "5", 10) || 5);
const baseDelayMs = 30_000;

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
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
