import { createPublicKey, sign } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  MobileGatewayTarget,
  MobileOptionalArtifact,
  MobileOptionalArtifactCompatibility,
} from "@bigbud/contracts/server/mobileOptionalArtifact";
import {
  canonicalizeMobileOptionalArtifact,
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactSignature,
} from "@bigbud/shared/mobileOptionalArtifact";
import { runArchive } from "./lib/remote-backend-control/archive.ts";
import { isWithin } from "./lib/remote-backend-control/closure.ts";
import { assertGatewayHeader } from "./package-mobile-components.binary.ts";
import { assertMobileArchiveExpansionBudget } from "./package-mobile-components.budget.ts";
import {
  assertMobileAssetsStable,
  captureMobileAssets,
} from "./package-mobile-components.inventory.ts";
import {
  canonicalInput,
  fingerprint,
  readSigningKey,
  readStableFile,
} from "./lib/artifact-build/io.ts";

export interface MobileComponentBuildInput {
  readonly gatewayBinary: string;
  readonly targetTriple: MobileGatewayTarget;
  readonly assetsDirectory: string;
  readonly compatibility: MobileOptionalArtifactCompatibility;
  readonly artifactBaseUrl: string;
  readonly keyId: string;
  readonly keyFile: string;
  readonly outputDirectory: string;
}

/** Explicit build-time invocation signs unpublished artifacts; it never enables a host. */
export async function packageMobileComponents(
  input: MobileComponentBuildInput,
  dependencies: { readonly archive?: typeof runArchive } = {},
): Promise<readonly MobileOptionalArtifact[]> {
  const base = new URL(input.artifactBaseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.href !== input.artifactBaseUrl ||
    !base.pathname.endsWith("/")
  ) {
    throw new Error("Artifact base must be a canonical credential-free HTTPS directory URL.");
  }
  const assets = await canonicalInput(input.assetsDirectory);
  const gateway = await canonicalInput(input.gatewayBinary);
  const keyFile = await canonicalInput(input.keyFile);
  const requestedOut = resolve(input.outputDirectory);
  const output = join(await realpath(dirname(requestedOut)), basename(requestedOut));
  if (
    isWithin(assets, output) ||
    isWithin(output, assets) ||
    isWithin(assets, keyFile) ||
    isWithin(output, keyFile) ||
    isWithin(output, gateway) ||
    gateway === keyFile ||
    isWithin(assets, gateway)
  ) {
    throw new Error("Key, gateway, asset input and fresh output must be separate.");
  }
  const gatewayName = `mobile-gateway-${input.compatibility.gatewayVersion}-${input.targetTriple}${input.targetTriple.includes("windows") ? ".exe" : ""}`;
  const assetsName = `mobile-assets-${input.compatibility.mobileAssetVersion}.tar.gz`;
  const template = {
    schemaVersion: 1,
    compatibility: input.compatibility,
    sizeBytes: 1,
    sha256: "0".repeat(64),
    signature: {
      algorithm: "ed25519",
      keyId: input.keyId,
      value: Buffer.alloc(64).toString("base64"),
    },
  };
  // Validate names/tuple before using versions as paths or opening a private signing key.
  const gatewayMetadata = parseMobileOptionalArtifact({
    ...template,
    kind: "mobile-gateway",
    format: "executable",
    targetTriple: input.targetTriple,
    url: new URL(gatewayName, base).href,
  });
  const assetsMetadata = parseMobileOptionalArtifact({
    ...template,
    kind: "mobile-assets",
    format: "tar.gz",
    targetTriple: "portable",
    url: new URL(assetsName, base).href,
  });
  const keyIdentity = fingerprint(await lstat(keyFile));
  const signingKey = await readSigningKey(keyFile);
  const publicKey = createPublicKey(signingKey).export({ type: "spki", format: "pem" }).toString();
  const gatewayRead = await readStableFile(gateway);
  assertGatewayHeader(gatewayRead.bytes, input.targetTriple);
  if (!(await lstat(assets)).isDirectory()) throw new Error("Asset input must be a directory.");
  await mkdir(output, { mode: 0o700 }); // Exclusive fresh directory, never replace prior output.
  const staging = join(output, ".unpublished");
  await mkdir(staging, { mode: 0o700 });
  try {
    const snapshot = join(staging, "assets-input");
    await mkdir(snapshot, { mode: 0o700 });
    const captured = await captureMobileAssets(assets, snapshot);
    const binaryPath = join(staging, gatewayName);
    const archivePath = join(staging, assetsName);
    await writeFile(binaryPath, gatewayRead.bytes, { flag: "wx", mode: 0o600 });
    const archive = dependencies.archive ?? runArchive;
    archive({ action: "create", entries: captured.entries, archive: archivePath });
    const packagedAssets = await readStableFile(archivePath);
    await assertMobileArchiveExpansionBudget(packagedAssets.bytes);
    // Verify exact archive membership and captured file hashes with the existing bounded helper.
    const verification = join(staging, "archive-verification");
    archive({
      action: "extract",
      entries: captured.entries,
      archive: archivePath,
      destination: verification,
    });
    for (const entry of captured.entries) {
      if (entry.kind !== "file") continue;
      if ((await readStableFile(join(verification, entry.path))).sha256 !== entry.sha256) {
        throw new Error("Archive payload differs from captured assets.");
      }
    }
    const packagedGateway = await readStableFile(binaryPath);
    await assertMobileAssetsStable(assets, captured);
    const finalGateway = await readStableFile(gateway);
    if (
      finalGateway.identity !== gatewayRead.identity ||
      finalGateway.sha256 !== gatewayRead.sha256 ||
      packagedGateway.sha256 !== gatewayRead.sha256
    )
      throw new Error("Gateway changed before signing.");
    // Signing key changes during the build also fail rather than silently signing under stale input.
    const finalKey = await readSigningKey(keyFile);
    if (
      fingerprint(await lstat(keyFile)) !== keyIdentity ||
      !createPublicKey(finalKey).equals(createPublicKey(signingKey))
    )
      throw new Error("Signing key changed before signing.");
    const artifacts = [
      {
        ...gatewayMetadata,
        sizeBytes: packagedGateway.bytes.length,
        sha256: packagedGateway.sha256,
      },
      { ...assetsMetadata, sizeBytes: packagedAssets.bytes.length, sha256: packagedAssets.sha256 },
    ].map((artifact) => {
      const signed = parseMobileOptionalArtifact({
        ...artifact,
        signature: {
          ...artifact.signature,
          value: sign(
            null,
            Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
            signingKey,
          ).toString("base64"),
        },
      });
      verifyMobileOptionalArtifactSignature(signed, { [input.keyId]: publicKey });
      return signed;
    });
    // Fail before exposing manifests if either private staging member changed after hashing.
    if (
      (await readStableFile(binaryPath)).sha256 !== packagedGateway.sha256 ||
      (await readStableFile(archivePath)).sha256 !== packagedAssets.sha256
    )
      throw new Error("Staging changed before publication.");
    await rename(binaryPath, join(output, gatewayName));
    await rename(archivePath, join(output, assetsName));
    await chmod(join(output, gatewayName), 0o555);
    await chmod(join(output, assetsName), 0o444);
    const manifestPath = join(staging, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, artifacts }, null, 2) + "\n", {
      flag: "wx",
      mode: 0o444,
    });
    await rm(snapshot, { recursive: true });
    await rm(verification, { recursive: true });
    await rename(manifestPath, join(output, "manifest.json"));
    await rm(staging, { recursive: true });
    await chmod(output, 0o555);
    return artifacts;
  } catch (error) {
    // An unsuccessful build is explicitly unpublished; no manifest authorizes partial artifacts.
    await unlink(join(output, "manifest.json")).catch(() => {});
    await writeFile(
      join(output, "UNPUBLISHED.txt"),
      "Build failed. Do not publish or install these staging files.\n",
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw error;
  }
}
