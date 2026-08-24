import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { verifyWorkspaceAgentHandshake } from "./lib/workspace-agent-handshake.ts";

const [releaseRoot, buildPlatform, architecture, copyDirectory] = process.argv.slice(2);
if (!releaseRoot || !buildPlatform || !architecture) {
  throw new Error(
    "Usage: node scripts/verify-packaged-workspace-agent.ts <release-root> <mac|linux|win> <arm64|x64> [copy-directory]",
  );
}

const platform = buildPlatform === "mac" ? "darwin" : buildPlatform === "win" ? "win32" : "linux";
const binaryName = platform === "win32" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
const suffix = `/resources/server/workspace-agent/bin/${binaryName}`;

function findBinary(directory: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(path);
      if (nested) return nested;
    } else if (entry.isFile() && path.replaceAll("\\", "/").endsWith(suffix)) {
      return path;
    }
  }
  return undefined;
}

if (!statSync(releaseRoot).isDirectory())
  throw new Error(`Release root is not a directory: ${releaseRoot}`);
const binaryPath = findBinary(releaseRoot);
if (!binaryPath)
  throw new Error(`Packaged workspace watcher agent was not found under ${releaseRoot}`);

const result = spawnSync(binaryPath, ["--check"], { encoding: "utf8" });
const fields = result.stdout.trim().split("\t");
const expectedOs = platform === "win32" ? "windows" : platform;
const expectedArch = architecture === "arm64" ? "aarch64" : "x86_64";
if (
  result.status !== 0 ||
  fields[0] !== "bigbud-remote-agent" ||
  fields.at(-2) !== expectedOs ||
  fields.at(-1) !== expectedArch
) {
  throw new Error(
    `Packaged workspace watcher identity mismatch for ${platform}/${architecture}: ${result.stderr.trim()}`,
  );
}

await verifyWorkspaceAgentHandshake(binaryPath);

if (copyDirectory) {
  mkdirSync(copyDirectory, { recursive: true });
  const extension = platform === "win32" ? ".exe" : "";
  copyFileSync(
    binaryPath,
    join(copyDirectory, `server-workspace-agent-${platform}-${architecture}${extension}`),
  );
}

console.log(
  `Verified packaged workspace watcher: ${basename(binaryPath)} (${platform}/${architecture})`,
);
