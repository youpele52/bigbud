import { reserveRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import { describe, expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { withoutCompletedRetirementClaims } from "./remoteAgentInstall.registry.orphans.ts";
import {
  reserveRemoteAgentStage,
  publishRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { pruneRemoteAgentHistory } from "./remoteAgentInstall.registry.admission.ts";
import { reserveRemoteAgentRetirement } from "./remoteAgentInstall.registry.retirement.ts";

function fixture(index = 1): RemoteAgentRegistry {
  const sha256 = String(index).repeat(64).slice(0, 64);
  const generation = `g-${index}`;
  const statePath = `/tmp/agent/runtimes/${generation}`;
  const id = `0.3.3:${sha256}:x86_64-unknown-linux-musl`;
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      promotionSequence: 1,
      builds: [
        {
          id,
          health: "healthy",
          promotion: 1,
          binary: "absent",
          authenticated: true,
          runtime: {
            generation,
            version: "0.3.3",
            sha256,
            buildDigest: "fixture",
            targetTriple: "x86_64-unknown-linux-musl",
            origin: "managed",
            binaryPath: `/tmp/agent/bin/0.3.3/${sha256}/bigbud-remote-agent`,
            statePath,
            socketPath: `${statePath}/supervisor.sock`,
            logPath: `${statePath}/supervisor.log`,
          },
        },
      ],
      updates: [
        {
          requestId: `retire-replace-${generation}`,
          buildId: id,
          phase: "reserved",
          outcome: "capacity",
        },
      ],
    }),
  );
}

describe("legacy completed retirement claims", () => {
  it("repairs during re-stage in the same revision and permits subsequent retirement", () => {
    const state = fixture();
    const build = state.builds[0]!;
    const restaged = reserveRemoteAgentStage(state, "new-stage", build);
    expect(restaged.revision).toBe(state.revision + 1);
    expect(restaged.updates).toEqual([]);
    const published = publishRemoteAgentStage(restaged, "new-stage");
    expect(() =>
      reserveRemoteAgentRetirement(
        { ...published, pending: null },
        {
          id: "new-retirement",
          buildId: build.id,
        },
      ),
    ).not.toThrow();
    expect(state.updates).toHaveLength(1);
  });

  it("repairs before production update and slot reservation create new claims", () => {
    const state = fixture();
    const build = state.builds[0]!;
    const capacity = reserveRemoteAgentUpdate({
      state,
      build,
      requestId: "new-stage",
      inventory: {
        entries: [],
        partialCandidate: false,
        uniqueDigests: new Set<string>(),
        uncertain: false,
        unknownOwner: false,
        noncompliant: false,
        untracked: false,
      },
    });
    expect(capacity.state.revision).toBe(state.revision + 1);
    expect(capacity.state.updates.map((x) => x.requestId)).toEqual(["new-stage"]);
    const staged = reserveRemoteAgentStage(capacity.state, "new-stage", build);
    expect(staged.updates.map((x) => x.requestId)).toEqual(["new-stage"]);
    expect(staged.slotReservations[0]?.phase).toBe("reserved");
  });

  it("repairs during ordinary history pruning without an extra CAS revision", () => {
    const state = fixture();
    const next = pruneRemoteAgentHistory(state);
    expect(next.revision).toBe(state.revision + 1);
    expect(next.updates).toEqual([]);
    expect(next.builds[0]?.binary).toBe("absent");
    expect(withoutCompletedRetirementClaims(next)).toBe(next.updates);
  });

  it.each([
    "present",
    "deleting",
    "predecessor",
    "current",
    "pending",
    "pin",
    "stage",
    "launch",
    "admission",
    "restart",
    "update",
    "slot",
    "retirement",
    "unknown-id",
  ])("preserves uncertain/competing evidence: %s", (kind) => {
    const state = fixture();
    const build = state.builds[0]!;
    // Negative predicates deliberately include inconsistent states: never repair on ambiguity.
    const patch: Record<string, unknown> = {};
    if (kind === "present" || kind === "deleting") patch.builds = [{ ...build, binary: kind }];
    if (["current", "pending", "predecessor"].includes(kind)) patch[kind] = build.id;
    if (kind === "pin") patch.pins = [{ owner: "work", buildId: build.id }];
    if (kind === "stage") patch.stages = [{ id: "stage", buildId: build.id, phase: "reserved" }];
    if (kind === "launch")
      patch.launches = [
        { id: build.runtime.generation, buildId: build.id, phase: "spawn-uncertain" },
      ];
    if (kind === "admission")
      patch.admissions = [{ id: "admission", buildId: build.id, phase: "prepared" }];
    if (kind === "restart")
      patch.restartReservations = [{ id: "restart", buildId: build.id, phase: "starting" }];
    if (kind === "update")
      patch.updates = [
        ...state.updates,
        { requestId: "other", buildId: build.id, phase: "installing" },
      ];
    if (kind === "slot")
      patch.slotReservations = [{ id: "slot", buildId: build.id, phase: "occupied" }];
    if (kind === "retirement")
      patch.retirementReservations = [{ id: "retire", buildId: build.id, phase: "tombstoned" }];
    if (kind === "unknown-id")
      patch.updates = [{ ...state.updates[0], requestId: "unrelated-request" }];
    const candidate = { ...state, ...patch } as RemoteAgentRegistry;
    expect(withoutCompletedRetirementClaims(candidate)).toBe(candidate.updates);
  });

  it("limits each repair to eight rows and can target only the build being staged", () => {
    const fixtures = Array.from({ length: 9 }, (_, i) => fixture(i + 1));
    const state = {
      ...fixture(),
      builds: fixtures.flatMap((x) => x.builds),
      updates: fixtures.flatMap((x) => x.updates),
    };
    expect(withoutCompletedRetirementClaims(state)).toHaveLength(1);
    const targeted = withoutCompletedRetirementClaims(state, fixtures[8]!.builds[0]!.id);
    expect(targeted).toHaveLength(8);
    expect(targeted).toEqual(state.updates.slice(0, 8));
  });
});
