import { expect, it } from "vitest";

import { remoteAgentRuntimeEqual } from "./remoteAgentRuntime.ts";
import { makeOwnerRemoteAgentInstallDependencies } from "./remoteAgentControl.owner.install.ts";
import { makeRemoteAgentOwnerExec } from "./remoteAgentControl.owner.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import {
  external,
  harnessShell,
  LABEL,
  liveReady,
  liveBuild,
  releaseMode,
  type LiveBuild,
  withOwner,
  type OwnerLive,
} from "./remoteAgentControl.owner.live.fixture.ts";

/**
 * U25 acceptance (live): the unchanged legacy install manager and control modules run on the
 * production owner. Install, update, two-slot capacity with retirement, orphan reconcile, inbox
 * adoption, status/control and removal, all through typed `agent_control` leases.
 * Agent bytes: local build, not release-trusted (E7 open).
 */
function manager({ live }: OwnerLive, builds: ReadonlyArray<LiveBuild>) {
  return makeRemoteAgentInstallManager({
    ...makeOwnerRemoteAgentInstallDependencies(live),
    // Release mode keeps the normal artifact download; local builds are read from disk.
    ...(releaseMode
      ? {}
      : {
          readArtifactBytes: async (artifact: { readonly sha256: string }) =>
            builds.find((build) => build.artifact.sha256 === artifact.sha256)!.bytes,
        }),
    referencedBuildIds: async () => new Set(),
    terminalOwners: async () => ({ owners: [], truncated: false }),
  });
}

it.skipIf(!liveReady)(
  `installs, updates, retires, reclaims, adopts, controls and removes through the owner (${LABEL})`,
  async () => {
    harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
    await withOwner(async (owner) => {
      const builds = await Promise.all([0, 1, 2].map(liveBuild));
      const installer = manager(owner, builds);
      const exec = makeRemoteAgentOwnerExec(owner.live, owner.targetId);
      const control = await makeOwnerRemoteAgentInstallDependencies(owner.live).openControl!(
        owner.targetId,
      );
      const [first, second, third] = builds;

      // Install: 6.9 MB streamed on the lease socket (no 48 KiB frame), verified remotely.
      const installed = await installer.install({
        executionTargetId: owner.targetId,
        source: first!.source,
      });
      expect(installed).toMatchObject({ status: "staged", placement: "upload" });
      const placed = await exec({ kind: "placedProbe", artifact: first!.artifact });
      expect(placed.stdout.trim()).toBe("managed");
      const registry = await control.registry.read();
      const build = registry.builds.find(
        (entry) => entry.runtime.sha256 === first!.artifact.sha256,
      );
      expect(build?.binary).toBe("present");
      expect(build?.runtime.binaryPath).toBe(
        `${control.root}/bin/${first!.artifact.version}/${first!.artifact.sha256}/bigbud-remote-agent`,
      );

      // Read-only status (D1/D5 evidence) sees the managed build without mutating anything.
      const status = await exec({ kind: "readOnlyStatus" });
      expect(
        parseRemoteAgentRegistry(status.stdout).builds.some((entry) =>
          remoteAgentRuntimeEqual(entry.runtime, build!.runtime),
        ),
      ).toBe(true);

      // Retirement deletion: the exact guarded unlink of this runtime's bytes. (The registry
      // policy that decides when a staged build may retire is the unchanged legacy logic.)
      const probe = async () =>
        (await exec({ kind: "placedProbe", artifact: first!.artifact })).stdout.trim();
      expect(
        (await exec({ kind: "retirementDelete", runtime: build!.runtime })).stdout.trim(),
      ).toBe("deleted");
      expect(await probe()).toBe("absent");
      expect((await exec({ kind: "stateAbsent", runtime: build!.runtime })).stdout.trim()).toBe(
        "absent",
      );
      const fresh = () => harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');

      // Inbox adoption: bytes placed by hand are verified and promoted without an upload.
      fresh();
      const inbox = `.bigbud/agent/inbox/${first!.artifact.sha256}`;
      harnessShell(
        external!,
        `umask 077; mkdir -p "$HOME/${inbox}" && cat > "$HOME/${inbox}/bigbud-remote-agent"`,
        first!.bytes,
      );
      const adopted = await installer.install({
        executionTargetId: owner.targetId,
        source: first!.source,
      });
      expect(adopted.placement).toBe("inbox");
      expect(await probe()).toBe("managed");

      // Update: the second build takes the second storage slot.
      await installer.install({ executionTargetId: owner.targetId, source: second!.source });
      expect((await control.inventory!()).uniqueDigests.size).toBe(2);

      // Two-slot capacity (legacy parity): both slots hold slot-reserved builds, so a third
      // install waits for retirement instead of deleting anything.
      await expect(
        installer.install({ executionTargetId: owner.targetId, source: third!.source }),
      ).rejects.toBeInstanceOf(RemoteAgentCapacityUnavailableError);
      expect(await probe()).toBe("managed");

      // Orphan reconcile: an unregistered copy of the first build occupies a slot; the next
      // install reclaims it to make room for the third build.
      fresh();
      await exec({
        kind: "installUpload",
        artifact: first!.artifact,
        reservationId: null,
        bytes: first!.bytes,
      });
      await installer.install({ executionTargetId: owner.targetId, source: second!.source });
      expect(await probe()).toBe("managed");
      const reclaimed = await installer.install({
        executionTargetId: owner.targetId,
        source: third!.source,
      });
      expect(reclaimed.placement).toBe("upload");
      expect(await probe()).toBe("absent");
      const slots = await control.inventory!();
      expect([...slots.uniqueDigests].toSorted()).toEqual(
        [second!.artifact.sha256, third!.artifact.sha256].toSorted(),
      );

      // Control: launch the newest staged runtime in isolation, observe readiness, stop it, observe exit.
      const runtime = (await control.registry.read()).builds.find(
        (entry) => entry.runtime.sha256 === third!.artifact.sha256,
      )!.runtime;
      const attemptId = `live-${runtime.generation}`;
      expect((await exec({ kind: "isolatedLaunch", runtime, attemptId })).stdout.trim()).toBe(
        "launch-reserved",
      );
      const ready = await exec({
        kind: "supervisorObserve",
        mode: "candidateStartup",
        runtime,
        attemptId,
      });
      expect(ready.stdout.trim()).toBe("ready");
      expect((await exec({ kind: "socketLive", runtime })).stdout.trim()).toBe("socket");
      const stopped = await exec({ kind: "supervisorShutdown", runtime });
      expect(stopped.stdout.trim()).toBe("shutdown-accepted");
      const exited = await exec({
        kind: "supervisorObserve",
        mode: "candidateExit",
        runtime,
        attemptId,
      });
      expect(["exited", "prior-boot-dead"]).toContain(exited.stdout.trim());
      expect((await exec({ kind: "socketGone", runtime })).stdout.trim()).toBe("exited");

      // The staged updates above are still owned by this live controller, so removal refuses
      // with typed stage blockers (legacy parity) and deletes nothing.
      const blocked = await installer.remove({ executionTargetId: owner.targetId });
      expect(blocked).toMatchObject({ outcome: "blocked" });
      expect(await probe()).toBe("absent");
      expect((await control.inventory!()).uniqueDigests.size).toBe(2);
      // Removal: with no live stage, the whole agent tree goes under the registry removal fence.
      fresh();
      await exec({
        kind: "installUpload",
        artifact: first!.artifact,
        reservationId: null,
        bytes: first!.bytes,
      });
      const removal = await installer.remove({ executionTargetId: owner.targetId });
      expect(removal).toEqual({ outcome: "removed" });
      expect(
        harnessShell(
          external!,
          'test -e "$HOME/.bigbud/agent" && echo present || echo gone',
        ).trim(),
      ).toBe("gone");
      expect(
        harnessShell(external!, "pgrep -u \"$(id -u)\" -f '[b]igbud-remote-agent' || true").trim(),
      ).toBe("");
    });
  },
  600_000,
);
