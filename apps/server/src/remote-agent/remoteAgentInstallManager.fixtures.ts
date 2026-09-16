import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { buildRemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";

export const bytes = new Uint8Array([1, 2, 3]);
export const artifact = {
  version: "0.2.207",
  buildDigest: "fixture",
  protocolMajor: 1,
  protocolMinor: 2,
  targetTriple: "aarch64-unknown-linux-gnu" as const,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "test", value: "fixture" },
  bundledPath: "fixture",
};
export const source = {
  manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
  trustStore: {},
  allowUntrustedDevelopmentArtifact: true as const,
};
export const paths = buildRemoteAgentInstallPaths(artifact);
export const installInput = { executionTargetId: "ssh:fixture", source };

export function installManagerFixture(
  overrides: Parameters<typeof makeRemoteAgentInstallManager>[0] = {},
) {
  let state = emptyRemoteAgentRegistry();
  const control: RemoteAgentControl = {
    root: "/tmp/home/.bigbud/agent",
    run: vi.fn(async () => ""),
    registry: {
      read: async () => state,
      update: async (transition) => {
        state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
        return state;
      },
    },
  };
  const installArtifact = vi.fn(async () => paths);
  const verifyInstalledAgent = vi.fn(async () => undefined);
  const runRemoteCommand = vi.fn(async () => ({
    stdout: "bigbud-remote-agent 0.2.207 1 2 fixture linux aarch64",
  }));
  const manager = makeRemoteAgentInstallManager({
    probePlatform: async () => ({
      operatingSystem: "linux",
      architecture: "aarch64",
      targetTriple: artifact.targetTriple,
    }),
    readArtifactBytes: async () => bytes,
    installArtifact,
    verifyInstalledAgent,
    runRemoteCommand,
    openControl: async () => control,
    ...overrides,
  });
  return { manager, control, installArtifact, verifyInstalledAgent, runRemoteCommand };
}
