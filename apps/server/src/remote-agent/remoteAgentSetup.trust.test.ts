import { describe, expect, it } from "vitest";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { source, setup } from "./remoteAgentSetup.fixture.ts";

const unsignedSource = {
  ...source,
  trustStore: {},
  allowUntrustedDevelopmentArtifact: true as const,
};

describe("signed adoption of previously staged managed artifacts", () => {
  it("rechecks a published managed installation before upgrading its signature trust", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source: unsignedSource });
    const unsigned = await f.control.registry.read();
    expect(unsigned.builds[0]?.authenticated).toBe(false);
    expect(unsigned.stages[0]?.phase).toBe("published");
    await f.manager.install({ executionTargetId: f.target, source });
    const signed = await f.control.registry.read();
    expect(signed.revision).toBe(unsigned.revision + 1);
    expect(signed.builds[0]?.authenticated).toBe(true);
    expect(signed.builds[0]?.runtime).toEqual(unsigned.builds[0]?.runtime);
    expect(f.installArtifact).toHaveBeenCalledTimes(2);
    expect(f.verifyInstalledAgent).toHaveBeenCalledTimes(2);
    expect(signed.launches).toEqual([]);
  });

  it("automatically authenticates the matching managed build before connecting", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source: unsignedSource });
    const prepared = await f.coordinator.prepareForAdmission(f.target, "authenticate");
    expect(prepared.warning).toBeUndefined();
    const connected = await f.admission.fresh(f.target, "authenticate", prepared);
    expect(
      connected.state.builds.find((build) => build.id === connected.state.current)?.authenticated,
    ).toBe(true);
    expect(f.installArtifact).toHaveBeenCalledTimes(2);
    expect(f.verifyInstalledAgent).toHaveBeenCalledTimes(2);
  });

  it("does not grant trust when a signed recheck fails", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source: unsignedSource });
    f.verifyInstalledAgent.mockRejectedValueOnce(new Error("installed identity mismatch"));
    await expect(f.coordinator.prepareForAdmission(f.target, "recheck-failed")).rejects.toThrow(
      "installed identity mismatch",
    );
    expect((await f.control.registry.read()).builds[0]?.authenticated).toBe(false);
    expect(f.control.run).not.toHaveBeenCalled();
  });

  it("installs a distinct signed managed runtime without granting trust to matching legacy bytes", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source: unsignedSource });
    const initial = await f.control.registry.read();
    const legacyRuntime = {
      ...initial.builds[0]!.runtime,
      origin: "legacy-external" as const,
      generation: "legacy",
      binaryPath: "/tmp/legacy-agent",
      statePath: "/tmp/legacy-state",
      socketPath: "/tmp/legacy-state/supervisor.sock",
      logPath: "/tmp/legacy-state/supervisor.log",
    };
    const legacyId = remoteAgentBuildId(legacyRuntime);
    await f.control.registry.update((state) =>
      nextRemoteAgentRegistryRevision(state, {
        current: legacyId,
        pending: null,
        stages: [],
        builds: [{ ...state.builds[0]!, id: legacyId, runtime: legacyRuntime }],
        launches: [{ id: "legacy", buildId: legacyId, phase: "ready", epoch: "legacy-epoch" }],
        pins: [{ owner: "unknown-legacy-owner", buildId: legacyId }],
      }),
    );
    const before = await f.control.registry.read();
    const prepared = await f.coordinator.prepareForAdmission(f.target, "legacy");
    expect(prepared.requestedBuildId).not.toBe(legacyId);
    const connected = await f.admission.fresh(f.target, "legacy", prepared);
    expect(connected.state.current).toBe(prepared.requestedBuildId);
    expect(connected.state.builds.find((build) => build.id === legacyId)).toEqual(before.builds[0]);
    expect(connected.state.pins).toContainEqual({
      owner: "unknown-legacy-owner",
      buildId: legacyId,
    });
    expect(connected.state.launches.find((launch) => launch.buildId === legacyId)).toEqual(
      before.launches[0],
    );
    expect(f.installArtifact).toHaveBeenCalledTimes(2);
  });

  it.each(["before", "after"] as const)(
    "reconciles a failed reply only if trust publication committed (%s)",
    async (timing) => {
      const f = setup();
      await f.manager.install({ executionTargetId: f.target, source: unsignedSource });
      const updateRegistry = f.control.registry.update;
      f.control.registry.update = async (transition) => {
        let publishingTrust = false;
        const result = await updateRegistry((current) => {
          const next = transition(current);
          publishingTrust =
            !current.builds[0]?.authenticated && next.builds[0]?.authenticated === true;
          if (publishingTrust && timing === "before") throw new Error("trust publication failed");
          return next;
        });
        if (publishingTrust && timing === "after") throw new Error("trust publication reply lost");
        return result;
      };
      const installation = f.manager.install({ executionTargetId: f.target, source });
      if (timing === "before")
        await expect(installation).rejects.toThrow("trust publication failed");
      else await expect(installation).resolves.toMatchObject({ status: "staged" });
      expect((await f.control.registry.read()).builds[0]?.authenticated).toBe(timing === "after");
    },
  );
});
