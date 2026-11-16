import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { candidateHello } from "./remoteAgentUpdate.prepare.test.helpers.ts";
import {
  prepareRemoteAgentCandidate,
  prepareStagedRemoteAgentCandidate,
} from "./remoteAgentUpdate.prepare.ts";
import {
  artifact,
  installInput,
  installManagerFixture,
} from "./remoteAgentInstallManager.fixtures.ts";

function connection(events: string[]) {
  return {
    handshake: async () => {
      events.push("hello");
      return candidateHello();
    },
    request: async () => {
      events.push("health");
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
}

describe("independently owned candidate launch", () => {
  it("reserves first, uses the injected launch, then still requires startup and authenticated health", async () => {
    const fixture = installManagerFixture();
    const events: string[] = [];
    fixture.control.run = vi.fn(async (command: string) => {
      if (command.includes("nohup")) throw new Error("Unexpected default supervisor ownership");
      events.push("startup-wait");
      return "ready";
    });
    const launch = vi.fn(async (runtime: RemoteAgentRuntime, attemptId: string) => {
      events.push("service-launch");
      const state = await fixture.control.registry.read();
      expect(state.launches[0]).toMatchObject({
        id: runtime.generation,
        attemptId,
        phase: "spawn-uncertain",
        epoch: "",
      });
      expect(state.current).toBeNull();
      return "launch-reserved";
    });
    await expect(
      prepareRemoteAgentCandidate({
        target: installInput.executionTargetId,
        requestId: "service-launch",
        artifact,
        source: installInput.source,
        control: fixture.control,
        install: (input) => fixture.manager.install(input),
        launch,
        connect: () => connection(events),
      }),
    ).resolves.toMatchObject({ status: "ready-for-reconnect", epoch: "candidate-epoch" });
    expect(launch).toHaveBeenCalledOnce();
    expect(events).toEqual(["service-launch", "startup-wait", "hello", "health"]);
    expect((await fixture.control.registry.read()).launches[0]).toMatchObject({
      phase: "ready",
      epoch: "candidate-epoch",
    });
    expect((await fixture.control.registry.read()).current).toBeNull();
  });

  it("preserves an uncertain launch reservation and never launches it again on a retry", async () => {
    const fixture = installManagerFixture();
    await fixture.manager.install(installInput);
    const buildId = (await fixture.control.registry.read()).builds[0]!.id;
    fixture.control.run = vi.fn(async (command: string) => {
      if (command.includes("nohup")) throw new Error("Unexpected default launch");
      return "unavailable";
    });
    const launch = vi.fn(async () => {
      throw new Error("Lost independent service acknowledgement");
    });
    const input = {
      target: installInput.executionTargetId,
      requestId: "uncertain-service-launch",
      buildId,
      control: fixture.control,
      launch,
      connect: vi.fn(),
    };
    await expect(prepareStagedRemoteAgentCandidate(input)).rejects.toThrow(
      "could not be confirmed",
    );
    await expect(prepareStagedRemoteAgentCandidate(input)).rejects.toThrow(
      "did not establish readiness",
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(input.connect).not.toHaveBeenCalled();
    expect((await fixture.control.registry.read()).launches[0]).toMatchObject({
      phase: "spawn-uncertain",
      epoch: "",
    });
  });
});
