import { expect, it } from "vitest";

import { observeOwnedInstalledSupervisor } from "./remoteAgentComposition.installedObservation.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { makeProductionRemoteAgentProxyOwner } from "./remoteAgentConnection.owner.production.ts";
import { makeOwnerRemoteAgentInstallDependencies } from "./remoteAgentControl.owner.install.ts";
import { makeRemoteAgentOwnerExec } from "./remoteAgentControl.owner.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import {
  external,
  harnessShell,
  LABEL,
  liveReady,
  liveBuild,
  releaseMode,
  withOwner,
} from "./remoteAgentControl.owner.live.fixture.ts";

/**
 * U25 acceptance (live): normal-startup proxy binding. A registry runtime installed through the
 * owner is reached only through an owner proxy lease: the pinned observation (hello, identity
 * and epoch) and a full agent connection handshake. A tampered runtime digest is refused by the
 * owner's installed-agent recipe before `--proxy` runs. Local build, not release-trusted (E7).
 */
it.skipIf(!liveReady)(
  `observes and connects to the installed supervisor through an owner proxy lease (${LABEL})`,
  async () => {
    harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
    await withOwner(async (owner) => {
      const build = await liveBuild(0);
      const installer = makeRemoteAgentInstallManager({
        ...makeOwnerRemoteAgentInstallDependencies(owner.live),
        ...(releaseMode ? {} : { readArtifactBytes: async () => build.bytes }),
        referencedBuildIds: async () => new Set(),
      });
      await installer.install({ executionTargetId: owner.targetId, source: build.source });
      const control = await makeOwnerRemoteAgentInstallDependencies(owner.live).openControl!(
        owner.targetId,
      );
      const runtime = (await control.registry.read()).builds[0]!.runtime;
      const exec = makeRemoteAgentOwnerExec(owner.live, owner.targetId);
      const attemptId = `proxy-${runtime.generation}`;
      await exec({ kind: "isolatedLaunch", runtime, attemptId });
      const ready = await exec({
        kind: "supervisorObserve",
        mode: "candidateStartup",
        runtime,
        attemptId,
      });
      expect(ready.stdout.trim()).toBe("ready");
      const expectedEpoch = harnessShell(external!, `cat '${runtime.statePath}/epoch'`).trim();
      const proxyOwner = makeProductionRemoteAgentProxyOwner(owner.live);

      const observation = await observeOwnedInstalledSupervisor({
        executionTargetId: owner.targetId,
        runtime,
        expectedEpoch,
        owner: proxyOwner,
      });
      expect(observation.supervisorEpoch).toBe(expectedEpoch);
      expect(observation.agentInstanceId).toMatch(/\S/);

      const connection = await RemoteAgentConnection.ssh({
        executionTargetId: owner.targetId,
        runtime,
        owner: proxyOwner,
      });
      try {
        const hello = await connection.handshake();
        expect(hello.agentVersion).toBe(runtime.version);
        expect(hello.buildDigest).toBe(runtime.buildDigest);
        expect(hello.agentEpoch).toBe(expectedEpoch);
      } finally {
        connection.close();
      }

      await expect(
        observeOwnedInstalledSupervisor({
          executionTargetId: owner.targetId,
          runtime: {
            ...runtime,
            sha256: "f".repeat(64),
            binaryPath: runtime.binaryPath.replace(runtime.sha256, "f".repeat(64)),
          },
          expectedEpoch,
          owner: proxyOwner,
        }),
      ).rejects.toMatchObject({ reason: "observation-required" });

      expect((await exec({ kind: "supervisorShutdown", runtime })).stdout.trim()).toBe(
        "shutdown-accepted",
      );
      const exited = await exec({
        kind: "supervisorObserve",
        mode: "candidateExit",
        runtime,
        attemptId,
      });
      expect(["exited", "prior-boot-dead"]).toContain(exited.stdout.trim());
      expect((await exec({ kind: "socketGone", runtime })).stdout.trim()).toBe("exited");
      // Nothing of this account's agent may outlive the test (supervisor or proxy).
      expect(
        harnessShell(external!, "pgrep -u \"$(id -u)\" -f '[b]igbud-remote-agent' || true").trim(),
      ).toBe("");
    });
  },
  300_000,
);
