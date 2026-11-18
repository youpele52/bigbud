import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import { retireRemoteAgentBuildsForReplace } from "./remoteAgentInstall.replace.ts";

function build(
  version: string,
  digest: string,
  promotion: number,
  targetTriple = "aarch64-unknown-linux-gnu",
): RemoteAgentRegistryBuild {
  const sha256 = digest.repeat(64);
  const generation = `g-${digest}`;
  const statePath = `/tmp/agent/runtimes/${generation}`;
  return {
    id: `${version}:${sha256}:${targetTriple}`,
    runtime: {
      generation,
      version,
      sha256,
      buildDigest: `build-${version}`,
      targetTriple,
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

const predecessor = build("0.3.3", "a", 1);
const current = build("0.3.4", "b", 2);
interface BuildPair {
  readonly predecessor: RemoteAgentRegistryBuild;
  readonly current: RemoteAgentRegistryBuild;
}

/*
 * Durable history a real install leaves behind (matches a live registry after a replace): every
 * promoted build keeps its published stage, ready launch, update record and occupied slot, and
 * the predecessor's closed connection has moved to admission retirements.
 */
const stage = (entry: RemoteAgentRegistryBuild) => ({
  id: `update-${entry.runtime.sha256}`,
  buildId: entry.id,
  phase: "published",
});
const epoch = (entry: RemoteAgentRegistryBuild) => `epoch-${entry.runtime.version}`;

function installHistory(restaged: boolean, { predecessor, current }: BuildPair) {
  return {
    stages: [
      stage(predecessor),
      stage(current),
      ...(restaged ? [{ id: "repair-restage", buildId: predecessor.id, phase: "reserved" }] : []),
    ],
    launches: [predecessor, current].map((entry) => ({
      attemptId: `launch-${entry.runtime.generation}`,
      id: entry.runtime.generation,
      buildId: entry.id,
      phase: "ready",
      epoch: epoch(entry),
    })),
    updates: [predecessor, current].map((entry) => ({
      requestId: `update-${entry.runtime.sha256}`,
      buildId: entry.id,
      phase: "ready-for-reconnect",
      outcome: "ready",
      epoch: epoch(entry),
    })),
    slotReservations: [predecessor, current].map((entry, index) => ({
      id: `slot-${index}:update-${entry.runtime.sha256}`,
      slotId: `slot-${index}`,
      requestId: `update-${entry.runtime.sha256}`,
      buildId: entry.id,
      phase: "occupied",
    })),
    admissions: [
      {
        id: "current-connection",
        buildId: current.id,
        phase: "ready",
        epoch: epoch(current),
        outcome: "selected",
      },
    ],
    admissionRetirements: [
      {
        id: "old-connection",
        buildId: predecessor.id,
        epoch: epoch(predecessor),
        outcome: "selected",
      },
    ],
    pins: [{ owner: "connection:current-connection", buildId: current.id }],
    currentConnectionId: "current-connection",
  };
}

/** `supervisor`: how the predecessor's live supervisor answers an idle-only shutdown. */
function fixture(
  supervisor: "idle" | "busy" | "dead",
  options: { restaged?: boolean; pair?: BuildPair } = {},
) {
  const pair = options.pair ?? { predecessor, current };
  let state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      ...installHistory(options.restaged === true, pair),
      builds: [pair.predecessor, pair.current],
      current: pair.current.id,
      predecessor: pair.predecessor.id,
      promotionSequence: 2,
    }),
  );
  let alive = supervisor !== "dead";
  const run = vi.fn(async (command: string) => {
    if (command.includes("printf exited")) return alive ? "uncertain" : "exited";
    // Launch-exit reconciliation: a free launch lock plus a matching exit receipt proves death.
    if (command.includes("launch.intent")) return alive ? "live" : "dead";
    if (command.includes("--shutdown-supervisor")) {
      if (supervisor === "busy") return "shutdown-refused";
      alive = false;
      return "shutdown-accepted";
    }
    if (command.includes('rm -- "$binary"')) return "deleted";
    if (command.includes(pair.predecessor.runtime.statePath)) return alive ? "live" : "dead";
    return "dead";
  });
  const control: RemoteAgentControl = {
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
  return { control, run, state: () => state };
}

describe("remote agent --replace retirement", () => {
  it("retires an idle unreferenced predecessor and reports no deferred cleanup", async () => {
    const f = fixture("idle");
    const fence = vi.fn(async () => () => undefined);
    const result = await retireRemoteAgentBuildsForReplace({
      target: "ssh:fixture",
      control: f.control,
      referencedBuildIds: async () => new Set([current.id]),
      beginRetirement: fence,
    });
    expect(result).toEqual({ deleted: 1, deferred: 0 });
    expect(f.state().builds.find((entry) => entry.id === predecessor.id)?.binary).toBe("absent");
    expect(f.state().predecessor).toBeNull();
    expect(fence).toHaveBeenCalledWith(predecessor.runtime.generation);
    expect(
      f.run.mock.calls.some(([command]) => String(command).includes("--shutdown-supervisor")),
    ).toBe(true);
    const after = f.state();
    expect(after.launches.find((entry) => entry.buildId === predecessor.id)?.phase).toBe(
      "proven-dead",
    );
    // Only the acknowledged history record is consumed; the current build keeps its own.
    expect(after.stages.map((entry) => entry.buildId)).toEqual([current.id]);
    expect(after.launches.find((entry) => entry.buildId === current.id)?.phase).toBe("ready");
  });

  it("retires a same-version glibc build after the musl build is active (D4, by build ID)", async () => {
    const gnu = build("0.3.4", "a", 1, "aarch64-unknown-linux-gnu");
    const musl = build("0.3.4", "b", 2, "aarch64-unknown-linux-musl");
    expect(gnu.id).not.toBe(musl.id);
    const f = fixture("idle", { pair: { predecessor: gnu, current: musl } });
    expect(
      await retireRemoteAgentBuildsForReplace({
        target: "ssh:fixture",
        control: f.control,
        referencedBuildIds: async () => new Set([musl.id]),
      }),
    ).toEqual({ deleted: 1, deferred: 0 });
    const after = f.state();
    expect(after.builds.find((entry) => entry.id === gnu.id)?.binary).toBe("absent");
    expect(after.builds.find((entry) => entry.id === musl.id)?.binary).toBe("present");
    expect(after.current).toBe(musl.id);
    // Live work on the glibc build still defers it; a matching version is never enough.
    const busy = fixture("idle", { pair: { predecessor: gnu, current: musl } });
    expect(
      await retireRemoteAgentBuildsForReplace({
        target: "ssh:fixture",
        control: busy.control,
        referencedBuildIds: async () => new Set([musl.id, gnu.id]),
      }),
    ).toEqual({ deleted: 0, deferred: 1 });
  });

  it("retires an already-exited predecessor without asking it to shut down", async () => {
    const f = fixture("dead");
    const result = await retireRemoteAgentBuildsForReplace({
      target: "ssh:fixture",
      control: f.control,
      referencedBuildIds: async () => new Set([current.id]),
    });
    expect(result).toEqual({ deleted: 1, deferred: 0 });
    expect(
      f.run.mock.calls.some(([command]) => String(command).includes("--shutdown-supervisor")),
    ).toBe(false);
  });

  it("defers when another controller is re-staging the predecessor", async () => {
    const f = fixture("idle", { restaged: true });
    const result = await retireRemoteAgentBuildsForReplace({
      target: "ssh:fixture",
      control: f.control,
      referencedBuildIds: async () => new Set([current.id]),
    });
    expect(result).toEqual({ deleted: 0, deferred: 1 });
    expect(f.state().builds.find((entry) => entry.id === predecessor.id)?.binary).toBe("present");
    expect(
      f.run.mock.calls.some(([command]) => String(command).includes("--shutdown-supervisor")),
    ).toBe(false);
  });

  it("never interrupts a busy predecessor and reports cleanup deferred, not the current build", async () => {
    const f = fixture("busy");
    const result = await retireRemoteAgentBuildsForReplace({
      target: "ssh:fixture",
      control: f.control,
      referencedBuildIds: async () => new Set([current.id]),
    });
    expect(result).toEqual({ deleted: 0, deferred: 1 });
    expect(f.state().builds.find((entry) => entry.id === predecessor.id)?.binary).toBe("present");
  });

  it("keeps a predecessor that live local work references, or when ownership is unknown", async () => {
    const referenced = fixture("idle");
    expect(
      await retireRemoteAgentBuildsForReplace({
        target: "ssh:fixture",
        control: referenced.control,
        referencedBuildIds: async () => new Set([current.id, predecessor.id]),
      }),
    ).toEqual({ deleted: 0, deferred: 1 });
    const unknown = fixture("idle");
    expect(
      await retireRemoteAgentBuildsForReplace({ target: "ssh:fixture", control: unknown.control }),
    ).toEqual({ deleted: 0, deferred: 1 });
    expect(
      unknown.run.mock.calls.some(([command]) => String(command).includes("--shutdown-supervisor")),
    ).toBe(false);
  });

  it("counts only managed builds whose bytes may remain, never user-managed legacy installs", async () => {
    const f = fixture("busy");
    const legacy = build("0.2.0", "c", 1);
    await f.control.registry.update((state) => ({
      ...state,
      builds: [
        ...state.builds,
        {
          ...legacy,
          id: `${legacy.id}:legacy`,
          runtime: { ...legacy.runtime, origin: "legacy-external" as const },
        },
      ],
    }));
    // Busy predecessor stays (1); the legacy-external install is not bigbud's to retire.
    expect(
      await retireRemoteAgentBuildsForReplace({
        target: "ssh:fixture",
        control: f.control,
        referencedBuildIds: async () => new Set([current.id]),
      }),
    ).toEqual({ deleted: 0, deferred: 1 });
  });
});
