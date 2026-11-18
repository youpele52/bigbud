import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PINNED_RELEASE_TRUST_STORE } from "@bigbud/shared/releaseTrust";
import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteAgentReleaseManifest } from "./build-remote-agent-release-manifest.ts";
import { verifyReleaseSigningKeyPin } from "./verify-release-signing-key-pin.ts";
import { verifyRemoteAgentReleaseAssets } from "./verify-remote-agent-release-assets.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function signedRelease(signingKeyId: string) {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-release-pin-"));
  directories.push(directory);
  const assets = (["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] as const).map(
    (targetTriple) => {
      const path = join(directory, targetTriple);
      writeFileSync(path, `${targetTriple}-agent`);
      return { targetTriple, path };
    },
  );
  const signingKeyPem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const input = {
    version: "1.2.3",
    buildDigest: "0123456789abcdef0123456789abcdef01234567",
    repository: "youpele52/bigbud",
    signingKeyId,
    signingKeyPem,
    assets,
  };
  const manifest = buildRemoteAgentReleaseManifest(input);
  return { ...input, manifestBytes: Buffer.from(JSON.stringify(manifest)) };
}

const publicPem = (privatePem: string) =>
  createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();

describe("release signing key pin guard", () => {
  it("refuses a release signed under the pinned id with a different key", () => {
    expect(() => verifyRemoteAgentReleaseAssets(signedRelease("release-2026"))).toThrow(
      "Release signing key 'release-2026' is not pinned",
    );
  });

  it("refuses a release signed with an unpinned key id", () => {
    const release = signedRelease("release-2099");
    expect(() => verifyRemoteAgentReleaseAssets(release)).toThrow("'release-2099' is not pinned");
    // Even when the key material itself is pinned under another id.
    expect(() =>
      verifyRemoteAgentReleaseAssets({
        ...release,
        pinnedTrustStore: { "release-2026": publicPem(release.signingKeyPem) },
      }),
    ).toThrow("is not pinned");
  });

  it("accepts a release whose key is in the pinned set", () => {
    const release = signedRelease("release-2026");
    expect(() =>
      verifyRemoteAgentReleaseAssets({
        ...release,
        pinnedTrustStore: { "release-2026": publicPem(release.signingKeyPem) },
      }),
    ).not.toThrow();
  });

  it("guards the backend graph signing key the same way", () => {
    const { signingKeyPem } = signedRelease("release-2026");
    expect(() =>
      verifyReleaseSigningKeyPin({ signingKeyPem, signingKeyId: "release-2026" }),
    ).toThrow("Ship an app release that pins the key");
    expect(() =>
      verifyReleaseSigningKeyPin({
        signingKeyPem,
        signingKeyId: "release-2026",
        pinnedTrustStore: { "release-2026": publicPem(signingKeyPem) },
      }),
    ).not.toThrow();
    expect(PINNED_RELEASE_TRUST_STORE["release-2026"]).toContain("BEGIN PUBLIC KEY");
  });
});
