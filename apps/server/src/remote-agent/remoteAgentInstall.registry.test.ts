import { describe, expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  MAX_REMOTE_AGENT_BUILDS,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import {
  pinRemoteAgentBuild,
  failRemoteAgentStage,
  publishRemoteAgentStage,
  reconcileRemoteAgentStages,
  releaseRemoteAgentPin,
  reserveRemoteAgentStage,
  retainedRemoteAgentBuilds,
  tombstoneRemoteAgentBuild,
  quarantineRemoteAgentBuild,
  releaseRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { pruneRemoteAgentHistory } from "./remoteAgentInstall.registry.admission.ts";

export function registryBuild(number: number): RemoteAgentRegistryBuild {
  const version = `0.2.${number}`;
  const sha256 = String(number % 10).repeat(64);
  const targetTriple = "aarch64-unknown-linux-gnu";
  const generation = `g${number}`;
  return {
    id: `${version}:${sha256}:${targetTriple}`,
    health: "healthy",
    promotion: number,
    authenticated: true,
    binary: "present",
    runtime: {
      version,
      sha256,
      targetTriple,
      generation,
      origin: "managed",
      buildDigest: "fixture",
      binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath: `/tmp/agent/runtimes/${generation}`,
      socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
      logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
    },
  };
}

describe("remote agent registry ownership", () => {
  const builds = [registryBuild(1), registryBuild(2), registryBuild(3)];
  const initial = { ...emptyRemoteAgentRegistry(), builds, promotionSequence: 3 };

  it("retains two healthy builds plus pins, not a staged third slot", () => {
    const candidate = { ...registryBuild(4), health: "staged" as const, promotion: 0 };
    let state = reserveRemoteAgentStage(initial, "stage", candidate);
    state = publishRemoteAgentStage(state, "stage");
    expect([...retainedRemoteAgentBuilds(state)]).toEqual([
      builds[2]!.id,
      builds[1]!.id,
      candidate.id,
    ]);
    state = pinRemoteAgentBuild(state, "old-operation", builds[0]!.id);
    expect(retainedRemoteAgentBuilds(state).has(builds[0]!.id)).toBe(true);
    expect(() => tombstoneRemoteAgentBuild(state, builds[0]!.id)).toThrow("retained");
  });

  it("reserves cleanup-eligible restaging before any install or check", () => {
    const reserved = reserveRemoteAgentStage(initial, "restage", builds[0]!);
    expect(() => tombstoneRemoteAgentBuild(reserved, builds[0]!.id)).toThrow("retained");
    const deleting = tombstoneRemoteAgentBuild(initial, builds[0]!.id);
    expect(() => reserveRemoteAgentStage(deleting, "restage", builds[0]!)).toThrow("reconcile");
    expect(() => pinRemoteAgentBuild(deleting, "late-owner", builds[0]!.id)).toThrow("deleting");
  });

  it("never migrates an existing owner and conservatively retains uncertain launches", () => {
    const pinned = pinRemoteAgentBuild(initial, "terminal:thread:id", builds[0]!.id);
    expect(() => pinRemoteAgentBuild(pinned, "terminal:thread:id", builds[2]!.id)).toThrow(
      "migrate",
    );
    const uncertain = {
      ...initial,
      launches: [
        { id: "launch", buildId: builds[0]!.id, phase: "spawn-uncertain" as const, epoch: "" },
      ],
    };
    expect(() => tombstoneRemoteAgentBuild(uncertain, builds[0]!.id)).toThrow("retained");
  });

  it("rejects corrupt metadata, path aliases, and unknown schema versions", () => {
    const shared = registryBuild(4);
    expect(() =>
      parseRemoteAgentRegistry(
        JSON.stringify({
          ...initial,
          promotionSequence: 4,
          builds: [
            ...builds,
            {
              ...shared,
              runtime: {
                ...shared.runtime,
                generation: "g1",
                statePath: "/tmp/agent/runtimes/g1",
                socketPath: "/tmp/agent/runtimes/g1/supervisor.sock",
                logPath: "/tmp/agent/runtimes/g1/supervisor.log",
              },
            },
          ],
        }),
      ),
    ).toThrow("shared");
    expect(() =>
      parseRemoteAgentRegistry(JSON.stringify({ ...initial, schemaVersion: 3 })),
    ).toThrow();
    expect(() =>
      parseRemoteAgentRegistry(JSON.stringify({ ...initial, pending: "unknown" })),
    ).toThrow();
    const build = builds[0]!;
    expect(() =>
      parseRemoteAgentRegistry(
        JSON.stringify({
          ...initial,
          builds: [
            { ...build, runtime: { ...build.runtime, statePath: "/tmp/agent/runtimes/../state" } },
          ],
        }),
      ),
    ).toThrow();
  });

  it("bounds records and validates ready admission references", () => {
    expect(() =>
      parseRemoteAgentRegistry(
        JSON.stringify({
          ...initial,
          promotionSequence: 42,
          builds: Array.from({ length: 33 }, (_, index) => registryBuild(index + 10)),
        }),
      ),
    ).toThrow("budget");
    const ready = {
      ...initial,
      launches: [
        { id: "launch-1", buildId: builds[0]!.id, phase: "ready" as const, epoch: "epoch-1" },
      ],
      admissions: [
        { id: "connection-1", buildId: builds[0]!.id, phase: "ready" as const, epoch: "epoch-1" },
      ],
      current: builds[0]!.id,
      currentConnectionId: "connection-1",
    };
    expect(parseRemoteAgentRegistry(JSON.stringify(ready))).toEqual(ready);
    expect(() =>
      parseRemoteAgentRegistry(JSON.stringify({ ...ready, currentConnectionId: "missing" })),
    ).toThrow("Current connection");
  });

  it("releases superseded pins and preserves uncertain launch pins", () => {
    const pinned = pinRemoteAgentBuild(initial, "connection-old", builds[0]!.id);
    expect(releaseRemoteAgentPin(pinned, "connection-old").pins).toHaveLength(0);
    const uncertain = pinRemoteAgentBuild(
      {
        ...initial,
        launches: [{ id: "launch-1", buildId: builds[0]!.id, phase: "spawn-uncertain", epoch: "" }],
      },
      "activation-request-1:g1",
      builds[0]!.id,
    );
    expect(pruneRemoteAgentHistory(uncertain).pins).toHaveLength(1);
  });

  it("retains a build referenced only by released slot evidence", () => {
    const state = pruneRemoteAgentHistory({
      ...initial,
      slotReservations: [
        {
          id: "slot-0:old-update:1",
          slotId: "slot-0",
          requestId: "old-update",
          buildId: builds[0]!.id,
          phase: "released" as const,
        },
      ],
    });

    expect(state.builds.map((build) => build.id)).toContain(builds[0]!.id);
    expect(state.slotReservations).toEqual([
      expect.objectContaining({ buildId: builds[0]!.id, phase: "released" }),
    ]);
    expect(parseRemoteAgentRegistry(JSON.stringify(state))).toEqual(state);
  });

  it("retains retirement evidence until confirmed deletion, then compacts it", () => {
    const reserved = pruneRemoteAgentHistory({
      ...initial,
      retirementReservations: [
        {
          id: "retire-old",
          buildId: builds[0]!.id,
          generation: builds[0]!.runtime.generation,
          phase: "reserved" as const,
        },
      ],
    });
    expect(reserved.builds.map((build) => build.id)).toContain(builds[0]!.id);

    const tombstoned = pruneRemoteAgentHistory({
      ...reserved,
      builds: reserved.builds.map((build) =>
        build.id === builds[0]!.id ? { ...build, binary: "deleting" as const } : build,
      ),
      retirementReservations: [
        {
          ...reserved.retirementReservations[0]!,
          phase: "tombstoned" as const,
        },
      ],
    });
    expect(tombstoned.builds.map((build) => build.id)).toContain(builds[0]!.id);

    const confirmed = pruneRemoteAgentHistory({
      ...tombstoned,
      builds: tombstoned.builds.map((build) =>
        build.id === builds[0]!.id ? { ...build, binary: "absent" as const } : build,
      ),
      retirementReservations: [
        {
          ...tombstoned.retirementReservations[0]!,
          phase: "tombstoned" as const,
        },
      ],
    });
    expect(confirmed.builds.map((build) => build.id)).not.toContain(builds[0]!.id);
    expect(confirmed.retirementReservations).toEqual([]);
    expect(parseRemoteAgentRegistry(JSON.stringify(confirmed))).toEqual(confirmed);
  });

  it("retains the build named by old admission retry evidence", () => {
    const state = pruneRemoteAgentHistory({
      ...initial,
      admissionRetirements: [
        {
          id: "old-admission",
          buildId: builds[0]!.id,
          epoch: "epoch-old",
          outcome: "rejected" as const,
        },
      ],
    });

    expect(state.builds.map((build) => build.id)).toContain(builds[0]!.id);
    expect(state.admissionRetirements).toContainEqual(
      expect.objectContaining({ id: "old-admission", buildId: builds[0]!.id }),
    );
    expect(parseRemoteAgentRegistry(JSON.stringify(state))).toEqual(state);
  });

  it("defers compaction instead of slicing over-budget durable references", () => {
    const overLimitBuilds = Array.from({ length: MAX_REMOTE_AGENT_BUILDS + 1 }, (_, index) =>
      registryBuild(index + 100),
    );
    const state = {
      ...emptyRemoteAgentRegistry(),
      builds: overLimitBuilds,
      promotionSequence: overLimitBuilds.length + 99,
      admissionRetirements: overLimitBuilds.map((build, index) => ({
        id: `old-admission-${index}`,
        buildId: build.id,
        epoch: `epoch-${index}`,
        outcome: "rejected" as const,
      })),
    };

    expect(pruneRemoteAgentHistory(state)).toBe(state);
    expect(state.builds).toHaveLength(MAX_REMOTE_AGENT_BUILDS + 1);
    expect(state.builds).toEqual(overLimitBuilds);
  });

  it("releases definitive staging failures so repeated failures cannot exhaust stage budget", () => {
    let state = emptyRemoteAgentRegistry();
    const candidate = { ...registryBuild(40), health: "staged" as const, promotion: 0 };
    for (let index = 0; index < 64; index++) {
      state = reserveRemoteAgentStage(state, `failed-${index}`, candidate);
      state = failRemoteAgentStage(state, `failed-${index}`, "definitive");
    }
    expect(state.stages).toEqual([]);
    expect(state.builds[0]?.health).toBe("quarantined");
  });

  it("keeps ambiguous staging after its lease expires until ownership is fenced", () => {
    const candidate = { ...registryBuild(41), health: "staged" as const, promotion: 0 };
    let state = reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "ambiguous", candidate);
    state = failRemoteAgentStage(state, "ambiguous", "ambiguous");
    const stage = state.stages[0]!;
    expect(stage.phase).toBe("failed");
    expect(reconcileRemoteAgentStages(state, stage.leaseExpiresAt! - 1).stages).toHaveLength(1);
    state = reconcileRemoteAgentStages(state, stage.leaseExpiresAt! + 1);
    expect(state.stages).toHaveLength(1);
    expect(retainedRemoteAgentBuilds(state).has(candidate.id)).toBe(true);
  });

  it("reconciles an interrupted reserved stage after restart without releasing a pinned build", () => {
    const candidate = { ...registryBuild(42), health: "staged" as const, promotion: 0 };
    let state = reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "restart", candidate);
    const stage = state.stages[0]!;
    state = reconcileRemoteAgentStages(state, stage.leaseExpiresAt! + 1);
    expect(state.stages).toHaveLength(1);
    state = reserveRemoteAgentStage(state, "restart-2", candidate);
    state = pinRemoteAgentBuild(state, "unknown-owner", candidate.id);
    state = reconcileRemoteAgentStages(state, Date.now() + 10 * 60 * 1000);
    expect(retainedRemoteAgentBuilds(state).has(candidate.id)).toBe(true);
  });

  it("requires the recorded owner before releasing a fenced reservation", () => {
    const candidate = { ...registryBuild(44), health: "staged" as const, promotion: 0 };
    const owner = { id: "controller:dead", pid: 999_999, startedAt: "old" };
    const state = reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "owned", candidate, owner);
    expect(() => releaseRemoteAgentStage(state, "owned")).toThrow("ownership");
    const released = releaseRemoteAgentStage(state, "owned", owner);
    expect(released.stages[0]?.phase).toBe("cancelled");
  });

  it("retires completed admission identity before pruning its decision", () => {
    const build = builds[0]!;
    const admission = {
      id: "old-request",
      buildId: build.id,
      phase: "ready" as const,
      epoch: "epoch-old",
      outcome: "fallback" as const,
      requestedBuildId: builds[2]!.id,
      failureCode: "NOT_READY",
    };
    const state = pruneRemoteAgentHistory({
      ...initial,
      current: build.id,
      currentConnectionId: null,
      launches: [{ id: "launch-old", buildId: build.id, phase: "ready", epoch: "epoch-old" }],
      admissions: [admission],
    });
    expect(state.admissions).toEqual([]);
    expect(state.admissionRetirements).toContainEqual({
      id: admission.id,
      buildId: admission.buildId,
      epoch: admission.epoch,
      outcome: "fallback",
      requestedBuildId: admission.requestedBuildId,
      failureCode: admission.failureCode,
    });
  });

  it("releases a quarantined pending selector when no admitted owner uses it", () => {
    const candidate = { ...registryBuild(43), health: "staged" as const, promotion: 0 };
    let state = publishRemoteAgentStage(
      reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "quarantine", candidate),
      "quarantine",
    );
    state = quarantineRemoteAgentBuild(state, candidate.id);
    expect(state.pending).toBeNull();
    expect(retainedRemoteAgentBuilds(state).has(candidate.id)).toBe(false);
  });
});
