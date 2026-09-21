import { vi, type Mock } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeRemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import {
  artifact as unsignedArtifact,
  installManagerFixture,
} from "./remoteAgentInstallManager.fixtures.ts";
import { makeRemoteAgentUpdateCoordinator } from "./remoteAgentUpdate.coordinator.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
export const artifact = {
  ...unsignedArtifact,
  signature: {
    ...unsignedArtifact.signature,
    value: sign(
      null,
      Buffer.from(canonicalizeRemoteAgentArtifact(unsignedArtifact)),
      privateKey,
    ).toString("base64"),
  },
};
export const source = {
  manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
  trustStore: { test: publicKey.export({ type: "spki", format: "pem" }).toString() },
};

type SetupFixture = ReturnType<typeof installManagerFixture> & {
  target: string;
  coordinator: ReturnType<typeof makeRemoteAgentUpdateCoordinator>;
  admission: ReturnType<typeof makeRemoteAgentAdmission>;
  handshake: Mock<() => ReturnType<RemoteAgentConnection["handshake"]>>;
  connect: Mock<(target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection>;
  load: Mock<() => Promise<typeof source>> & { refresh: Mock<() => Promise<typeof source>> };
  logger: Mock;
};

export function setup(): SetupFixture {
  const fixture = installManagerFixture();
  const target = `ssh:host=setup-${crypto.randomUUID()}&transport=agent`;
  fixture.control.run = vi.fn(async (command: string) =>
    command.includes("launch-reserved") ? "launch-reserved" : "ready",
  );
  const handshake = vi.fn(async () => ({
    protocolMajor: 1,
    protocolMinor: 2,
    agentVersion: artifact.version,
    buildDigest: artifact.buildDigest,
    os: "linux",
    architecture: "aarch64",
    agentInstanceId: "setup",
    agentEpoch: "setup-epoch",
    capabilities: [
      "diagnostic",
      "workspace.files",
      "workspace.search",
      "workspace.write",
      "workspace.watch",
      "process.run",
      "process.attach",
      "terminal.pty",
    ].map((name) => ({ name, major: 1, minor: 0 })),
    maxFrameBytes: 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  }));
  const connect = vi.fn(
    (_target: string, runtime: RemoteAgentRuntime) =>
      ({
        handshake: async () => ({
          ...(await handshake()),
          agentVersion: runtime.version,
          buildDigest: runtime.buildDigest,
          agentEpoch: runtime.generation === "stable" ? "stable-epoch" : "setup-epoch",
        }),
        close: vi.fn(),
        request: async () => ({
          type: "diagnosticResponse",
          value: { accepted: true, terminal: true, message: "agent-ready" },
        }),
      }) as unknown as RemoteAgentConnection,
  );
  const load: Mock<() => Promise<typeof source>> & {
    refresh: Mock<() => Promise<typeof source>>;
  } = Object.assign(
    vi.fn(async () => source),
    { refresh: vi.fn(async () => source) },
  );
  const logger = vi.fn();
  const coordinator = makeRemoteAgentUpdateCoordinator({
    installManager: fixture.manager,
    loadInstallSource: load,
    openControl: async () => fixture.control,
    knownTargets: async () => [],
    hasReusableCredentials: () => true,
    connect,
    logger,
  });
  const bindings = new Map<string, RemoteAgentRuntimeBinding>();
  const admission = makeRemoteAgentAdmission({
    control: async () => fixture.control,
    connect,
    bindings: {
      getBinding: async (target) => bindings.get(target),
      bindConnection: async (target, connectionId, binding) => {
        bindings.set(target, { ...binding, connectionId });
      },
      hasDurableReferences: async () => false,
      listConnectionIds: async () => [],
    },
  });
  return { ...fixture, target, coordinator, admission, handshake, connect, load, logger };
}

export async function seedStable(
  f: ReturnType<typeof setup>,
  authenticated = true,
  version = "0.2.205",
) {
  const runtime = {
    generation: "stable",
    version,
    sha256: "b".repeat(64),
    buildDigest: "stable-build",
    targetTriple: artifact.targetTriple,
    origin: authenticated ? ("managed" as const) : ("legacy-external" as const),
    binaryPath: `/tmp/home/.bigbud/agent/bin/${version}/${"b".repeat(64)}/bigbud-remote-agent`,
    statePath: "/tmp/home/.bigbud/agent/runtimes/stable",
    socketPath: "/tmp/home/.bigbud/agent/runtimes/stable/supervisor.sock",
    logPath: "/tmp/home/.bigbud/agent/runtimes/stable/supervisor.log",
  };
  const id = remoteAgentBuildId(runtime);
  await f.control.registry.update((state) =>
    nextRemoteAgentRegistryRevision(state, {
      current: id,
      promotionSequence: 1,
      builds: [
        {
          id,
          runtime,
          authenticated,
          health: authenticated ? "healthy" : "staged",
          binary: "present",
          promotion: 1,
        },
      ],
      launches: [{ id: "stable", buildId: id, phase: "ready", epoch: "stable-epoch" }],
      pins: [{ owner: "stable-operation", buildId: id }],
    }),
  );
  return id;
}
