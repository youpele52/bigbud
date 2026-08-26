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
  buildDigest: "build-0.1.0",
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
  buildRoot: `$HOME/.bigbud/agent/bin/0.1.0/${artifact.sha256}`,
  installedBinary: `$HOME/.bigbud/agent/bin/0.1.0/${artifact.sha256}/bigbud-remote-agent`,
  activeLink: "$HOME/.bigbud/agent/bin/current",
  previousLink: "$HOME/.bigbud/agent/bin/previous",
} satisfies RemoteAgentInstallPaths;

function successfulRemoteCommand(input: unknown) {
  const script =
    typeof input === "object" && input !== null && "args" in input
      ? String((input as { args?: readonly string[] }).args?.[1] ?? "")
      : "";
  if (script.includes("printf 'activated\n'")) return { stdout: "activated\n" };
  if (script.includes("--check")) {
    return { stdout: "bigbud-remote-agent 0.1.0 1 0 build-0.1.0 linux x86_64\n" };
  }
  if (script.includes("printf 'finalized\n'")) return { stdout: "finalized\n" };
  if (script.includes('"$recovery_status"')) return { stdout: "restored\n" };
  return { stdout: "" };
}

describe("remote agent installation manager", () => {
  it("probes, selects, installs, and activates the matching artifact", async () => {
    const runRemoteCommand = vi.fn(async (input: unknown) => successfulRemoteCommand(input));
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
    expect(runRemoteCommand.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining(artifact.sha256)] }),
    );
  });

  it("requires the installed candidate check before reporting success", async () => {
    const runRemoteCommand = vi.fn(async (input: unknown) => successfulRemoteCommand(input));
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

    expect(runRemoteCommand).toHaveBeenCalledTimes(4);
    expect(runRemoteCommand.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("--check")] }),
    );
    expect(runRemoteCommand.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("--prepare-supervisor")] }),
    );
    expect(runRemoteCommand.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("finalized")] }),
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
      runRemoteCommand: async (input) => successfulRemoteCommand(input),
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
    const runRemoteCommand = vi.fn(async (input: unknown) => successfulRemoteCommand(input));
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
    expect(runRemoteCommand).toHaveBeenCalledTimes(3);
    expect(runRemoteCommand.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        args: ["-lc", expect.stringContaining("activation.pending")],
      }),
    );
    expect(runRemoteCommand.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("--prepare-supervisor")] }),
    );
  });

  it("does not roll back an unchanged active candidate after verification fails", async () => {
    const runRemoteCommand = vi.fn(async (_input: unknown) => ({ stdout: "unchanged\n" }));
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
      expect.objectContaining({ args: ["-lc", expect.stringContaining("activation.pending")] }),
    );
  });

  it("attempts recovery when activation fails before reporting whether the link changed", async () => {
    const runRemoteCommand = vi.fn(async (_input: unknown) => {
      if (runRemoteCommand.mock.calls.length === 1) throw new Error("activation failed");
      return { stdout: "unchanged\n" };
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
      verifyInstalledAgent: async () => undefined,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      }),
    ).rejects.toThrow("candidate failed verification: activation failed");
    expect(runRemoteCommand).toHaveBeenCalledTimes(2);
    expect(runRemoteCommand.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("activation.pending")] }),
    );
  });

  it("recovers the previous agent when supervisor preparation fails", async () => {
    let supervisorPreparations = 0;
    const runRemoteCommand = vi.fn(async (input: unknown) => {
      const script = String((input as { args?: readonly string[] }).args?.[1] ?? "");
      if (script.includes("--prepare-supervisor")) {
        supervisorPreparations += 1;
        if (supervisorPreparations === 1) throw new Error("supervisor failed");
      }
      return successfulRemoteCommand(input);
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
      verifyInstalledAgent: async () => undefined,
    });

    await expect(
      manager.install({
        executionTargetId: "ssh:example",
        source: { manifest: { schemaVersion: 1, artifacts: [artifact] }, trustStore: {} },
      }),
    ).rejects.toThrow("candidate failed verification: supervisor failed");
    expect(runRemoteCommand).toHaveBeenCalledTimes(4);
    expect(runRemoteCommand.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("activation.pending")] }),
    );
    expect(runRemoteCommand.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ args: ["-lc", expect.stringContaining("--prepare-supervisor")] }),
    );
  });

  it("serializes the full installation transaction per execution target", async () => {
    let releaseFirst!: () => void;
    const firstVerificationGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const installArtifact = vi.fn(async () => paths);
    let verificationCount = 0;
    const verifyInstalledAgent = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 1) await firstVerificationGate;
    });
    const manager = makeRemoteAgentInstallManager({
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "x86_64",
        targetTriple: "x86_64-unknown-linux-gnu",
      }),
      readArtifactBytes: async () => bytes,
      installArtifact,
      runRemoteCommand: async (input) => successfulRemoteCommand(input),
      verifyInstalledAgent,
    });
    const input = {
      executionTargetId: "ssh:example",
      source: { manifest: { schemaVersion: 1 as const, artifacts: [artifact] }, trustStore: {} },
    };

    const first = manager.install(input);
    await vi.waitFor(() => expect(verifyInstalledAgent).toHaveBeenCalledOnce());
    const second = manager.install(input);
    await Promise.resolve();
    expect(installArtifact).toHaveBeenCalledOnce();
    releaseFirst();
    await Promise.all([first, second]);

    expect(installArtifact).toHaveBeenCalledTimes(2);
    expect(verifyInstalledAgent).toHaveBeenCalledTimes(2);
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
                buildDigest: artifact.buildDigest,
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
