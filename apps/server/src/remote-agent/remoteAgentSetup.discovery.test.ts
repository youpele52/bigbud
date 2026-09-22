import { describe, expect, it } from "vitest";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";
import { artifact, source, setup, seedStable } from "./remoteAgentSetup.fixture.ts";
import { prepareStagedRemoteAgentCandidate } from "./remoteAgentUpdate.prepare.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";

async function seedNewerPending(
  f: ReturnType<typeof setup>,
  failure?: "quarantined" | "proven-dead",
) {
  const state = await f.control.registry.read();
  const sha256 = "c".repeat(64);
  const runtime = {
    ...state.builds[0]!.runtime,
    version: "0.2.999",
    sha256,
    generation: "newer",
    binaryPath: `/tmp/home/.bigbud/agent/bin/0.2.999/${sha256}/bigbud-remote-agent`,
    statePath: "/tmp/home/.bigbud/agent/runtimes/newer",
    socketPath: "/tmp/home/.bigbud/agent/runtimes/newer/supervisor.sock",
    logPath: "/tmp/home/.bigbud/agent/runtimes/newer/supervisor.log",
  };
  const id = remoteAgentBuildId(runtime);
  await f.control.registry.update((current) =>
    nextRemoteAgentRegistryRevision(current, {
      pending: id,
      builds: [
        ...current.builds,
        {
          id,
          runtime,
          authenticated: true,
          binary: "present",
          promotion: 0,
          health: failure === "quarantined" ? "quarantined" : "staged",
        },
      ],
      launches: [
        ...current.launches,
        {
          id: "newer",
          buildId: id,
          phase: failure === "proven-dead" ? "proven-dead" : "ready",
          epoch: "setup-epoch",
        },
      ],
      updates: [
        {
          requestId: "newer-update",
          buildId: id,
          phase: "ready-for-reconnect",
          epoch: "setup-epoch",
        },
      ],
      pins: [...current.pins, { owner: "retained-newer", buildId: id }],
    }),
  );
  return id;
}

describe("compatible release discovery with retained newer builds", () => {
  it("keeps a newer healthy current runtime when an older ready pending build exists", async () => {
    const f = setup();
    const currentId = await seedStable(f, true, "0.2.999");
    await f.manager.install({ executionTargetId: f.target, source });
    const pending = (await f.control.registry.read()).pending!;
    await prepareStagedRemoteAgentCandidate({
      target: f.target,
      requestId: `update-${artifact.sha256}`,
      buildId: pending,
      control: f.control,
      connect: f.connect,
    });
    const prepared = await f.coordinator.prepareForAdmission(f.target, "newer-current");
    expect(prepared).toEqual({ requestedBuildId: currentId, requestedVersion: "0.2.999" });
    const connected = await f.admission.fresh(f.target, "newer-current", prepared);
    expect(connected.state.current).toBe(currentId);
    expect(connected.state.admissions.at(-1)?.outcome).toBe("selected");
    expect(f.installArtifact).toHaveBeenCalledOnce();
  });

  it.each(["quarantined", "proven-dead"] as const)(
    "attempts the configured update despite a %s newer pending build, warning if capacity blocks it",
    async (failure) => {
      const f = setup();
      const currentId = await seedStable(f);
      const retainedId = await seedNewerPending(f, failure);
      Object.assign(f.control, {
        inventory: async () => ({
          entries: [],
          uniqueDigests: new Set(["b".repeat(64), "c".repeat(64)]),
          partialCandidate: false,
          unknownOwner: false,
          untracked: false,
          uncertain: false,
          noncompliant: false,
        }),
      });
      const prepared = await f.coordinator.prepareForAdmission(f.target, "blocked-update");
      expect(prepared.requestedVersion).toBe(artifact.version);
      expect(prepared.warning).toContain("Both remote agent storage slots are occupied");
      expect((await f.control.registry.read()).updates.at(-1)?.phase).toBe("waiting-for-capacity");
      const connected = await f.admission.fresh(f.target, "blocked-update", prepared);
      expect(connected.state.current).toBe(currentId);
      expect(connected.state.admissions.at(-1)?.outcome).toBe("fallback");
      expect(connected.state.pins).toContainEqual({ owner: "retained-newer", buildId: retainedId });
    },
  );

  it.each(["quarantined", "proven-dead"] as const)(
    "does not let an unusable newer current runtime block installation (%s)",
    async (failure) => {
      const f = setup();
      await seedStable(f, true, "0.2.999");
      await f.control.registry.update((state) =>
        nextRemoteAgentRegistryRevision(
          state,
          failure === "quarantined"
            ? {
                builds: state.builds.map((build) => ({ ...build, health: "quarantined" as const })),
              }
            : {
                launches: state.launches.map((launch) => ({
                  ...launch,
                  phase: "proven-dead" as const,
                })),
              },
        ),
      );
      const prepared = await f.coordinator.prepareForAdmission(f.target, "replace-unusable");
      expect(prepared.requestedVersion).toBe(artifact.version);
      expect(prepared.warning).toBeUndefined();
      expect(f.installArtifact).toHaveBeenCalledOnce();
    },
  );

  it("selects the exact newer authenticated ready pending runtime", async () => {
    const f = setup();
    await seedStable(f);
    const pendingId = await seedNewerPending(f);
    const prepared = await f.coordinator.prepareForAdmission(f.target, "newer-pending");
    expect(prepared).toEqual({ requestedBuildId: pendingId, requestedVersion: "0.2.999" });
    const connected = await f.admission.fresh(f.target, "newer-pending", prepared);
    expect(connected.state.current).toBe(pendingId);
    expect(f.installArtifact).not.toHaveBeenCalled();
  });
});
