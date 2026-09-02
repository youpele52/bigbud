import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import type { RemoteAgentInstallPaths } from "./remoteAgentInstall.ts";

const bytes = new Uint8Array([1, 2]);
const artifact = {
  version: "1.2.3",
  buildDigest: "build-1.2.3",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "signature" },
  bundledPath: "agent",
};
const source = {
  manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
  trustStore: {},
  allowUntrustedDevelopmentArtifact: true as const,
};
const paths = {
  root: "root",
  binRoot: "bin",
  stateRoot: "state",
  versionRoot: "version",
  buildRoot: "build",
  installedBinary: "installed",
  activeLink: "active",
  previousLink: "previous",
} satisfies RemoteAgentInstallPaths;

function platform() {
  return Promise.resolve({
    operatingSystem: "linux" as const,
    architecture: "x86_64" as const,
    targetTriple: artifact.targetTriple,
  });
}

describe("remote agent install cancellation boundary", () => {
  it("cancels before remote mutation", async () => {
    const controller = new AbortController();
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes: async (_artifact, signal) => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw signal?.reason;
      },
      installArtifact,
    });

    await expect(
      manager.install({ executionTargetId: "ssh:example", source, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(installArtifact).not.toHaveBeenCalled();
  });

  it("honors cancellation while waiting for the per-target install lock", async () => {
    let releaseVerification!: () => void;
    let verificationStarted!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const readArtifactBytes = vi.fn(async () => bytes);
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes,
      installArtifact,
      runRemoteCommand: async (input) => {
        const script = String(input.args?.[1]);
        if (script.includes("activated")) return { stdout: "activated\n" };
        if (script.includes("finalized")) return { stdout: "finalized\n" };
        return { stdout: "" };
      },
      verifyInstalledAgent: async () => {
        verificationStarted();
        await verificationGate;
      },
    });
    const first = manager.install({ executionTargetId: "ssh:example", source });
    await started;
    const controller = new AbortController();
    const second = manager.install({
      executionTargetId: "ssh:example",
      source,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    releaseVerification();

    await expect(first).resolves.toMatchObject({ artifact: { version: artifact.version } });
    await expect(second).rejects.toThrow("cancelled");
    expect(readArtifactBytes).toHaveBeenCalledOnce();
    expect(installArtifact).toHaveBeenCalledOnce();
  });

  it("completes activation after mutation begins despite caller cancellation", async () => {
    const controller = new AbortController();
    const runRemoteCommand = vi.fn(async (input: { args?: readonly string[] }) => {
      const script = String(input.args?.[1]);
      if (script.includes("activated")) return { stdout: "activated\n" };
      if (script.includes("finalized")) return { stdout: "finalized\n" };
      return { stdout: "" };
    });
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes: async () => bytes,
      installArtifact: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return paths;
      },
      runRemoteCommand,
      verifyInstalledAgent: async () => undefined,
    });

    await expect(
      manager.install({ executionTargetId: "ssh:example", source, signal: controller.signal }),
    ).resolves.toMatchObject({ artifact: { version: artifact.version } });
    expect(runRemoteCommand).toHaveBeenCalledTimes(3);
  });

  it("rolls back after mutation begins despite caller cancellation", async () => {
    const controller = new AbortController();
    const runRemoteCommand = vi.fn(async (input: { args?: readonly string[] }) => {
      const script = String(input.args?.[1]);
      if (script.includes("activated")) return { stdout: "activated\n" };
      if (script.includes("recovery_status")) return { stdout: "restored\n" };
      return { stdout: "" };
    });
    const manager = makeRemoteAgentInstallManager({
      probePlatform: platform,
      readArtifactBytes: async () => bytes,
      installArtifact: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return paths;
      },
      runRemoteCommand,
      verifyInstalledAgent: async () => {
        throw new Error("candidate mismatch");
      },
    });

    await expect(
      manager.install({ executionTargetId: "ssh:example", source, signal: controller.signal }),
    ).rejects.toThrow("candidate failed verification");
    expect(runRemoteCommand).toHaveBeenCalledTimes(3);
  });
});
