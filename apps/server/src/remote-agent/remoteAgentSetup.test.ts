import { describe, expect, it, vi } from "vitest";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";
import { artifact, source, setup, seedStable } from "./remoteAgentSetup.fixture.ts";

describe("explicit staged remote agent setup", () => {
  it("refreshes discovery and admits staged bytes without another download", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source });
    await f.coordinator.prepareForAdmission(f.target, "setup-1");
    const result = await f.admission.fresh(f.target, "setup-1");
    expect(result.connectionId).toBe("setup-1");
    expect(result.state.launches[0]).toMatchObject({ phase: "ready", epoch: "setup-epoch" });
    expect(result.state.current).toBe(result.state.builds[0]?.id);
    expect(f.installArtifact).toHaveBeenCalledOnce();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.control.run).toHaveBeenCalledTimes(2);
    expect(f.load.refresh).toHaveBeenCalledOnce();
    // A healthy current agent remains connectable when release discovery is unavailable.
    f.load.refresh.mockRejectedValueOnce(new Error("metadata offline"));
    await expect(f.coordinator.prepareForAdmission(f.target, "setup-2")).resolves.toMatchObject({
      warning: "metadata offline",
    });
    await f.admission.fresh(f.target, "setup-2");
    expect(f.load).not.toHaveBeenCalled();
  });

  it("waits for concurrent background preparation and launches only once", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.handshake.mockImplementationOnce(async () => {
      await gate;
      return f.handshake();
    });
    f.coordinator.enqueue({ target: f.target, trigger: "authenticated", authenticated: true });
    await vi.waitFor(() => expect(f.handshake).toHaveBeenCalledOnce());
    let finished = false;
    const preparing = f.coordinator.prepareForAdmission(f.target, "concurrent").then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await preparing;
    await f.coordinator.drain();
    await f.admission.fresh(f.target, "concurrent");
    expect(f.control.run).toHaveBeenCalledTimes(2);
    expect(f.installArtifact).toHaveBeenCalledOnce();
  });

  it("persists and propagates a handshake failure, then reconciles the same running candidate on retry", async () => {
    const f = setup();
    await f.manager.install({ executionTargetId: f.target, source });
    const failure = new Error("Supervisor handshake timed out");
    f.handshake.mockRejectedValueOnce(failure);
    await expect(f.coordinator.prepareForAdmission(f.target, "retry")).rejects.toBe(failure);
    expect(await f.coordinator.getStatus(f.target)).toMatchObject({
      phase: "verification-unavailable",
      reason: failure.message,
    });
    const failed = await f.control.registry.read();
    expect(failed.current).toBeNull();
    expect(failed.launches[0]?.phase).toBe("spawn-uncertain");
    await f.coordinator.prepareForAdmission(f.target, "retry");
    await f.admission.fresh(f.target, "retry");
    expect(f.control.run).toHaveBeenCalledTimes(3); // launch + two readiness waits, no second launch
    expect(f.installArtifact).toHaveBeenCalledOnce();
    expect((await f.control.registry.read()).updates[0]?.reason).toBeUndefined();
  });

  it("logs background failures after artifact resolution and preserves their reason", async () => {
    const f = setup();
    const failure = new Error("Supervisor handshake timed out");
    f.handshake.mockRejectedValueOnce(failure);
    f.coordinator.enqueue({ target: f.target, trigger: "authenticated", authenticated: true });
    await f.coordinator.drain();
    expect(f.logger).toHaveBeenCalledWith(failure, f.target);
    expect((await f.control.registry.read()).updates[0]).toMatchObject({
      phase: "uncertain",
      reason: failure.message,
    });
  });

  it.each(["prepared", "retired"] as const)(
    "never prepares a different build for a %s admission request",
    async (phase) => {
      const f = setup();
      await f.manager.install({ executionTargetId: f.target, source });
      const state = await f.control.registry.read();
      const buildId = state.pending!;
      await f.control.registry.update((current) =>
        nextRemoteAgentRegistryRevision(
          current,
          phase === "prepared"
            ? {
                admissions: [{ id: "pinned", buildId, phase: "prepared", epoch: "" }],
              }
            : { admissionRetirements: [{ id: "pinned", buildId, epoch: "", outcome: "rejected" }] },
        ),
      );
      await f.coordinator.prepareForAdmission(f.target, "pinned");
      expect(f.control.run).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.load).not.toHaveBeenCalled();
      expect(f.load.refresh).not.toHaveBeenCalled();
    },
  );
  it("automatically installs the configured release when only an older stable agent exists", async () => {
    const f = setup();
    const oldId = await seedStable(f);
    const prepared = await f.coordinator.prepareForAdmission(f.target, "auto-update");
    expect(prepared).toMatchObject({ requestedVersion: artifact.version });
    expect(prepared.warning).toBeUndefined();
    const result = await f.admission.fresh(f.target, "auto-update", prepared);
    expect(result.state.current).toBe(prepared.requestedBuildId);
    expect(result.state.pins).toContainEqual({ owner: "stable-operation", buildId: oldId });
    expect(f.installArtifact).toHaveBeenCalledOnce();
    expect(f.load.refresh).toHaveBeenCalledOnce();
    await f.coordinator.prepareForAdmission(f.target, "auto-update");
    expect(f.load.refresh).toHaveBeenCalledOnce();
  });

  it.each(["metadata", "download", "health", "capacity"] as const)(
    "retains a verified stable agent and reports the %s failure",
    async (failureStage) => {
      const f = setup();
      const oldId = await seedStable(f);
      const failure =
        failureStage === "capacity"
          ? new RemoteAgentCapacityUnavailableError("waiting-for-capacity")
          : new Error(`${failureStage} failed`);
      if (failureStage === "metadata") f.load.refresh.mockRejectedValueOnce(failure);
      if (failureStage === "download") f.installArtifact.mockRejectedValueOnce(failure);
      if (failureStage === "capacity")
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
      if (failureStage === "health") f.handshake.mockRejectedValueOnce(failure);
      const prepared = await f.coordinator.prepareForAdmission(f.target, "old-agent");
      expect(prepared.warning).toBe(failure.message);
      expect(prepared.requestedVersion).toBe(
        failureStage === "metadata" ? undefined : artifact.version,
      );
      const connected = await f.admission.fresh(f.target, "old-agent", prepared);
      expect(connected.state.current).toBe(oldId);
      expect(connected.state.pins).toContainEqual({ owner: "stable-operation", buildId: oldId });
    },
  );

  it.each([true, false])(
    "propagates discovery failure without a verified stable runtime (legacy=%s)",
    async (legacy) => {
      const f = setup();
      if (legacy) await seedStable(f, false);
      const failure = new Error("release metadata unavailable");
      f.load.refresh.mockRejectedValueOnce(failure);
      await expect(f.coordinator.prepareForAdmission(f.target, "no-stable")).rejects.toBe(failure);
      expect(f.installArtifact).not.toHaveBeenCalled();
    },
  );

  it("updates a same-version build when the signed artifact identity changed", async () => {
    const f = setup();
    const previous = await seedStable(f, true, artifact.version);
    const prepared = await f.coordinator.prepareForAdmission(f.target, "same-version");
    expect(prepared.requestedVersion).toBe(artifact.version);
    expect(prepared.requestedBuildId).not.toBe(previous);
    const connected = await f.admission.fresh(f.target, "same-version", prepared);
    expect(connected.state.current).toBe(prepared.requestedBuildId);
    expect(f.installArtifact).toHaveBeenCalledOnce();
  });

  it("does not downgrade a newer stable runtime or warn about it", async () => {
    const f = setup();
    const oldId = await seedStable(f, true, "0.2.999");
    await expect(f.coordinator.prepareForAdmission(f.target, "no-downgrade")).resolves.toEqual({
      requestedBuildId: oldId,
      requestedVersion: "0.2.999",
    });
    expect(f.installArtifact).not.toHaveBeenCalled();
    expect((await f.control.registry.read()).current).toBe(oldId);
  });
  it.each(["proven-dead", "quarantined"] as const)(
    "does not reuse a stale ready update after its candidate becomes %s",
    async (failure) => {
      const f = setup();
      const oldId = await seedStable(f);
      const prepared = await f.coordinator.prepareForAdmission(f.target, "first-check");
      await f.control.registry.update((state) =>
        nextRemoteAgentRegistryRevision(
          state,
          failure === "proven-dead"
            ? {
                launches: state.launches.map((launch) =>
                  launch.buildId === prepared.requestedBuildId
                    ? { ...launch, phase: "proven-dead" as const }
                    : launch,
                ),
              }
            : {
                builds: state.builds.map((build) =>
                  build.id === prepared.requestedBuildId
                    ? { ...build, health: "quarantined" as const }
                    : build,
                ),
              },
        ),
      );
      const retry = await f.coordinator.prepareForAdmission(f.target, "second-check");
      expect(retry.warning).toMatch(/no longer running|quarantined/);
      const connected = await f.admission.fresh(f.target, "second-check", retry);
      expect(connected.state.current).toBe(oldId);
      expect(
        vi
          .mocked(f.control.run)
          .mock.calls.filter(([command]) => command.includes("printf launch-reserved")),
      ).toHaveLength(1);
    },
  );
});
