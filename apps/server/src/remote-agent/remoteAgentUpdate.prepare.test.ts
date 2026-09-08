import { describe, expect, it, vi } from "vitest";

import { RemoteAgentAdmissionError } from "./remoteAgentAdmission.types.ts";
import {
  prepareRemoteAgentCandidate,
  buildRemoteAgentCandidateStartupWaitCommand,
} from "./remoteAgentUpdate.prepare.ts";
import {
  artifact,
  installInput,
  installManagerFixture,
} from "./remoteAgentInstallManager.fixtures.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";

function hello() {
  return {
    protocolMajor: 1,
    protocolMinor: 2,
    agentVersion: artifact.version,
    buildDigest: artifact.buildDigest,
    os: "linux",
    architecture: "aarch64",
    agentInstanceId: "candidate",
    agentEpoch: "candidate-epoch",
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
}

describe("remote agent candidate preparation", () => {
  it("launches and checks the candidate before marking it ready", async () => {
    const fixture = installManagerFixture();
    const run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    fixture.control.run = run;
    const requests: string[] = [];
    const connection = {
      handshake: async () => hello(),
      request: async (frame: { type: string }) => {
        requests.push(frame.type);
        return {
          type: "diagnosticResponse",
          value: {
            requestId: "readiness",
            operationId: "readiness",
            accepted: true,
            terminal: true,
            message: "agent-ready",
          },
        };
      },
      close: vi.fn(),
    } as unknown as RemoteAgentConnection;

    await expect(
      prepareRemoteAgentCandidate({
        target: installInput.executionTargetId,
        requestId: "update-candidate",
        artifact,
        source: installInput.source,
        control: fixture.control,
        install: (input) => fixture.manager.install(input),
        connect: () => connection,
      }),
    ).resolves.toMatchObject({ status: "ready-for-reconnect", epoch: "candidate-epoch" });

    const state = await fixture.control.registry.read();
    expect(state.current).toBeNull();
    expect(state.pending).toBe(state.builds[0]?.id);
    expect(state.updates[0]).toMatchObject({
      requestId: "update-candidate",
      phase: "ready-for-reconnect",
      outcome: "ready",
      epoch: "candidate-epoch",
    });
    expect(state.launches[0]).toMatchObject({ phase: "ready", epoch: "candidate-epoch" });
    expect(requests).toEqual(["diagnosticRequest"]);
    expect(run.mock.calls.some(([command]) => command.includes("--proxy"))).toBe(false);
  });

  it("keeps a candidate checking when readiness is a definitive build failure", async () => {
    const fixture = installManagerFixture();
    fixture.control.run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    const connection = {
      handshake: async () => hello(),
      request: async () => {
        throw new RemoteAgentAdmissionError("NOT_READY", "not ready", true);
      },
      close: vi.fn(),
    } as unknown as RemoteAgentConnection;

    await expect(
      prepareRemoteAgentCandidate({
        target: installInput.executionTargetId,
        requestId: "update-candidate",
        artifact,
        source: installInput.source,
        control: fixture.control,
        install: (input) => fixture.manager.install(input),
        connect: () => connection,
      }),
    ).rejects.toMatchObject({ code: "NOT_READY", buildFailure: true });
    expect((await fixture.control.registry.read()).updates[0]?.phase).toBe("checking");
  });

  it("uses a private candidate state path for startup polling", () => {
    const command = buildRemoteAgentCandidateStartupWaitCommand({
      generation: "g-candidate",
      version: artifact.version,
      sha256: artifact.sha256,
      buildDigest: artifact.buildDigest,
      targetTriple: artifact.targetTriple,
      binaryPath: "/home/me/.bigbud/agent/bin/0.2.207/hash/bigbud-remote-agent",
      statePath: "/home/me/.bigbud/agent/runtimes/g-candidate",
      socketPath: "/home/me/.bigbud/agent/runtimes/g-candidate/supervisor.sock",
      logPath: "/home/me/.bigbud/agent/runtimes/g-candidate/supervisor.log",
      origin: "managed",
    });
    expect(command).toContain("launch.exit");
    expect(command).toContain("supervisor.sock");
  });
});
