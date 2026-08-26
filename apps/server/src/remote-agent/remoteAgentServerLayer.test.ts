import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeConfiguredRemoteAgentLayers,
  makeRemoteAgentHealth,
  makeRemoteAgentInstaller,
} from "./remoteAgentServerLayer.ts";
import { closeConfiguredRemoteAgentCompositions } from "./remoteAgentDefault.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import { RemoteAgentConnectionError, type RemoteAgentConnection } from "./remoteAgentConnection.ts";

const originalBinary = process.env.BIGBUD_REMOTE_AGENT_BINARY;
const originalTransport = process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;
const artifact = {
  version: "0.2.0",
  buildDigest: "target-digest",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: 1,
  sha256: "0".repeat(64),
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "signature" },
  bundledPath: "agent",
};
const source: RemoteAgentInstallSource = {
  manifest: { schemaVersion: 1, artifacts: [artifact] },
  trustStore: {},
  allowUntrustedDevelopmentArtifact: true,
};

function healthFixture(identity?: {
  readonly agentVersion?: string;
  readonly buildDigest?: string;
  readonly agentEpoch?: string;
}) {
  const pool = {
    get: vi.fn(async () => undefined),
    snapshot: vi.fn(
      () =>
        identity ?? {
          agentVersion: artifact.version,
          buildDigest: artifact.buildDigest,
          agentEpoch: "epoch-1",
        },
    ),
  };
  const resolveArtifact = vi.fn(async () => ({
    platform: {
      operatingSystem: "linux",
      architecture: "x86_64",
      targetTriple: artifact.targetTriple,
    },
    targetTriple: artifact.targetTriple,
    artifact,
  }));
  const loadInstallSource = vi.fn(async () => source);
  const runIdentityProbe = vi.fn(
    async () =>
      `bigbud-remote-agent ${artifact.version} ${artifact.protocolMajor} ${artifact.protocolMinor} ${artifact.buildDigest} linux x86_64\n`,
  );
  return {
    pool,
    resolveArtifact,
    loadInstallSource,
    runIdentityProbe,
    health: makeRemoteAgentHealth({
      binaryPath: "$HOME/.bigbud/agent/bin/current",
      pool,
      resolveArtifact,
      loadInstallSource,
      runIdentityProbe,
    }),
  };
}

afterEach(() => {
  if (originalBinary === undefined) delete process.env.BIGBUD_REMOTE_AGENT_BINARY;
  else process.env.BIGBUD_REMOTE_AGENT_BINARY = originalBinary;
  if (originalTransport === undefined) delete process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;
  else process.env.BIGBUD_REMOTE_AGENT_TRANSPORT = originalTransport;
  closeConfiguredRemoteAgentCompositions();
});

describe("configured remote agent server layer", () => {
  it("enables the managed remote agent path by default", () => {
    delete process.env.BIGBUD_REMOTE_AGENT_BINARY;
    delete process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(true);
  });

  it("accepts an explicit agent binary without starting a connection", () => {
    process.env.BIGBUD_REMOTE_AGENT_BINARY = "$HOME/.bigbud/agent/bin/current";
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(true);
  });

  it("retains direct ssh as an explicit diagnostic fallback", () => {
    process.env.BIGBUD_REMOTE_AGENT_TRANSPORT = "direct-ssh";
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(false);
  });
});

describe("remote agent health", () => {
  it("reports a missing binary without connecting or loading release metadata", async () => {
    const fixture = healthFixture();
    fixture.runIdentityProbe.mockResolvedValue("missing");

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "install-required",
    });
    expect(fixture.pool.get).not.toHaveBeenCalled();
    expect(fixture.loadInstallSource).not.toHaveBeenCalled();
  });

  it("reports ready only when version and build digest match the signed artifact", async () => {
    const fixture = healthFixture();

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "ready",
      agentVersion: artifact.version,
      buildDigest: artifact.buildDigest,
      agentEpoch: "epoch-1",
    });
    expect(fixture.resolveArtifact).toHaveBeenCalledWith({
      executionTargetId: "ssh:example",
      source,
      verifySignature: true,
    });
  });

  it.each([
    ["version", { agentVersion: "0.1.0", buildDigest: artifact.buildDigest }],
    ["digest", { agentVersion: artifact.version, buildDigest: "old-digest" }],
  ])("requires an upgrade for a mismatched %s", async (_label, identity) => {
    const fixture = healthFixture({ ...identity, agentEpoch: "epoch-1" });

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "upgrade-required",
      currentVersion: identity.agentVersion,
      targetVersion: artifact.version,
    });
  });

  it("requires an upgrade before connecting when the installed protocol is incompatible", async () => {
    const fixture = healthFixture();
    fixture.runIdentityProbe.mockResolvedValue(
      `bigbud-remote-agent 0.1.0 0 9 old-digest linux x86_64\n`,
    );

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "upgrade-required",
      currentVersion: "0.1.0",
      targetVersion: artifact.version,
    });
    expect(fixture.pool.get).not.toHaveBeenCalled();
  });

  it("requires an upgrade before connecting when the installed build digest is stale", async () => {
    const fixture = healthFixture();
    fixture.runIdentityProbe.mockResolvedValue(
      `bigbud-remote-agent ${artifact.version} ${artifact.protocolMajor} ${artifact.protocolMinor} old-digest linux x86_64\n`,
    );

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "upgrade-required",
      currentVersion: artifact.version,
      targetVersion: artifact.version,
    });
    expect(fixture.pool.get).not.toHaveBeenCalled();
  });

  it("requires an upgrade when the current binary reaches an incompatible running supervisor", async () => {
    const fixture = healthFixture();
    fixture.pool.get.mockRejectedValue(
      new RemoteAgentConnectionError(
        "UNSUPPORTED_PROTOCOL_MAJOR: incompatible protocol",
        "UNSUPPORTED_PROTOCOL_MAJOR",
      ),
    );

    await expect(fixture.health.verify("ssh:example")).resolves.toEqual({
      status: "upgrade-required",
      currentVersion: artifact.version,
      targetVersion: artifact.version,
    });
    expect(fixture.pool.snapshot).not.toHaveBeenCalled();
  });

  it("fails safely when the installed identity probe is malformed", async () => {
    const fixture = healthFixture();
    fixture.runIdentityProbe.mockResolvedValue("bigbud-remote-agent broken");

    await expect(fixture.health.verify("ssh:example")).rejects.toThrow("invalid identity metadata");
    expect(fixture.pool.get).not.toHaveBeenCalled();
    expect(fixture.loadInstallSource).not.toHaveBeenCalled();
  });

  it("rejects incomplete handshake identity metadata", async () => {
    const fixture = healthFixture({ agentVersion: artifact.version, agentEpoch: "epoch-1" });

    await expect(fixture.health.verify("ssh:example")).rejects.toThrow(
      "complete identity metadata",
    );
    expect(fixture.loadInstallSource).toHaveBeenCalledOnce();
  });
});

describe("remote agent installer", () => {
  it("invalidates the old pooled connection so the next use gets the installed identity", async () => {
    let installed = false;
    const closed = vi.fn();
    const pool = new RemoteAgentConnectionPool({
      create: async () =>
        ({
          handshake: async () => ({
            protocolMajor: artifact.protocolMajor,
            protocolMinor: artifact.protocolMinor,
            agentVersion: installed ? artifact.version : "0.1.0",
            buildDigest: installed ? artifact.buildDigest : "old-digest",
            os: "linux",
            architecture: "x86_64",
            agentInstanceId: installed ? "new-agent" : "old-agent",
            agentEpoch: "stable-epoch",
            capabilities: [],
            maxFrameBytes: 1024,
            maxOperationOutputBytes: 1024,
            maxJournalBytes: 1024,
          }),
          close: closed,
        }) as unknown as RemoteAgentConnection,
    });
    await pool.get("ssh:example");
    const installer = makeRemoteAgentInstaller({
      installManager: {
        install: async () => {
          installed = true;
          return { artifact };
        },
      },
      loadInstallSource: async () => source,
      pool,
    });

    await expect(installer.install("ssh:example")).resolves.toEqual({
      version: artifact.version,
    });
    expect(closed).toHaveBeenCalledOnce();
    await pool.get("ssh:example");
    expect(pool.snapshot("ssh:example")).toMatchObject({
      state: "ready",
      agentVersion: artifact.version,
      buildDigest: artifact.buildDigest,
    });
  });

  it("retains the pooled connection when installation fails", async () => {
    const close = vi.fn();
    const installer = makeRemoteAgentInstaller({
      installManager: {
        install: async () => {
          throw new Error("installation failed");
        },
      },
      loadInstallSource: async () => source,
      pool: { close },
    });

    await expect(installer.install("ssh:example")).rejects.toThrow("installation failed");
    expect(close).not.toHaveBeenCalled();
  });
});
