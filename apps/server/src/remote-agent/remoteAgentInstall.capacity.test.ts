import { describe, expect, it, vi } from "vitest";

import { prepareRemoteAgentInstallCapacity } from "./remoteAgentInstall.capacity.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";

function build(version: string, digestCharacter: string, promotion: number) {
  const sha256 = digestCharacter.repeat(64);
  const generation = `g-${digestCharacter}`;
  const statePath = `/tmp/agent/runtimes/${generation}`;
  const runtime = {
    generation,
    version,
    sha256,
    buildDigest: `build-${version}`,
    targetTriple: "aarch64-unknown-linux-gnu" as const,
    origin: "managed" as const,
    binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
  };
  return {
    id: `${version}:${sha256}:${runtime.targetTriple}`,
    runtime,
    health: "healthy" as const,
    promotion,
    binary: "present" as const,
    authenticated: true,
  } satisfies RemoteAgentRegistryBuild;
}

function inventory(builds: ReadonlyArray<RemoteAgentRegistryBuild>): RemoteAgentInventory {
  return {
    entries: builds.map((entry) => ({
      digest: entry.runtime.sha256,
      path: entry.runtime.binaryPath,
      kind: "managed" as const,
    })),
    uniqueDigests: new Set(builds.map((entry) => entry.runtime.sha256)),
    partialCandidate: false,
    unknownOwner: false,
    untracked: false,
    uncertain: false,
    noncompliant: builds.length > 2,
  };
}

function controlFor(builds: ReadonlyArray<RemoteAgentRegistryBuild>): {
  readonly control: RemoteAgentControl;
  readonly run: ReturnType<typeof vi.fn>;
} {
  let state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      builds,
      current: builds[1]!.id,
      predecessor: builds[0]!.id,
      promotionSequence: 2,
    }),
  );
  const run = vi.fn(async (command: string) =>
    command.includes('rm -- "$binary"') ? "deleted" : "dead",
  );
  return {
    run,
    control: {
      root: "/tmp/agent",
      run,
      registry: {
        read: async () => state,
        update: async (transition) => {
          state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
          return state;
        },
      },
    },
  };
}

describe("remote agent install capacity preparation", () => {
  it("reclaims one proven unreferenced managed build before reserving a new payload", async () => {
    const predecessor = build("0.2.205", "a", 1);
    const current = build("0.2.207", "b", 2);
    const orphan = { ...build("0.2.208", "c", 0), health: "quarantined" as const };
    const candidate = build("0.2.209", "d", 0);
    const { control, run } = controlFor([predecessor, current, orphan]);

    await expect(
      prepareRemoteAgentInstallCapacity({
        target: "ssh:fixture",
        control,
        build: candidate,
        inventory: inventory([predecessor, current, orphan]),
        referencedBuildIds: async () => new Set([predecessor.id, current.id]),
      }),
    ).resolves.toBe("reclaimed");

    const state = await control.registry.read();
    expect(state.builds.find((entry) => entry.id === orphan.id)?.binary).toBe("absent");
    expect(state.builds.find((entry) => entry.id === predecessor.id)?.binary).toBe("present");
    expect(state.builds.find((entry) => entry.id === current.id)?.binary).toBe("present");
    expect(run.mock.calls.some(([command]) => String(command).includes('rm -- "$binary"'))).toBe(
      true,
    );
  });

  it("does not delete unknown physical content", async () => {
    const predecessor = build("0.2.205", "a", 1);
    const current = build("0.2.207", "b", 2);
    const candidate = build("0.2.209", "d", 0);
    const { control, run } = controlFor([predecessor, current]);
    const unknown = {
      ...inventory([predecessor, current]),
      entries: [
        ...inventory([predecessor, current]).entries,
        { digest: "c".repeat(64), path: "/tmp/agent/bin/untracked", kind: "unknown" as const },
      ],
      uniqueDigests: new Set([predecessor.runtime.sha256, current.runtime.sha256, "c".repeat(64)]),
      unknownOwner: true,
      untracked: true,
      noncompliant: true,
    };

    await expect(
      prepareRemoteAgentInstallCapacity({
        target: "ssh:fixture",
        control,
        build: candidate,
        inventory: unknown,
        referencedBuildIds: async () => new Set([predecessor.id, current.id]),
      }),
    ).resolves.toBe("deferred");
    expect(run).not.toHaveBeenCalled();
  });
});
