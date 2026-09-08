import { describe, expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import {
  advanceRemoteAgentRetirement,
  confirmRemoteAgentRetirementDeletion,
  reserveRemoteAgentRetirement,
  tombstoneRemoteAgentRetirement,
} from "./remoteAgentInstall.registry.retirement.ts";
import { promoteRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { reserveRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import { releaseRemoteAgentSlot } from "./remoteAgentUpdate.state.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";

function build(number: number): RemoteAgentRegistryBuild {
  const version = `0.2.${number}`;
  const sha256 = String(number).repeat(64).slice(0, 64);
  const generation = `g${number}`;
  return {
    id: `${version}:${sha256}:aarch64-unknown-linux-gnu`,
    health: "staged",
    promotion: 0,
    authenticated: true,
    binary: "absent",
    runtime: {
      generation,
      version,
      sha256,
      buildDigest: `digest-${number}`,
      targetTriple: "aarch64-unknown-linux-gnu",
      binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath: `/tmp/agent/runtimes/${generation}`,
      socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
      logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
      origin: "managed",
    },
  };
}

function inventory(digests: string[], unknown = false): RemoteAgentInventory {
  return {
    entries: digests.map((digest, index) => ({
      digest,
      path: `/tmp/agent/bin/build-${index}/bigbud-remote-agent`,
      kind: "managed" as const,
    })),
    uniqueDigests: new Set(digests),
    partialCandidate: false,
    unknownOwner: unknown,
    untracked: unknown,
    uncertain: false,
    noncompliant: unknown || new Set(digests).size > 2,
  };
}

describe("remote agent strict capacity", () => {
  it("reuses a released slot without overwriting its reservation evidence", () => {
    const first = build(11);
    const next = build(12);
    const reserved = reserveRemoteAgentUpdate({
      state: emptyRemoteAgentRegistry(),
      requestId: "update-11",
      build: first,
      inventory: inventory([]),
    });
    expect(reserved.status).toBe("reserved");
    const released = releaseRemoteAgentSlot(reserved.state, first.id);
    const previous = released.slotReservations[0]!;
    expect(previous.phase).toBe("released");

    const reused = reserveRemoteAgentUpdate({
      state: released,
      requestId: "update-12",
      build: next,
      inventory: inventory([]),
    });

    expect(reused.status).toBe("reserved");
    if (reused.status !== "reserved") throw new Error("reservation");
    expect(reused.slotId).toBe("slot-0");
    expect(reused.state.slotReservations).toEqual([
      previous,
      expect.objectContaining({
        slotId: "slot-0",
        requestId: "update-12",
        buildId: next.id,
        phase: "reserved",
      }),
    ]);
    expect(reused.state.slotReservations[1]?.id).not.toBe(previous.id);
  });

  it("derives the stable slot from legacy rows while preserving unique evidence", () => {
    const first = build(13);
    const next = build(14);
    const initial = reserveRemoteAgentUpdate({
      state: emptyRemoteAgentRegistry(),
      requestId: "update-13",
      build: first,
      inventory: inventory([]),
      controllerId: "controller-a",
    });
    if (initial.status !== "reserved") throw new Error("initial reservation");
    const released = releaseRemoteAgentSlot(initial.state, first.id);
    const legacyState = {
      ...released,
      slotReservations: released.slotReservations.map(({ slotId: _slotId, ...row }) => row),
    };
    const parsed = parseRemoteAgentRegistry(JSON.stringify(legacyState));
    const reused = reserveRemoteAgentUpdate({
      state: parsed,
      requestId: "update-14",
      build: next,
      inventory: inventory([]),
      controllerId: "controller-b",
    });

    expect(reused.status).toBe("reserved");
    if (reused.status !== "reserved") throw new Error("reused reservation");
    expect(reused.slotId).toBe("slot-0");
    expect(reused.state.slotReservations[0]).toMatchObject({
      id: initial.state.slotReservations[0]?.id,
      requestId: "update-13",
      controllerId: "controller-a",
      phase: "released",
    });
    expect(reused.state.slotReservations[1]).toMatchObject({
      slotId: "slot-0",
      requestId: "update-14",
      controllerId: "controller-b",
      phase: "reserved",
    });
    expect(reused.state.slotReservations[1]?.id).not.toBe(reused.state.slotReservations[0]?.id);
  });

  it("deduplicates physical aliases and reserves at most two content slots", () => {
    const first = build(1);
    const second = build(2);
    const third = build(3);
    const duplicate = inventory([first.runtime.sha256, first.runtime.sha256]);
    const one = reserveRemoteAgentUpdate({
      state: emptyRemoteAgentRegistry(),
      requestId: "update-1",
      build: first,
      inventory: duplicate,
    });
    expect(one.status).toBe("joined");
    const two = reserveRemoteAgentUpdate({
      state: one.state,
      requestId: "update-2",
      build: second,
      inventory: duplicate,
    });
    expect(two.status).toBe("reserved");
    const full = inventory([first.runtime.sha256, second.runtime.sha256]);
    const three = reserveRemoteAgentUpdate({
      state: two.state,
      requestId: "update-3",
      build: third,
      inventory: full,
    });
    expect(three.status).toBe("waiting-for-capacity");
    expect(three.state.slotReservations).toHaveLength(1);
    expect(three.state.updates.at(-1)?.phase).toBe("waiting-for-capacity");
  });

  it("blocks an untracked owner without deleting or reserving another build", () => {
    const candidate = build(4);
    const result = reserveRemoteAgentUpdate({
      state: emptyRemoteAgentRegistry(),
      requestId: "update-4",
      build: candidate,
      inventory: inventory([String(9).repeat(64)], true),
    });
    expect(result.status).toBe("capacity-noncompliant");
    expect(result.state.slotReservations).toEqual([]);
    expect(result.state.updates[0]).toMatchObject({
      requestId: "update-4",
      phase: "waiting-for-capacity",
      outcome: "capacity",
    });
  });

  it("keeps crashed reservations fenced and joins aliases without a third slot", () => {
    const first = build(5);
    const second = build(6);
    const third = build(7);
    const none = inventory([]);
    const reserved = reserveRemoteAgentUpdate({
      state: emptyRemoteAgentRegistry(),
      requestId: "crashed-controller",
      build: first,
      inventory: none,
    });
    expect(reserved.status).toBe("reserved");
    const joined = reserveRemoteAgentUpdate({
      state: reserved.state,
      requestId: "alias-controller",
      build: first,
      inventory: none,
    });
    expect(joined.status).toBe("joined");
    if (joined.status !== "joined" || reserved.status !== "reserved")
      throw new Error("reservation");
    expect(joined.slotId).toBe(reserved.slotId);
    const secondReservation = reserveRemoteAgentUpdate({
      state: joined.state,
      requestId: "second-controller",
      build: second,
      inventory: none,
    });
    expect(secondReservation.status).toBe("reserved");
    const blocked = reserveRemoteAgentUpdate({
      state: secondReservation.state,
      requestId: "third-controller",
      build: third,
      inventory: none,
    });
    expect(blocked.status).toBe("waiting-for-capacity");
    expect(
      blocked.state.slotReservations.filter((entry) => entry.phase !== "released"),
    ).toHaveLength(2);
  });

  it("reclaims A for C only after B promotion and verified A retirement", () => {
    const a = { ...build(8), health: "healthy" as const, binary: "present" as const, promotion: 1 };
    const b = { ...build(9), health: "healthy" as const, binary: "present" as const, promotion: 2 };
    const c = build(10);
    let state: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      builds: [a, b],
      current: a.id,
      promotionSequence: a.promotion,
      launches: [
        { id: "launch-a", buildId: a.id, phase: "ready", epoch: "epoch-a" },
        { id: "launch-b", buildId: b.id, phase: "ready", epoch: "epoch-b" },
      ],
    };

    state = promoteRemoteAgentBuild(state, b.id);
    expect(state.predecessor).toBe(a.id);
    state = {
      ...state,
      launches: state.launches.map((launch) =>
        launch.buildId === a.id ? { ...launch, phase: "proven-dead" as const } : launch,
      ),
    };
    state = reserveRemoteAgentRetirement(state, {
      id: "retire-a",
      buildId: a.id,
      withdrawPredecessor: true,
    });
    state = advanceRemoteAgentRetirement(state, "retire-a", "fenced");
    state = advanceRemoteAgentRetirement(state, "retire-a", "exited");
    state = tombstoneRemoteAgentRetirement(state, "retire-a");
    state = confirmRemoteAgentRetirementDeletion(state, "retire-a");

    const result = reserveRemoteAgentUpdate({
      state,
      requestId: "update-c",
      build: c,
      inventory: inventory([b.runtime.sha256]),
    });
    expect(result.status).toBe("reserved");
  });
});
