import {
  assertSshOwnerBinary,
  findDesktopSshOwnerTarget,
  sshOwnerServerRelativePath,
  verifyInactiveSshOwner,
} from "./lib/packaged-ssh-owner.ts";
import {
  findPackagedResource,
  validateCodeSignatureRequirement,
  verifyPackagedCodeSignature,
} from "./lib/packaged-workspace-agent.ts";

const [releaseRoot, platform, arch, signatureFlag, ...extra] = process.argv.slice(2);
if (
  !releaseRoot ||
  (platform !== "mac" && platform !== "win") ||
  !arch ||
  (signatureFlag !== undefined && signatureFlag !== "--require-code-signature") ||
  extra.length > 0
) {
  throw new Error(
    "Usage: node scripts/verify-packaged-ssh-owner.ts <release-root> <mac arm64|win x64> [--require-code-signature]",
  );
}
const target = findDesktopSshOwnerTarget(platform, arch);
if (!target) throw new Error(`No desktop SSH owner expected for ${platform}/${arch}`);

const requireCodeSignature = signatureFlag === "--require-code-signature";
const expectedWindowsPublisher = process.env.BIGBUD_WINDOWS_SIGNING_SUBJECT;
validateCodeSignatureRequirement(platform, requireCodeSignature, expectedWindowsPublisher);
const resourcesDir = platform === "mac" ? "Contents/Resources" : "resources";
const suffix = `/${resourcesDir}/server/${sshOwnerServerRelativePath(target.platform)}`;
const binaryPath = findPackagedResource(releaseRoot, suffix);
if (!binaryPath) throw new Error(`Packaged SSH owner not found under ${releaseRoot}: ${suffix}`);

assertSshOwnerBinary(binaryPath, target);
if (requireCodeSignature) {
  verifyPackagedCodeSignature(binaryPath, platform, expectedWindowsPublisher);
}
verifyInactiveSshOwner(binaryPath, target);
console.log(
  `Verified packaged SSH owner (${target.platform}/${target.arch}); inactive startup rejected`,
);
