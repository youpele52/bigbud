import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  findPackagedWorkspaceAgent,
  type DesktopBuildPlatform,
  validateCodeSignatureRequirement,
} from "./lib/packaged-workspace-agent.ts";
import { verifyWorkspaceAgentHandshake } from "./lib/workspace-agent-handshake.ts";

const rawArguments = process.argv.slice(2);
const requireCodeSignature = rawArguments.includes("--require-code-signature");
const [releaseRoot, buildPlatform, architecture, copyDirectory] = rawArguments.filter(
  (argument) => argument !== "--require-code-signature",
);
if (!releaseRoot || !buildPlatform || !architecture) {
  throw new Error(
    "Usage: node scripts/verify-packaged-workspace-agent.ts <release-root> <mac|linux|win> <arm64|x64> [copy-directory] [--require-code-signature]",
  );
}
if (!(["mac", "linux", "win"] as const).includes(buildPlatform as DesktopBuildPlatform)) {
  throw new Error(`Unsupported desktop platform: ${buildPlatform}`);
}

const desktopPlatform = buildPlatform as DesktopBuildPlatform;
validateCodeSignatureRequirement(desktopPlatform, requireCodeSignature);
const platform =
  desktopPlatform === "mac" ? "darwin" : desktopPlatform === "win" ? "win32" : "linux";

if (!statSync(releaseRoot).isDirectory())
  throw new Error(`Release root is not a directory: ${releaseRoot}`);
const binaryPath = findPackagedWorkspaceAgent(releaseRoot, desktopPlatform);
if (!binaryPath)
  throw new Error(`Packaged workspace watcher agent was not found under ${releaseRoot}`);

if (requireCodeSignature) {
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", binaryPath], {
    stdio: "inherit",
  });
}

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
