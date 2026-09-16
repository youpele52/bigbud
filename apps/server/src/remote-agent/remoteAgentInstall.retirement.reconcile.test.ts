import { expect, it } from "vitest";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import { reconcileRemoteAgentRetirementTombstones } from "./remoteAgentInstall.retirement.reconcile.ts";

function build(
  number: number,
  binary: RemoteAgentRegistryBuild["binary"],
): RemoteAgentRegistryBuild {
  const version = `0.2.${number}`;
  const sha256 = String(number).repeat(64).slice(0, 64);
  const generation = `g${number}`;
  const statePath = `/tmp/agent/runtimes/${generation}`;
  const runtime = {
    generation,
    version,
    sha256,
    buildDigest: `digest-${number}`,
    targetTriple: "aarch64-unknown-linux-gnu" as const,
    binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
    origin: "managed" as const,
  };
  return {
    id: `${version}:${sha256}:${runtime.targetTriple}`,
    runtime,
    health: "healthy",
    promotion: number,
    binary,
    authenticated: true,
  };
}

function controlFor(
  initial: RemoteAgentRegistry,
  failDeletion = false,
): {
  readonly control: RemoteAgentControl;
  read: () => RemoteAgentRegistry;
  commands: string[];
} {
  let state = initial;
  const commands: string[] = [];
  const control: RemoteAgentControl = {
    root: "/tmp/agent",
    run: async (command) => {
      commands.push(command);
      if (failDeletion && command.includes('rm -- "$binary"'))
        throw new Error("remote deletion unavailable");
      return command.includes("test -S") ? "dead" : "deleted";
    },
    registry: {
      read: async () => state,
      update: async (transition) => {
        state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
        return state;
      },
    },
  };
  return { control, read: () => state, commands };
}

function tombstonedState(updatePhase: "promoted" | "installing"): RemoteAgentRegistry {
  const obsolete = build(1, "deleting");
  const current = build(2, "present");
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      promotionSequence: 2,
      builds: [obsolete, current],
      current: current.id,
      retirementReservations: [
        { id: "retire-obsolete", buildId: obsolete.id, generation: "g1", phase: "tombstoned" },
      ],
      updates: [{ requestId: "old-update", buildId: obsolete.id, phase: updatePhase }],
      slotReservations: [
        {
          id: "slot-0:old-update:1",
          slotId: "slot-0",
          requestId: "old-update",
          buildId: obsolete.id,
          phase: "occupied",
        },
      ],
    }),
  );
}

it("reconciles terminal update history while preserving slot replay evidence", async () => {
  const fixture = controlFor(tombstonedState("promoted"));
  await expect(reconcileRemoteAgentRetirementTombstones(fixture.control)).resolves.toBe(1);
  const state = fixture.read();
  expect(state.builds[0]?.binary).toBe("absent");
  expect(state.slotReservations[0]?.phase).toBe("released");
  expect(state.updates[0]).toMatchObject({ requestId: "old-update", phase: "promoted" });
  expect(fixture.commands).toHaveLength(2);
});

it("defers a tombstone with an active update reference", async () => {
  const fixture = controlFor(tombstonedState("installing"));
  await expect(reconcileRemoteAgentRetirementTombstones(fixture.control)).resolves.toBe(0);
  expect(fixture.read().builds[0]?.binary).toBe("deleting");
  expect(fixture.commands).toHaveLength(0);
});

it("preserves a tombstone when the retry command fails", async () => {
  const fixture = controlFor(tombstonedState("promoted"), true);
  await expect(reconcileRemoteAgentRetirementTombstones(fixture.control)).resolves.toBe(0);
  expect(fixture.read().builds[0]?.binary).toBe("deleting");
  expect(fixture.commands).toHaveLength(2);
});

it("does not spend reconciliation budget on an already absent tombstone", async () => {
  const initial = tombstonedState("promoted");
  const absent = parseRemoteAgentRegistry(
    JSON.stringify({
      ...initial,
      builds: initial.builds.map((entry) =>
        entry.binary === "deleting"
          ? Object.assign({}, entry, { binary: "absent" as const })
          : entry,
      ),
    }),
  );
  const fixture = controlFor(absent);
  await expect(reconcileRemoteAgentRetirementTombstones(fixture.control)).resolves.toBe(0);
  expect(fixture.commands).toHaveLength(0);
});
