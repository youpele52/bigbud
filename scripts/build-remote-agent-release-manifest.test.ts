import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteAgentInstallSource,
  buildRemoteAgentReleaseManifest,
} from "./build-remote-agent-release-manifest.ts";
import { verifyRemoteAgentReleaseAssets } from "./verify-remote-agent-release-assets.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildRemoteAgentReleaseManifest", () => {
  it("creates signed metadata for both supported Linux targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-manifest-"));
    temporaryDirectories.push(directory);
    const x64Path = join(directory, "x64");
    const arm64Path = join(directory, "arm64");
    writeFileSync(x64Path, "x64-agent");
    writeFileSync(arm64Path, "arm64-agent");
    const keyPair = generateKeyPairSync("ed25519");
    const manifest = buildRemoteAgentReleaseManifest({
      version: "1.2.3-beta.1",
      repository: "youpele52/bigbud",
      signingKeyId: "release-2026",
      signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      assets: [
        { targetTriple: "x86_64-unknown-linux-gnu", path: x64Path },
        { targetTriple: "aarch64-unknown-linux-gnu", path: arm64Path },
      ],
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts.map((artifact) => artifact.targetTriple)).toEqual([
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ]);
    expect(manifest.artifacts.every((artifact) => artifact.signature.algorithm === "ed25519")).toBe(
      true,
    );
    expect(
      verify(
        null,
        Buffer.from(
          [
            manifest.artifacts[0]!.version,
            manifest.artifacts[0]!.protocolMajor,
            manifest.artifacts[0]!.protocolMinor,
            manifest.artifacts[0]!.targetTriple,
            manifest.artifacts[0]!.sizeBytes,
            manifest.artifacts[0]!.sha256,
            "",
            manifest.artifacts[0]!.url,
          ].join("\n"),
        ),
        keyPair.publicKey,
        Buffer.from(manifest.artifacts[0]!.signature.value, "base64"),
      ),
    ).toBe(true);
    const installSource = buildRemoteAgentInstallSource({
      manifest,
      signingKeyId: "release-2026",
      signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    expect(installSource.manifest).toBe(manifest);
    expect(installSource.trustStore["release-2026"]).toContain("BEGIN PUBLIC KEY");

    verifyRemoteAgentReleaseAssets({
      manifestBytes: Buffer.from(JSON.stringify(manifest)),
      signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      signingKeyId: "release-2026",
      assets: [
        { targetTriple: "x86_64-unknown-linux-gnu", path: x64Path },
        { targetTriple: "aarch64-unknown-linux-gnu", path: arm64Path },
      ],
    });
  });

  it("rejects a packaged asset whose bytes differ from the signed manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-manifest-"));
    temporaryDirectories.push(directory);
    const x64Path = join(directory, "x64");
    const arm64Path = join(directory, "arm64");
    writeFileSync(x64Path, "x64-agent");
    writeFileSync(arm64Path, "arm64-agent");
    const keyPair = generateKeyPairSync("ed25519");
    const manifest = buildRemoteAgentReleaseManifest({
      version: "1.2.3",
      repository: "youpele52/bigbud",
      signingKeyId: "release-2026",
      signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      assets: [
        { targetTriple: "x86_64-unknown-linux-gnu", path: x64Path },
        { targetTriple: "aarch64-unknown-linux-gnu", path: arm64Path },
      ],
    });
    writeFileSync(x64Path, "tampered");
    expect(() =>
      verifyRemoteAgentReleaseAssets({
        manifestBytes: Buffer.from(JSON.stringify(manifest)),
        signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        signingKeyId: "release-2026",
        assets: [
          { targetTriple: "x86_64-unknown-linux-gnu", path: x64Path },
          { targetTriple: "aarch64-unknown-linux-gnu", path: arm64Path },
        ],
      }),
    ).toThrow("size mismatch");
  });
});
