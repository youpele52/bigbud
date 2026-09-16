import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import {
  prepareRemoteAgentPredecessorRetirement,
  retireManagedRemoteAgentBuild,
} from "./remoteAgentInstall.retirement.ts";
import { buildRemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";
import { artifact, installManagerFixture } from "./remoteAgentInstallManager.fixtures.ts";

function build(version: string, number: number) {
  const sha256 = String(number).repeat(64).slice(0, 64);
  const generation = `g-${number}`;
  const runtime = {
    generation,
    version,
    sha256,
    buildDigest: `digest-${number}`,
    targetTriple: "aarch64-unknown-linux-gnu" as const,
    binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
    statePath: `/tmp/agent/runtimes/${generation}`,
    socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
    logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
    origin: "managed" as const,
  };
  return {
    id: `${version}:${sha256}:${runtime.targetTriple}`,
    runtime,
    health: "healthy" as const,
    promotion: number,
    binary: "present" as const,
    authenticated: true,
  };
}

function registryBuild(value: ReturnType<typeof build>): RemoteAgentRegistryBuild {
  return value;
}

function inventory(digests: ReadonlySet<string>) {
  return {
    entries: [...digests].map((digest, index) => ({
      digest,
      path: `/tmp/agent/bin/build-${index}/bigbud-remote-agent`,
      kind: "managed" as const,
    })),
    uniqueDigests: new Set(digests),
    partialCandidate: false,
    unknownOwner: false,
    untracked: false,
    uncertain: false,
    noncompliant: false,
  };
}

function predecessorState(
  predecessor: ReturnType<typeof build>,
  current: ReturnType<typeof build>,
  phase: "ready" | "spawn-uncertain" | "proven-dead" = "proven-dead",
): RemoteAgentRegistry {
  return {
    ...emptyRemoteAgentRegistry(),
    builds: [registryBuild(predecessor), registryBuild(current)],
    current: current.id,
    predecessor: predecessor.id,
    promotionSequence: current.promotion,
    launches: [
      { id: predecessor.runtime.generation, buildId: predecessor.id, phase, epoch: "epoch-a" },
      {
        id: current.runtime.generation,
        buildId: current.id,
        phase: "ready",
        epoch: "epoch-b",
      },
    ],
  };
}

function controlFor(
  initial: RemoteAgentRegistry,
  run: (command: string) => Promise<string>,
): RemoteAgentControl {
  let state = initial;
  return {
    root: "/tmp/agent",
    run,
    registry: {
      read: async () => state,
      update: async (transition) => {
        state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
        return state;
      },
    },
  };
}

describe("remote agent predecessor retirement", () => {
  it.each([
    ["active", "ready" as const],
    ["uncertain", "spawn-uncertain" as const],
  ])("defers %s predecessor without issuing shutdown", async (_label, phase) => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const run = vi.fn(async () => "live");
    const control = controlFor(predecessorState(predecessor, current, phase), run);
    const result = await retireManagedRemoteAgentBuild({
      control,
      buildId: predecessor.id,
      reservationId: "retire-active",
      withdrawPredecessor: true,
      allowLiveShutdown: false,
    });
    expect(result).toBe("deferred");
    const after = await control.registry.read();
    expect(after.predecessor).toBe(predecessor.id);
    expect(after.retirementReservations[0]).toMatchObject({
      phase: "failed",
      failure: "uncertain",
    });
    expect(run).toHaveBeenCalledTimes(0);
  });

  it("releases a deferred durable fence before allowing the next retirement attempt", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const fence = new RemoteAgentRetirementFence();
    const control = controlFor(
      predecessorState(predecessor, current),
      vi.fn(async () => "live"),
    );

    await expect(
      retireManagedRemoteAgentBuild({
        control,
        buildId: predecessor.id,
        reservationId: "retire-deferred-fence",
        fence,
        withdrawPredecessor: true,
        allowLiveShutdown: false,
      }),
    ).resolves.toBe("deferred");

    expect((await control.registry.read()).retirementReservations[0]).toMatchObject({
      phase: "failed",
      failure: "uncertain",
    });
    expect(fence.isRetiring(predecessor.runtime.generation)).toBe(false);
    const release = fence.acquire(predecessor.runtime.generation);
    release();
  });

  it("rechecks durable references after fencing and before withdrawing", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    let control!: RemoteAgentControl;
    const run = vi.fn(async (command: string) => {
      if (command.includes("test -S")) {
        await control.registry.update((state) =>
          pinRemoteAgentBuild(state, "race-owner", predecessor.id),
        );
      }
      return "dead";
    });
    control = controlFor(predecessorState(predecessor, current), run);

    const result = await retireManagedRemoteAgentBuild({
      control,
      buildId: predecessor.id,
      reservationId: "retire-race",
      referencedBuildIds: new Set(),
      recheckReferencedBuildIds: async () => new Set(),
      withdrawPredecessor: true,
      allowLiveShutdown: false,
    });

    expect(result).toBe("deferred");
    const after = await control.registry.read();
    expect(after.predecessor).toBe(predecessor.id);
    expect(after.pins).toContainEqual({ owner: "race-owner", buildId: predecessor.id });
    expect(after.retirementReservations[0]).toMatchObject({
      phase: "failed",
      failure: "uncertain",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defers another-controller selection before any predecessor probe", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const state = predecessorState(predecessor, current);
    const control = controlFor(
      state,
      vi.fn(async () => "dead"),
    );
    const result = await prepareRemoteAgentPredecessorRetirement({
      target: "ssh:fixture",
      control,
      build: registryBuild(build("0.2.208", 8)),
      inventory: inventory(new Set([predecessor.runtime.sha256, current.runtime.sha256])),
      referencedBuildIds: async () => new Set([predecessor.id]),
    });
    expect(result).toBe("deferred");
    expect((await control.registry.read()).predecessor).toBe(predecessor.id);
  });

  it("defers when another controller already owns the retirement reservation", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const state = {
      ...predecessorState(predecessor, current),
      retirementReservations: [
        {
          id: "retire-other-controller",
          buildId: predecessor.id,
          generation: predecessor.runtime.generation,
          phase: "fenced" as const,
          controllerId: "controller:other",
        },
      ],
    };
    const run = vi.fn(async () => "dead");
    const control = controlFor(state, run);

    const result = await retireManagedRemoteAgentBuild({
      control,
      buildId: predecessor.id,
      reservationId: "retire-this-controller",
      referencedBuildIds: new Set(),
      withdrawPredecessor: true,
      allowLiveShutdown: false,
    });

    expect(result).toBe("deferred");
    expect((await control.registry.read()).predecessor).toBe(predecessor.id);
    expect(run).not.toHaveBeenCalled();
  });

  it("defers unknown physical ownership without retiring the predecessor", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const control = controlFor(predecessorState(predecessor, current), vi.fn());
    const result = await prepareRemoteAgentPredecessorRetirement({
      target: "ssh:fixture",
      control,
      build: registryBuild(build("0.2.208", 8)),
      inventory: {
        ...inventory(new Set([predecessor.runtime.sha256, current.runtime.sha256])),
        unknownOwner: true,
        untracked: true,
        noncompliant: true,
      },
      referencedBuildIds: async () => new Set(),
    });
    expect(result).toBe("deferred");
    expect((await control.registry.read()).predecessor).toBe(predecessor.id);
  });

  it("retires an idle predecessor before the production installer writes 208", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const candidateBytes = new TextEncoder().encode("candidate-208");
    const candidateArtifact = {
      ...artifact,
      version: "0.2.208",
      buildDigest: "digest-208",
      sizeBytes: candidateBytes.byteLength,
      sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    };
    const fixture = installManagerFixture({
      readArtifactBytes: async () => candidateBytes,
      referencedBuildIds: async () => new Set(),
    });
    const events: string[] = [];
    let digests = new Set([predecessor.runtime.sha256, current.runtime.sha256]);
    Object.assign(fixture.control, {
      inventory: async () => inventory(digests),
      run: async (command: string) => {
        if (command.includes("printf deleted")) {
          events.push("delete");
          digests = new Set([current.runtime.sha256]);
          return "deleted";
        }
        events.push("inspect");
        return "dead";
      },
    });
    await fixture.control.registry.update(() => predecessorState(predecessor, current));
    const source = {
      manifest: { schemaVersion: 1 as const, artifacts: [candidateArtifact] },
      trustStore: {},
      allowUntrustedDevelopmentArtifact: true as const,
    };
    const originalInstall = fixture.installArtifact;
    originalInstall.mockImplementation(async () => {
      events.push("install");
      digests = new Set([current.runtime.sha256, candidateArtifact.sha256]);
      return buildRemoteAgentInstallPaths(candidateArtifact);
    });

    await expect(
      fixture.manager.install({ executionTargetId: "ssh:fixture", source }),
    ).resolves.toMatchObject({ status: "staged", artifact: candidateArtifact });
    expect(events.indexOf("delete")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("install"));
    const state = await fixture.control.registry.read();
    expect(state.current).toBe(current.id);
    expect(state.predecessor).toBeNull();
    expect(state.pending).toContain("0.2.208");
    expect(digests).toHaveLength(2);
  });

  it("keeps 207 as fallback when candidate installation fails after retirement", async () => {
    const predecessor = build("0.2.205", 5);
    const current = build("0.2.207", 7);
    const candidateBytes = new TextEncoder().encode("candidate-208-failure");
    const candidateArtifact = {
      ...artifact,
      version: "0.2.208",
      buildDigest: "digest-208-failure",
      sizeBytes: candidateBytes.byteLength,
      sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    };
    const fixture = installManagerFixture({
      readArtifactBytes: async () => candidateBytes,
      referencedBuildIds: async () => new Set(),
    });
    let digests = new Set([predecessor.runtime.sha256, current.runtime.sha256]);
    Object.assign(fixture.control, {
      inventory: async () => inventory(digests),
      run: async (command: string) => {
        if (command.includes("printf deleted")) {
          digests = new Set([current.runtime.sha256]);
          return "deleted";
        }
        return "dead";
      },
    });
    await fixture.control.registry.update(() => predecessorState(predecessor, current));
    fixture.installArtifact.mockRejectedValueOnce(
      new Error("candidate write failed after retirement"),
    );
    const source = {
      manifest: { schemaVersion: 1 as const, artifacts: [candidateArtifact] },
      trustStore: {},
      allowUntrustedDevelopmentArtifact: true as const,
    };

    await expect(
      fixture.manager.install({ executionTargetId: "ssh:fixture", source }),
    ).rejects.toThrow("candidate write failed after retirement");
    const after = await fixture.control.registry.read();
    expect(after.current).toBe(current.id);
    expect(after.predecessor).toBeNull();
    expect(after.builds.find((entry) => entry.id === current.id)?.binary).toBe("present");
    expect(digests).toEqual(new Set([current.runtime.sha256]));
  });
});
