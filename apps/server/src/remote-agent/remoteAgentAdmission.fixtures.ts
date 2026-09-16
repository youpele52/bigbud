import { expect, vi } from "vitest";
import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

export function build(number: number, healthy: boolean): RemoteAgentRegistryBuild {
  const generation = `g${number}`;
  const sha256 = String(number).repeat(64);
  const runtime = {
    generation,
    version: "0.2.207",
    sha256,
    buildDigest: `digest${number}`,
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "managed" as const,
    binaryPath: `/tmp/agent/bin/0.2.207/${sha256}/bigbud-remote-agent`,
    statePath: `/tmp/agent/runtimes/${generation}`,
    socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
    logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
  };
  return {
    id: remoteAgentBuildId(runtime),
    runtime,
    health: healthy ? "healthy" : "staged",
    promotion: healthy ? number : 0,
    binary: "present",
    authenticated: true,
  };
}

export function fixture(
  failure?: "identity" | "network" | "binding",
  references: "known" | "unknown" = "known",
) {
  const localBindings = new Map<string, RemoteAgentRuntimeBinding>();
  const builds = [build(1, true), build(2, true), build(3, false)];
  let state: RemoteAgentRegistry = {
    ...emptyRemoteAgentRegistry(),
    builds,
    promotionSequence: 2,
    current: builds[1]!.id,
    pending: builds[2]!.id,
    launches: builds
      .slice(0, 2)
      .map((entry) => ({
        id: entry.runtime.generation,
        buildId: entry.id,
        phase: "ready" as const,
        epoch: `epoch-${entry.runtime.generation}`,
      }))
      .concat({
        id: builds[2]!.runtime.generation,
        buildId: builds[2]!.id,
        phase: "ready",
        epoch: `epoch-${builds[2]!.runtime.generation}`,
      }),
    updates: [
      {
        requestId: `update-${builds[2]!.runtime.sha256}`,
        buildId: builds[2]!.id,
        phase: "ready-for-reconnect",
        outcome: "ready",
        epoch: `epoch-${builds[2]!.runtime.generation}`,
      },
    ],
  };
  const control: RemoteAgentControl = {
    root: "/tmp/agent",
    run: vi.fn(async (command) => (command.includes("printf ready") ? "ready" : "launch-reserved")),
    registry: {
      read: async () => state,
      update: async (transition) => {
        const next = transition(state);
        if (next !== state && next.revision !== state.revision + 1)
          throw new Error("Invalid registry transition revision.");
        state = parseRemoteAgentRegistry(JSON.stringify(next));
        return state;
      },
    },
  };
  const frames: string[] = [];
  const connect = vi.fn(
    (_target, runtime) =>
      ({
        handshake: async () => {
          if (failure === "network" && runtime.generation === "g3")
            throw new Error("SSH transport timed out");
          if (failure === "identity" && runtime.generation !== "g3")
            expect(state.builds[2]?.health).toBe("quarantined");
          return {
            protocolMajor: 1,
            protocolMinor: 2,
            agentVersion:
              failure === "identity" && runtime.generation === "g3" ? "wrong" : runtime.version,
            buildDigest: runtime.buildDigest,
            os: "linux",
            architecture: "aarch64",
            agentInstanceId: runtime.generation,
            agentEpoch: `epoch-${runtime.generation}`,
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
          };
        },
        request: async (frame: { type: string }) => {
          frames.push(frame.type);
          return {
            type: "diagnosticResponse",
            value: { accepted: true, terminal: true, message: "agent-ready" },
          };
        },
        close: () => undefined,
      }) as unknown as RemoteAgentConnection,
  );
  return {
    control,
    connect,
    frames,
    admission: makeRemoteAgentAdmission({
      control: async () => control,
      connect,
      bindings: {
        getBinding: async (target) => localBindings.get(target),
        bindConnection: async (target, connectionId, binding) => {
          if (failure === "binding") throw new Error("local connection publication failed");
          localBindings.set(target, { ...binding, connectionId });
        },
        ...(references === "known" ? { hasDurableReferences: async () => false } : {}),
      },
    }),
  };
}
