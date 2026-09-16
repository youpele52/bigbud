import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeRemoteAgentUpdateCoordinator,
  type RemoteAgentUpdateCoordinatorDependencies,
} from "./remoteAgentUpdate.coordinator.ts";
import { artifact, installManagerFixture, source } from "./remoteAgentInstallManager.fixtures.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentInstallSourceLoader } from "./remoteAgentInstallSource.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";

function loader(): RemoteAgentInstallSourceLoader {
  const load = Object.assign(async () => source, {
    refresh: async () => source,
  });
  return load;
}

function candidateConnection(): RemoteAgentConnection {
  const response = {
    type: "diagnosticResponse",
    value: {
      requestId: "ignored",
      operationId: "ignored",
      accepted: true,
      terminal: true,
      message: "agent-ready",
    },
  } as const;
  return {
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 2,
      agentVersion: artifact.version,
      buildDigest: artifact.buildDigest,
      os: "linux",
      architecture: "aarch64",
      agentInstanceId: "candidate",
      agentEpoch: "epoch-1",
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
    }),
    request: async () => response,
    close: vi.fn(),
  } as unknown as RemoteAgentConnection;
}

function inventory(noncompliant = false): RemoteAgentInventory {
  return {
    entries: [],
    uniqueDigests: new Set(),
    partialCandidate: false,
    unknownOwner: false,
    untracked: false,
    uncertain: false,
    noncompliant,
  };
}

function dependencies(
  fixture: ReturnType<typeof installManagerFixture>,
): RemoteAgentUpdateCoordinatorDependencies {
  return {
    installManager: fixture.manager,
    loadInstallSource: loader(),
    openControl: async () => fixture.control,
    knownTargets: async () => [],
    hasReusableCredentials: () => true,
    connect: () => candidateConnection(),
    logger: vi.fn(),
  };
}

describe("remote agent update coordinator", () => {
  it("prepares once after a source change without selecting the candidate", async () => {
    const fixture = installManagerFixture();
    fixture.control.run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    const refresh = vi.fn(async () => source);
    const load = Object.assign(async () => source, { refresh });
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      loadInstallSource: load,
      knownTargets: async () => ["ssh:known"],
    });

    await coordinator.sourceChanged();
    await coordinator.drain();

    expect(refresh).toHaveBeenCalledOnce();
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
    const state = await fixture.control.registry.read();
    expect(state.current).toBeNull();
    expect(state.pending).toBe(state.builds[0]?.id);
  });

  it("coalesces duplicate authenticated update triggers into one install", async () => {
    const fixture = installManagerFixture();
    fixture.control.run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    const coordinator = makeRemoteAgentUpdateCoordinator(dependencies(fixture));

    coordinator.enqueue({ target: "ssh:known", trigger: "authenticated", authenticated: true });
    coordinator.enqueue({ target: "ssh:known", trigger: "authenticated", authenticated: true });
    await coordinator.drain();

    expect(fixture.installArtifact).toHaveBeenCalledOnce();
    expect((await fixture.control.registry.read()).updates.at(-1)).toMatchObject({
      phase: "ready-for-reconnect",
      outcome: "ready",
    });
  });

  it("does not open SSH or prompt when startup credentials are unavailable", async () => {
    const fixture = installManagerFixture();
    const openControl = vi.fn(async () => fixture.control);
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      openControl,
      hasReusableCredentials: () => false,
    });

    coordinator.enqueue({ target: "ssh:password", trigger: "scheduled" });
    await coordinator.drain();
    expect(openControl).not.toHaveBeenCalled();
    await expect(coordinator.getStatus("ssh:password")).resolves.toMatchObject({
      phase: "waiting-for-authentication",
    });
  });

  it("starts its scheduler through an Effect scope and exposes durable status", async () => {
    const fixture = installManagerFixture();
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      scheduler: {
        start: vi.fn(),
        stop: vi.fn(),
        enqueue: vi.fn(),
        refreshNow: async () => undefined,
        tick: async () => undefined,
        drain: async () => undefined,
      },
    });

    await Effect.runPromise(Effect.scoped(coordinator.start));
    expect(coordinator.getStatus).toBeTypeOf("function");
  });

  it("retains the reserved candidate when health verification is uncertain", async () => {
    const fixture = installManagerFixture();
    Object.assign(fixture.control, { inventory: async () => inventory() });
    fixture.control.run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    const connection = candidateConnection();
    const uncertainConnection = {
      ...connection,
      request: async () => {
        throw new Error("network unavailable");
      },
    } as unknown as RemoteAgentConnection;
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      connect: () => uncertainConnection,
    });

    coordinator.enqueue({ target: "ssh:known", trigger: "authenticated" });
    await coordinator.drain();

    const state = await fixture.control.registry.read();
    expect(state.updates.at(-1)).toMatchObject({ phase: "uncertain", outcome: "uncertain" });
    expect(state.slotReservations).toEqual([
      expect.objectContaining({ phase: "occupied", buildId: state.builds[0]?.id }),
    ]);
    await expect(coordinator.getStatus("ssh:known")).resolves.toMatchObject({
      phase: "verification-unavailable",
    });
  });

  it("reports physical capacity noncompliance without attempting preparation", async () => {
    const fixture = installManagerFixture();
    Object.assign(fixture.control, { inventory: async () => inventory(true) });
    const openControl = vi.fn(async () => fixture.control);
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      openControl,
    });

    await expect(coordinator.getStatus("ssh:known")).resolves.toMatchObject({
      phase: "capacity-noncompliant",
    });
    expect(openControl).toHaveBeenCalledOnce();
    expect(fixture.installArtifact).not.toHaveBeenCalled();
  });

  it("prepares once after a coalesced source change without selecting or prompting", async () => {
    const fixture = installManagerFixture();
    fixture.control.run = vi.fn(async (command: string) =>
      command.includes("launch-reserved") ? "launch-reserved" : "ready",
    );
    const refresh = vi.fn(async () => source);
    const load = Object.assign(async () => source, { refresh });
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      loadInstallSource: load,
      knownTargets: async () => ["ssh:known", "ssh:known"],
    });

    await Promise.all([coordinator.sourceChanged(), coordinator.sourceChanged()]);
    await coordinator.drain();

    expect(refresh).toHaveBeenCalledOnce();
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
    const state = await fixture.control.registry.read();
    expect(state.current).toBeNull();
    expect(state.pending).toBe(state.builds[0]?.id);
  });

  it("does not prompt or open SSH for a source change without reusable credentials", async () => {
    const fixture = installManagerFixture();
    const openControl = vi.fn(async () => fixture.control);
    const refresh = vi.fn(async () => source);
    const load = Object.assign(async () => source, { refresh });
    const coordinator = makeRemoteAgentUpdateCoordinator({
      ...dependencies(fixture),
      loadInstallSource: load,
      openControl,
      knownTargets: async () => ["ssh:password"],
      hasReusableCredentials: () => false,
    });

    await coordinator.sourceChanged();
    await coordinator.drain();

    expect(refresh).toHaveBeenCalledOnce();
    expect(openControl).not.toHaveBeenCalled();
    expect(fixture.installArtifact).not.toHaveBeenCalled();
  });
});
