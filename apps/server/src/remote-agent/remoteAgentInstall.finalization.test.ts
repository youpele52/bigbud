import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { type RemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";

const bytes = new Uint8Array([4, 5, 6]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const artifact = {
  version: "0.2.0",
  buildDigest: "build-0.2.0",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: bytes.byteLength,
  sha256,
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "signature" },
  bundledPath: "agent",
};
const candidate = `$HOME/.bigbud/agent/bin/0.2.0/${sha256}/bigbud-remote-agent`;
const paths = {
  root: "$HOME/.bigbud/agent",
  binRoot: "$HOME/.bigbud/agent/bin",
  stateRoot: "$HOME/.bigbud/agent/state",
  versionRoot: "$HOME/.bigbud/agent/bin/0.2.0",
  buildRoot: `$HOME/.bigbud/agent/bin/0.2.0/${sha256}`,
  installedBinary: candidate,
  activeLink: "$HOME/.bigbud/agent/bin/current",
  previousLink: "$HOME/.bigbud/agent/bin/previous",
} satisfies RemoteAgentInstallPaths;

function makeFinalizeLossFixture(initialCurrent: string | null, failVerificationAt?: number) {
  const state: {
    current: string | null;
    pending: boolean;
    previous: string | null;
  } = { current: initialCurrent, pending: false, previous: null };
  let finalizeAttempts = 0;
  let recoveryAttempts = 0;
  let verificationCount = 0;
  const verifyInstalledAgent = vi.fn(async () => {
    verificationCount += 1;
    expect(state.current).toBe(candidate);
    if (verificationCount === failVerificationAt) throw new Error("identity response lost");
  });
  const runRemoteCommand = vi.fn(async (input: unknown) => {
    const script = String((input as { args?: readonly string[] }).args?.[1] ?? "");
    if (script.includes("printf 'activated\n'")) {
      if (state.current === candidate) return { stdout: "unchanged\n" };
      state.previous = state.current;
      state.current = candidate;
      state.pending = true;
      return { stdout: "activated\n" };
    }
    if (script.includes("printf 'finalized\n'")) {
      state.pending = false;
      finalizeAttempts += 1;
      if (finalizeAttempts <= 2) throw new Error("finalize response lost");
      return { stdout: "unchanged\n" };
    }
    if (script.includes("printf 'active\n'")) {
      return {
        stdout: state.pending
          ? "pending\n"
          : state.current === candidate
            ? "active\n"
            : "baseline\n",
      };
    }
    if (script.includes('"$recovery_status"')) {
      recoveryAttempts += 1;
      state.pending = false;
      if (state.current !== candidate) return { stdout: "baseline\n" };
      state.current = state.previous;
      return { stdout: state.current === null ? "removed\n" : "restored\n" };
    }
    return { stdout: "" };
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
    verifyInstalledAgent,
  });
  const input = {
    executionTargetId: "ssh:example",
    source: { manifest: { schemaVersion: 1 as const, artifacts: [artifact] }, trustStore: {} },
  };
  return {
    input,
    manager,
    state,
    verifyInstalledAgent,
    recoveryAttempts: () => recoveryAttempts,
    finalizeAttempts: () => finalizeAttempts,
  };
}

describe("remote agent committed finalization reconciliation", () => {
  it.each([
    { name: "upgrade", initialCurrent: "baseline-agent" },
    { name: "first install", initialCurrent: null },
  ])(
    "reports a committed $name as successful after both finalize responses are lost",
    async ({ initialCurrent }) => {
      const fixture = makeFinalizeLossFixture(initialCurrent);

      await expect(fixture.manager.install(fixture.input)).resolves.toMatchObject({
        binaryPath: paths.activeLink,
      });
      expect(fixture.state).toEqual({
        current: candidate,
        pending: false,
        previous: initialCurrent,
      });
      expect(fixture.verifyInstalledAgent).toHaveBeenCalledTimes(2);
      expect(fixture.recoveryAttempts()).toBe(0);

      await expect(fixture.manager.install(fixture.input)).resolves.toMatchObject({
        binaryPath: paths.activeLink,
      });
      expect(fixture.state).toEqual({
        current: candidate,
        pending: false,
        previous: initialCurrent,
      });
      expect(fixture.verifyInstalledAgent).toHaveBeenCalledTimes(3);
      expect(fixture.finalizeAttempts()).toBe(3);
      expect(fixture.recoveryAttempts()).toBe(0);
    },
  );

  it.each([
    { name: "upgrade", initialCurrent: "baseline-agent" },
    { name: "first install", initialCurrent: null },
  ])(
    "restores the baseline when committed $name identity cannot be proven",
    async ({ initialCurrent }) => {
      const fixture = makeFinalizeLossFixture(initialCurrent, 2);

      await expect(fixture.manager.install(fixture.input)).rejects.toThrow(
        "identity response lost",
      );
      expect(fixture.state).toEqual({
        current: initialCurrent,
        pending: false,
        previous: initialCurrent,
      });
      expect(fixture.recoveryAttempts()).toBe(1);

      await expect(fixture.manager.install(fixture.input)).resolves.toMatchObject({
        binaryPath: paths.activeLink,
      });
      expect(fixture.state).toEqual({
        current: candidate,
        pending: false,
        previous: initialCurrent,
      });
    },
  );
});
