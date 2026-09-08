import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";

const bytes = new Uint8Array([1, 2, 3]);
const artifact = {
  version: "1.2.3",
  buildDigest: "build-1.2.3",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "invalid" },
  bundledPath: "agent",
};

function platform() {
  return Promise.resolve({
    operatingSystem: "linux" as const,
    architecture: "x86_64" as const,
    targetTriple: artifact.targetTriple,
  });
}

describe("remote agent install integrity boundary", () => {
  it("rejects an untrusted signature before downloading or mutating", async () => {
    const readArtifactBytes = vi.fn(async () => bytes);
    const installArtifact = vi.fn();
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes,
      installArtifact,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      }),
    ).rejects.toThrow("trusted public key");
    expect(readArtifactBytes).not.toHaveBeenCalled();
    expect(installArtifact).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch without retrying or mutating", async () => {
    const readArtifactBytes = vi.fn(async () => new Uint8Array([3, 2, 1]));
    const installArtifact = vi.fn();
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes,
      installArtifact,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: {
          manifest: { schemaVersion: 1, artifacts: [artifact] },
          trustStore: {},
          allowUntrustedDevelopmentArtifact: true,
        },
      }),
    ).rejects.toThrow("SHA-256");
    expect(readArtifactBytes).toHaveBeenCalledOnce();
    expect(installArtifact).not.toHaveBeenCalled();
  });
});
