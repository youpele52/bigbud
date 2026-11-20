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
import {
  publishRemoteAgentStage,
  reserveRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";

function build(version: string, digest: string, promotion: number): RemoteAgentRegistryBuild {
  const sha256 = digest.repeat(64);
  const generation = `g-${digest}`;
  const statePath = `/tmp/agent/runtimes/${generation}`;
  return {
    id: `${version}:${sha256}:x86_64-unknown-linux-musl`,
    runtime: {
      generation,
      version,
      sha256,
      buildDigest: `build-${version}`,
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    },
    health: "healthy",
    promotion,
    binary: "present",
    authenticated: true,
  };
}

const old = build("0.3.3", "a", 1);
const current = build("0.3.4", "b", 2);

function registry(patch: Record<string, unknown>): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      builds: [old, current],
      current: current.id,
      predecessor: old.id,
      promotionSequence: 2,
      ...patch,
    }),
  );
}

const stage = (phase: string, id = "update-a") => ({ id, buildId: old.id, phase });
const launch = (phase: string) => ({
  attemptId: "launch-g-a",
  id: "g-a",
  buildId: old.id,
  phase,
  epoch: "epoch-a",
});
const reserve = (state: RemoteAgentRegistry, allowLiveLaunch = false) =>
  reserveRemoteAgentRetirement(state, {
    id: "retire-replace-g-a",
    buildId: old.id,
    allowPredecessorReservation: true,
    ...(allowLiveLaunch ? { allowLiveLaunch: true } : {}),
  });

describe("remote agent retirement reservation", () => {
  it("consumes acknowledged publication history atomically with the reservation", () => {
    const reserved = reserve(
      registry({
        stages: [stage("published"), { ...stage("published", "update-b"), buildId: current.id }],
      }),
    );
    expect(reserved.stages.map((entry) => entry.buildId)).toEqual([current.id]);
    expect(reserved.retirementReservations.map((entry) => entry.phase)).toEqual(["reserved"]);
  });

  it("keeps blocking a published build that is still pending activation", () => {
    expect(() => reserve(registry({ stages: [stage("published")], pending: old.id }))).toThrow(
      "durable references",
    );
  });

  it("keeps blocking active or ambiguous staging of the same build", () => {
    for (const phase of ["reserved", "failed"]) {
      const entry = phase === "failed" ? { ...stage(phase), failure: "ambiguous" } : stage(phase);
      expect(() =>
        reserve(registry({ stages: [stage("published"), { ...entry, id: "restage" }] })),
      ).toThrow("durable references");
    }
  });

  it("accepts a ready launch only for the idle-shutdown path, never an uncertain launch", () => {
    expect(() => reserve(registry({ launches: [launch("ready")] }))).toThrow("durable references");
    expect(
      reserve(registry({ launches: [launch("ready")] }), true).retirementReservations,
    ).toHaveLength(1);
    for (const phase of ["reserved", "spawn-uncertain"]) {
      expect(() => reserve(registry({ launches: [launch(phase)] }), true)).toThrow(
        "durable references",
      );
    }
  });

  describe("races with a concurrent re-stage of the same build (production stage id)", () => {
    const productionStage = `update-${old.runtime.sha256}`;
    const published = () =>
      registry({ stages: [{ id: productionStage, buildId: old.id, phase: "published" }] });

    it("re-opens an acknowledged publication as a live claim that blocks retirement", () => {
      const restaged = reserveRemoteAgentStage(published(), productionStage, old);
      expect(restaged.stages).toEqual([
        { id: productionStage, buildId: old.id, phase: "reserved" },
      ]);
      expect(() => reserve(restaged)).toThrow("durable references");
      // Publication then makes it pending again, exactly like a first-time stage.
      expect(publishRemoteAgentStage(restaged, productionStage).pending).toBe(old.id);
    });

    it("lets a re-stage beat a pre-tombstone retirement, refusing only an in-progress unlink", () => {
      // A crashed controller's reservation must not block staging forever (#2).
      const reserved = reserve(published());
      expect(reserved.stages).toEqual([]);
      const restaged = reserveRemoteAgentStage(reserved, productionStage, old);
      expect(restaged.stages.map((entry) => entry.phase)).toEqual(["reserved"]);
      const exited = advanceRemoteAgentRetirement(restaged, "retire-replace-g-a", "exited");
      expect(() => tombstoneRemoteAgentRetirement(exited, "retire-replace-g-a")).toThrow(
        "gained a reference",
      );
      const deleting = registry({
        builds: [{ ...old, binary: "deleting" }, current],
        stages: [{ id: productionStage, buildId: old.id, phase: "reserved" }],
      });
      expect(() => reserveRemoteAgentStage(deleting, productionStage, old)).toThrow(
        "deletion must reconcile",
      );
      expect(() => publishRemoteAgentStage(deleting, productionStage)).toThrow(
        "deletion must reconcile",
      );
    });

    it("drops the completed retirement of absent bytes when they are re-staged (rollback)", () => {
      const retired = registry({
        builds: [{ ...old, binary: "absent" }, current],
        retirementReservations: [
          { id: "r", buildId: old.id, generation: old.runtime.generation, phase: "tombstoned" },
        ],
      });
      const restaged = reserveRemoteAgentStage(retired, productionStage, old);
      expect(restaged.retirementReservations).toEqual([]);
      const republished = publishRemoteAgentStage(restaged, productionStage);
      expect(republished.builds[0]?.binary).toBe("present");
      // No stale row fences a later retirement of the reinstalled build ("already reserved").
      const again = reserveRemoteAgentRetirement(
        { ...republished, pending: null },
        { id: "other", buildId: old.id, allowPredecessorReservation: true },
      );
      expect(again.retirementReservations.map((entry) => [entry.id, entry.phase])).toEqual([
        ["other", "reserved"],
      ]);
    });

    it("re-opens a cancelled stage record instead of failing every later re-stage", () => {
      const cancelled = registry({
        stages: [{ id: productionStage, buildId: old.id, phase: "cancelled" }],
      });
      const restaged = reserveRemoteAgentStage(cancelled, productionStage, old);
      expect(restaged.stages.map((entry) => entry.phase)).toEqual(["reserved"]);
      expect(publishRemoteAgentStage(restaged, productionStage).pending).toBe(old.id);
    });

    it("leaves re-staging the current build unchanged", () => {
      const state = registry({
        stages: [
          { id: `update-${current.runtime.sha256}`, buildId: current.id, phase: "published" },
        ],
      });
      expect(reserveRemoteAgentStage(state, `update-${current.runtime.sha256}`, current)).toBe(
        state,
      );
    });

    it("rechecks references in the write that commits to deletion", () => {
      const exited = advanceRemoteAgentRetirement(
        reserve(published()),
        "retire-replace-g-a",
        "exited",
      );
      expect(tombstoneRemoteAgentRetirement(exited, "retire-replace-g-a").builds[0]?.binary).toBe(
        "deleting",
      );
      const pinned = { ...exited, pins: [{ owner: "terminal:late", buildId: old.id }] };
      expect(() => tombstoneRemoteAgentRetirement(pinned, "retire-replace-g-a")).toThrow(
        "gained a reference",
      );
    });
  });

  it("rejects an altered immutable descriptor even when the stage id already exists", () => {
    const state = registry({ stages: [stage("published")] });
    const altered = { ...old, runtime: { ...old.runtime, buildDigest: "different" } };
    expect(() => reserveRemoteAgentStage(state, "update-a", altered)).toThrow(
      "Immutable runtime descriptor conflict",
    );
  });

  it("does not treat completed restart history as a live reference", () => {
    const state = registry({
      restartReservations: [
        {
          id: "completed-restart",
          buildId: old.id,
          generation: old.runtime.generation,
          expectedEpoch: "old-epoch",
          phase: "ready",
        },
      ],
    });
    expect(() => reserve(state)).not.toThrow();
  });

  it("uses one reference set: restarts and in-flight updates block, its own update does not", () => {
    const exited = advanceRemoteAgentRetirement(
      reserve(registry({})),
      "retire-replace-g-a",
      "exited",
    );
    const update = (requestId: string, phase: string) => ({ requestId, buildId: old.id, phase });
    expect(
      tombstoneRemoteAgentRetirement(
        { ...exited, updates: [update("retire-replace-g-a", "reserved")] } as never,
        "retire-replace-g-a",
      ).builds[0]?.binary,
    ).toBe("deleting");
    for (const patch of [
      { updates: [update("update-a", "installing")] },
      {
        restartReservations: [
          {
            id: "restart",
            buildId: old.id,
            generation: old.runtime.generation,
            expectedEpoch: "e",
            phase: "stopping",
          },
        ],
      },
    ]) {
      expect(() =>
        tombstoneRemoteAgentRetirement({ ...exited, ...patch } as never, "retire-replace-g-a"),
      ).toThrow("gained a reference");
    }
    // A completed install record on an older build is history, not a use.
    expect(() =>
      tombstoneRemoteAgentRetirement(
        { ...exited, updates: [update("update-a", "ready-for-reconnect")] } as never,
        "retire-replace-g-a",
      ),
    ).not.toThrow();
  });
});

it.each(["deleting", "absent"] as const)(
  "clears only its withdrawal claim after %s deletion",
  (binary) => {
    const id = "retire-replace-g-a";
    const exited = advanceRemoteAgentRetirement(reserve(registry({})), id, "exited");
    const synthetic = {
      requestId: id,
      buildId: old.id,
      phase: "reserved" as const,
      outcome: "capacity" as const,
    };
    const unrelated = {
      requestId: "completed-update",
      buildId: old.id,
      phase: "ready-for-reconnect" as const,
    };
    const tombstone = tombstoneRemoteAgentRetirement(
      { ...exited, updates: [synthetic, unrelated] },
      id,
    );
    const state = parseRemoteAgentRegistry(
      JSON.stringify({
        ...tombstone,
        builds: [{ ...old, binary }, current],
      }),
    );
    const confirmed = confirmRemoteAgentRetirementDeletion(state, id);
    expect(confirmed.updates).toEqual([unrelated]);
    expect(confirmed.retirementReservations).toEqual(state.retirementReservations);
    expect(confirmed.builds.find((entry) => entry.id === old.id)?.binary).toBe("absent");
    expect(confirmRemoteAgentRetirementDeletion(confirmed, id)).toBe(confirmed);
  },
);
