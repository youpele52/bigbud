import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  assertSshOwnerBinary,
  findDesktopSshOwnerTarget,
  sshOwnerReleaseAssetName,
  sshOwnerServerRelativePath,
  verifyInactiveSshOwner,
} from "./lib/packaged-ssh-owner.ts";
import {
  type DesktopBuildPlatform,
  findPackagedResource,
  validateCodeSignatureRequirement,
  verifyPackagedCodeSignature,
} from "./lib/packaged-workspace-agent.ts";

const USAGE =
  "Usage: node scripts/verify-packaged-ssh-owner.ts <release-root> <mac|linux|win> <arm64|x64> [copy-directory] [--require-code-signature]\n" +
  "       node scripts/verify-packaged-ssh-owner.ts --binary <owner-path> <mac|linux|win> <arm64|x64> [copy-directory]";

const rawArguments = process.argv.slice(2);
const requireCodeSignature = rawArguments.includes("--require-code-signature");
const binaryMode = rawArguments[0] === "--binary";
const positional = rawArguments.filter(
  (argument) => argument !== "--require-code-signature" && argument !== "--binary",
);
const [root, platform, arch, copyDirectory, ...extra] = positional;
if (
  !root ||
  !(["mac", "linux", "win"] as const).includes(platform as DesktopBuildPlatform) ||
  !arch ||
  extra.length > 0 ||
  (binaryMode && requireCodeSignature)
) {
  throw new Error(USAGE);
}
const desktopPlatform = platform as DesktopBuildPlatform;
const target = findDesktopSshOwnerTarget(desktopPlatform, arch);
// U4: Windows arm64 (and anything outside the native matrix) has no owner in v1.
if (!target) throw new Error(`No SSH owner is shipped for ${platform}/${arch}`);

const expectedWindowsPublisher = process.env.BIGBUD_WINDOWS_SIGNING_SUBJECT;
validateCodeSignatureRequirement(desktopPlatform, requireCodeSignature, expectedWindowsPublisher);

let binaryPath: string | undefined = root;
if (!binaryMode) {
  const resourcesDir = desktopPlatform === "mac" ? "Contents/Resources" : "resources";
  const suffix = `/${resourcesDir}/server/${sshOwnerServerRelativePath(target.platform)}`;
  binaryPath = findPackagedResource(root, suffix);
  if (!binaryPath) throw new Error(`Packaged SSH owner not found under ${root}: ${suffix}`);
}

assertSshOwnerBinary(binaryPath, target);
if (requireCodeSignature && desktopPlatform !== "linux") {
  verifyPackagedCodeSignature(binaryPath, desktopPlatform, expectedWindowsPublisher);
}
verifyInactiveSshOwner(binaryPath, target);

if (copyDirectory) {
  // The standalone N package is assembled from these verified per-target copies.
  mkdirSync(copyDirectory, { recursive: true });
  const destination = join(copyDirectory, sshOwnerReleaseAssetName(target));
  copyFileSync(binaryPath, destination);
  if (target.platform !== "win32") chmodSync(destination, 0o755);
  if (statSync(destination).size !== statSync(binaryPath).size) {
    throw new Error(`SSH owner copy is incomplete: ${destination}`);
  }
}
console.log(
  `Verified packaged SSH owner (${target.platform}/${target.arch}); inactive startup rejected`,
);
