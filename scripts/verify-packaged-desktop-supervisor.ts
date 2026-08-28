import { statSync } from "node:fs";
import { basename } from "node:path";

import {
  smokeTestDesktopSupervisorBinary,
  smokeTestDesktopSupervisorRecovery,
} from "./lib/desktop-supervisor-smoke.ts";
import {
  findPackagedDesktopSupervisor,
  verifyPackagedDesktopSupervisorEvidence,
} from "./lib/packaged-desktop-supervisor.ts";
import {
  type DesktopBuildPlatform,
  validateCodeSignatureRequirement,
  verifyPackagedCodeSignature,
} from "./lib/packaged-workspace-agent.ts";

const rawArguments = process.argv.slice(2);
const requireCodeSignature = rawArguments.includes("--require-code-signature");
const [releaseRoot, buildPlatform] = rawArguments.filter(
  (argument) => argument !== "--require-code-signature",
);
if (!releaseRoot || !buildPlatform) {
  throw new Error(
    "Usage: bun run scripts/verify-packaged-desktop-supervisor.ts <release-root> <mac|linux|win> [--require-code-signature]",
  );
}
if (!(<const>["mac", "linux", "win"]).includes(buildPlatform as DesktopBuildPlatform)) {
  throw new Error(`Unsupported desktop platform: ${buildPlatform}`);
}
const platform = buildPlatform as DesktopBuildPlatform;
const expectedWindowsPublisher = process.env.BIGBUD_WINDOWS_SIGNING_SUBJECT;
validateCodeSignatureRequirement(platform, requireCodeSignature, expectedWindowsPublisher);
if (!statSync(releaseRoot).isDirectory()) {
  throw new Error(`Release root is not a directory: ${releaseRoot}`);
}
const binaryPath = findPackagedDesktopSupervisor(releaseRoot, platform);
if (!binaryPath) throw new Error(`Packaged desktop supervisor was not found under ${releaseRoot}`);
verifyPackagedDesktopSupervisorEvidence(binaryPath);
if (requireCodeSignature) {
  verifyPackagedCodeSignature(binaryPath, platform as "mac" | "win", expectedWindowsPublisher);
}
await smokeTestDesktopSupervisorBinary(binaryPath);
await smokeTestDesktopSupervisorRecovery(binaryPath);
console.log(`Verified packaged desktop supervisor: ${basename(binaryPath)} (${platform})`);
