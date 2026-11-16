import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteAgentInstallSource,
  buildRemoteAgentReleaseManifest,
  parseRemoteAgentReleaseProtocol,
} from "./build-remote-agent-release-manifest.ts";
import { verifyRemoteAgentReleaseAssets } from "./verify-remote-agent-release-assets.ts";
import { resolveReleaseMetadata } from "./lib/release-metadata.ts";

const temporaryDirectories: string[] = [];

function protocolSource(minor: string): string {
  return `pub const PROTOCOL_MAJOR: u32 = 1;\npub const PROTOCOL_MINOR: u32 = ${minor};\n`;
}

function releaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-release-verification-"));
  temporaryDirectories.push(directory);
  const assets = (["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] as const).map(
    (targetTriple) => {
      const path = join(directory, targetTriple);
      writeFileSync(path, `${targetTriple}-agent`);
      return { targetTriple, path };
    },
  );
  const keyPair = generateKeyPairSync("ed25519");
  const signingKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const input = {
    version: "1.2.3",
    buildDigest: "0123456789abcdef0123456789abcdef01234567",
    repository: "youpele52/bigbud",
    signingKeyId: "release-fixture",
    signingKeyPem,
    assets,
  };
  const manifest = buildRemoteAgentReleaseManifest(input);
  const installSource = buildRemoteAgentInstallSource({ ...input, manifest });
  return {
    ...input,
    manifest,
    installSource,
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    installSourceBytes: Buffer.from(JSON.stringify(installSource)),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildRemoteAgentReleaseManifest", () => {
  it.each(["v0.3.01", "v0.4.00"])("rejects mismatched tag %s before signing", (tag) => {
    expect(() =>
      buildRemoteAgentReleaseManifest({
        version: "0.3.0",
        tag,
        buildDigest: "0123456789abcdef0123456789abcdef01234567",
        repository: "youpele52/bigbud",
        signingKeyId: "release-2026",
        signingKeyPem: "",
        assets: [],
      }),
    ).toThrow("Release tag must match the canonical release version.");
  });
  it.each(["v1.2.3-beta.1", "v0.3.00"])("roundtrips signed metadata for %s", (tag) => {
    const release = resolveReleaseMetadata(tag);
    const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-manifest-"));
    temporaryDirectories.push(directory);
    const x64Path = join(directory, "x64");
    const arm64Path = join(directory, "arm64");
    writeFileSync(x64Path, "x64-agent");
    writeFileSync(arm64Path, "arm64-agent");
    const keyPair = generateKeyPairSync("ed25519");
    const manifest = buildRemoteAgentReleaseManifest({
      version: release.version,
      tag: release.tag,
      buildDigest: "0123456789abcdef0123456789abcdef01234567",
      repository: "youpele52/bigbud",
      signingKeyId: "release-2026",
      signingKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      assets: [
        { targetTriple: "x86_64-unknown-linux-gnu", path: x64Path },
        { targetTriple: "aarch64-unknown-linux-gnu", path: arm64Path },
      ],
    });

    expect(manifest.schemaVersion).toBe(1);
    for (const artifact of manifest.artifacts) {
      expect(artifact.version).toBe(release.version);
      expect(artifact.protocolMajor).toBe(1);
      // Read declarations rather than importing server code across the scripts
      // package's composite TypeScript boundary. Both sources must match signed metadata.
      const rustProtocol = readFileSync(
        new URL("../crates/bigbud-protocol/src/lib.rs", import.meta.url),
        "utf8",
      );
      const serverProtocol = readFileSync(
        new URL("../apps/server/src/remote-agent/remoteAgentProtocol.ts", import.meta.url),
        "utf8",
      );
      for (const [name, version] of [
        ["MAJOR", artifact.protocolMajor],
        ["MINOR", artifact.protocolMinor],
      ] as const) {
        expect(rustProtocol).toMatch(new RegExp(`pub const PROTOCOL_${name}: u32 = ${version};`));
        expect(serverProtocol).toMatch(
          new RegExp(`export const REMOTE_AGENT_PROTOCOL_${name} = ${version};`),
        );
      }
      expect(artifact.url).toBe(
        `https://github.com/youpele52/bigbud/releases/download/${tag}/bigbud-remote-agent-${release.version}-${artifact.targetTriple}`,
      );
    }
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
            manifest.artifacts[0]!.buildDigest,
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
      installSourceBytes: Buffer.from(JSON.stringify(installSource)),
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
      buildDigest: "0123456789abcdef0123456789abcdef01234567",
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

  it("signs and verifies the musl-aware v2 manifest with all four targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-manifest-"));
    temporaryDirectories.push(directory);
    const targets = [
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ] as const;
    const assets = targets.map((targetTriple) => {
      const path = join(directory, targetTriple);
      writeFileSync(path, `${targetTriple}-agent`);
      return { targetTriple, path };
    });
    const keyPair = generateKeyPairSync("ed25519");
    const signingKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const manifest = buildRemoteAgentReleaseManifest({
      version: "1.2.3",
      buildDigest: "0123456789abcdef0123456789abcdef01234567",
      repository: "youpele52/bigbud",
      signingKeyId: "release-2026",
      signingKeyPem,
      assets,
    });
    expect(manifest.artifacts.map((artifact) => artifact.targetTriple)).toEqual(targets);
    verifyRemoteAgentReleaseAssets({
      manifestBytes: Buffer.from(JSON.stringify(manifest)),
      signingKeyPem,
      signingKeyId: "release-2026",
      assets,
    });
  });

  it("verifies the musl-only pair after the transition release", () => {
    expect(() => verifyRemoteAgentReleaseAssets(releaseFixture())).not.toThrow();
  });

  it("rejects duplicate packaged target inputs even when every target is present", () => {
    const fixture = releaseFixture();
    expect(() =>
      verifyRemoteAgentReleaseAssets({
        ...fixture,
        assets: [...fixture.assets, fixture.assets[0]!],
      }),
    ).toThrow("duplicate target");
  });

  it.each(["manifest", "install source"])("rejects unknown targets in the %s", (location) => {
    const fixture = releaseFixture();
    const extendedManifest = {
      ...fixture.manifest,
      artifacts: [
        ...fixture.manifest.artifacts,
        { ...fixture.manifest.artifacts[0], targetTriple: "riscv64gc-unknown-linux-musl" },
      ],
    };
    expect(() =>
      verifyRemoteAgentReleaseAssets({
        ...fixture,
        ...(location === "manifest"
          ? { manifestBytes: Buffer.from(JSON.stringify(extendedManifest)) }
          : {
              installSourceBytes: Buffer.from(
                JSON.stringify({ ...fixture.installSource, manifest: extendedManifest }),
              ),
            }),
      }),
    ).toThrow("unsupported target");
  });

  it("rejects a missing packaged target", () => {
    const fixture = releaseFixture();
    expect(() =>
      verifyRemoteAgentReleaseAssets({ ...fixture, assets: fixture.assets.slice(0, 1) }),
    ).toThrow("target sets do not match");
  });
});

describe("parseRemoteAgentReleaseProtocol", () => {
  it("follows a future binary minor without a separate release constant", () => {
    expect(parseRemoteAgentReleaseProtocol(protocolSource("7"))).toEqual({
      protocolMajor: 1,
      protocolMinor: 7,
    });
  });

  it("accepts a checkout with CRLF line endings", () => {
    expect(parseRemoteAgentReleaseProtocol(protocolSource("6").replaceAll("\n", "\r\n"))).toEqual({
      protocolMajor: 1,
      protocolMinor: 6,
    });
  });

  it.each(["-1", "1.5", "4294967296", "99999999999999999999", "unknown"])(
    "refuses an invalid u32 minor %s",
    (minor) => {
      expect(() => parseRemoteAgentReleaseProtocol(protocolSource(minor))).toThrow(
        "Cannot determine the release protocol minor identity",
      );
    },
  );

  it.each(["MAJOR", "MINOR"])("refuses missing or duplicate %s declarations", (name) => {
    const declaration = `pub const PROTOCOL_${name}: u32 = ${name === "MAJOR" ? 1 : 6};`;
    expect(() =>
      parseRemoteAgentReleaseProtocol(protocolSource("6").replace(declaration, "")),
    ).toThrow("Cannot determine the release protocol");
    expect(() => parseRemoteAgentReleaseProtocol(`${protocolSource("6")}${declaration}\n`)).toThrow(
      "Cannot determine the release protocol",
    );
  });

  it("refuses an unsupported binary major instead of signing compatible metadata", () => {
    expect(() =>
      parseRemoteAgentReleaseProtocol(
        protocolSource("6").replace("MAJOR: u32 = 1", "MAJOR: u32 = 2"),
      ),
    ).toThrow("Release protocol major is not supported");
  });
});
