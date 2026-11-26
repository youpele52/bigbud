import { runRemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentUpdateCoordinatorDependencies } from "./remoteAgentUpdate.coordinator.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import { isDefinitiveRemoteAgentUpdateFailure } from "./remoteAgentUpdate.prepare.ts";
import { launchAttemptId } from "./remoteAgentUpdate.prepare.scripts.ts";
import { markRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import { quarantineRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { reconcileRemoteAgentLaunchExits } from "./remoteAgentInstall.reconcile.ts";

export function markUpdateFailure(
  state: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
  artifact: Pick<RemoteAgentRuntime, "version" | "sha256" | "buildDigest" | "targetTriple">,
  cause: unknown,
): RemoteAgentRegistry {
  const prior = state.updates.find((entry) => entry.requestId === requestId);
  return markRemoteAgentUpdate(state, {
    requestId,
    buildId,
    phase: isDefinitiveRemoteAgentUpdateFailure(cause) ? "failed" : "uncertain",
    outcome: isDefinitiveRemoteAgentUpdateFailure(cause) ? "failed" : "uncertain",
    reason: remoteAgentFailureDetail(cause),
    identity: {
      version: artifact.version,
      sha256: artifact.sha256,
      buildDigest: artifact.buildDigest,
      targetTriple: artifact.targetTriple,
    },
    ...(prior?.epoch ? { epoch: prior.epoch } : {}),
  });
}

export async function bestEffortFailedCandidateCleanup(
  target: string,
  control: RemoteAgentControl,
  manager: NonNullable<RemoteAgentUpdateCoordinatorDependencies["installManager"]>,
  buildId: string,
): Promise<void> {
  let state = await control.registry.read();
  const build = state.builds.find((entry) => entry.id === buildId);
  if (!build) return;
  await control.registry.update((current) => quarantineRemoteAgentBuild(current, buildId));
  await reconcileRemoteAgentLaunchExits(control, { buildId });
  state = await control.registry.read();
  const launch = state.launches.find((entry) => entry.buildId === buildId);
  if (launch && launch.phase !== "proven-dead") {
    try {
      const result = await runRemoteAgentControlOp(control, {
        kind: "supervisorShutdown",
        runtime: build.runtime,
      });
      if (result.trim() === "shutdown-accepted") {
        const exited = await runRemoteAgentControlOp(control, {
          kind: "supervisorObserve",
          mode: "candidateExit",
          runtime: build.runtime,
          attemptId: launch.attemptId ?? launchAttemptId(build.runtime),
        });
        if (exited.trim() === "exited" || exited.trim() === "prior-boot-dead")
          await reconcileRemoteAgentLaunchExits(control, { buildId });
      }
    } catch {
      return;
    }
  }
  state = await control.registry.read();
  if (state.launches.some((entry) => entry.buildId === buildId && entry.phase !== "proven-dead"))
    return;
  await control.registry.update((current) => quarantineRemoteAgentBuild(current, buildId));
  if (manager.cleanup) await manager.cleanup(target).catch(() => undefined);
}
