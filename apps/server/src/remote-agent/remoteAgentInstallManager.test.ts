import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  makeRemoteAgentInstallManager,
  parseRemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import type { RemoteAgentInstallPaths } from "./remoteAgentInstall.ts";

const bytes = new Uint8Array([1, 2, 3]);
const artifact = {
  version: "0.1.0",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "signature" },
  bundledPath: "agent",
};
const paths = {
  root: "$HOME/.bigbud/agent",
  binRoot: "$HOME/.bigbud/agent/bin",
  stateRoot: "$HOME/.bigbud/agent/state",
  versionRoot: "$HOME/.bigbud/agent/bin/0.1.0",
  stagedBinary: "$HOME/.bigbud/agent/bin/0.1.0/stage",
  installedBinary: "$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent",
  activeLink: "$HOME/.bigbud/agent/bin/current",
  previousLink: "$HOME/.bigbud/agent/bin/previous",
} satisfies RemoteAgentInstallPaths;

describe("remote agent installation manager", () => {
  it("probes, selects, installs, and activates the matching artifact", async () => {
    const runRemoteCommand = vi.fn(async (input: unknown) => {
      void input;
    });
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      readArtifactBytes: async () => bytes,
      installArtifact,
      runRemoteCommand,
      verifyInstalledAgent: async () => undefined,
    });

    const result = await manager.install({
      executionTargetId: "ssh:example",
      source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
    });

    expect(result.binaryPath).toBe(paths.activeLink);
    expect(installArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: "ssh:example",
        targetTriple: artifact.targetTriple,
      }),
    );
    expect(runRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: "ssh:example", command: "sh" }),
    );
  });

  it("requires the installed candidate check before reporting success", async () => {
    const runRemoteCommand = vi.fn(async (input: unknown) => ({
      input,
      stdout: "bigbud-remote-agent 0.1.0 1 0 0.1.0\n",
    }));
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      readArtifactBytes: async () => bytes,
      installArtifact: async () => paths,
      runRemoteCommand,
    });

    await manager.install({
      executionTargetId: "ssh:example",
      source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
    });

    expect(runRemoteCommand).toHaveBeenCalledTimes(2);
    expect(runRemoteCommand.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("--check")] }),
    );
  });

  it("limits signature bypass to an internally marked development source", async () => {
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      readArtifactBytes: async () => bytes,
      installArtifact,
      runRemoteCommand: async () => undefined,
      verifyInstalledAgent: async () => undefined,
    });

    await manager.install({
      executionTargetId: "ssh:example",
      source: {
        manifest: { schemaVersion: 1, artifacts: [artifact] },
        trustStore: {},
        allowUntrustedDevelopmentArtifact: true,
      },
    });

    expect(installArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ skipSignatureVerification: true }),
    );
  });

  it("rolls back when the activated candidate fails its handshake", async () => {
    const runRemoteCommand = vi.fn(async (input: unknown) => {
      void input;
    });
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      readArtifactBytes: async () => bytes,
      installArtifact: async () => paths,
      runRemoteCommand,
      verifyInstalledAgent: async () => {
        throw new Error("candidate mismatch");
      },
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      }),
    ).rejects.toThrow("candidate failed verification");
    expect(runRemoteCommand).toHaveBeenCalledTimes(2);
    expect(runRemoteCommand.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        args: ["-lc", expect.stringContaining("rollback")],
      }),
    );
  });

  it("does not mutate an unsupported target", async () => {
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "darwin",
        architecture: "arm64",
        targetTriple: null,
      }),
      installArtifact,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      }),
    ).rejects.toThrow("unsupported");
    expect(installArtifact).not.toHaveBeenCalled();
  });

  it("stops downloading when an artifact exceeds its signed length", async () => {
    const installArtifact = vi.fn(async () => paths);
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      installArtifact,
      runRemoteCommand: async () => undefined,
      verifyInstalledAgent: async () => undefined,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: {
          manifest: {
            schemaVersion: 1,
            artifacts: [
              {
                version: artifact.version,
                protocolMajor: artifact.protocolMajor,
                protocolMinor: artifact.protocolMinor,
                targetTriple: artifact.targetTriple,
                sizeBytes: 2,
                sha256: artifact.sha256,
                signature: artifact.signature,
                url: "data:application/octet-stream;base64,AQID",
              },
            ],
          },
          trustStore: {},
        },
      }),
    ).rejects.toThrow("signed manifest length");
    expect(installArtifact).not.toHaveBeenCalled();
  });

  it("validates manifest and trust-store input before installation", () => {
    expect(() => parseRemoteAgentInstallSource({ manifest: {}, trustStore: {} })).toThrow(
      "manifest schema",
    );
    expect(() =>
      parseRemoteAgentInstallSource({ manifest: { schemaVersion: 1, artifacts: [] } }),
    ).toThrow("trust store");
  });
});
