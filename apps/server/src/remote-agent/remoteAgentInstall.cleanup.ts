import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  reconcileRemoteAgentStages,
  retainedRemoteAgentBuilds,
} from "./remoteAgentInstall.registry.transitions.ts";
import {
  reconcileRemoteAgentLaunchExits,
  reconcileRemoteAgentStages as reconcileRemoteAgentStageOwners,
} from "./remoteAgentInstall.reconcile.ts";
import { retireManagedRemoteAgentBuild } from "./remoteAgentInstall.retirement.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";
import { reconcileSupersededRemoteAgentConnections } from "./remoteAgentAdmission.references.ts";

/** Install-manager-owned binary cleanup. Unknown/live runtime reservations are never inferred dead. */
export async function cleanupRemoteAgentBuilds(
  control: RemoteAgentControl,
  referencedBuildIds?: () => Promise<ReadonlySet<string>>,
  target?: string,
): Promise<{ deleted: number; deferred: number }> {
  if (target) {
    try {
      await reconcileSupersededRemoteAgentConnections({
        bindings: remoteAgentOwners(),
        control,
        target,
      });
    } catch {
      // Missing local owner state or an unavailable remote read retains pins.
    }
  }
  await reconcileRemoteAgentLaunchExits(control);
  await reconcileRemoteAgentStageOwners(control);
  await control.registry.update(reconcileRemoteAgentStages);
  const snapshot = await control.registry.read();
  const retained = retainedRemoteAgentBuilds(snapshot);
  const durableReferences = referencedBuildIds ? await referencedBuildIds() : new Set<string>();
  const candidates = snapshot.builds
    .filter(
      (build) =>
        build.binary !== "absent" &&
        !retained.has(build.id) &&
        !durableReferences.has(build.id) &&
        (build.promotion === 0 ||
          snapshot.launches.some(
            (launch) => launch.buildId === build.id && launch.phase === "proven-dead",
          )),
    )
    .slice(0, 8);
  let deleted = 0;
  for (const candidate of candidates) {
    const result = await retireManagedRemoteAgentBuild({
      control,
      buildId: candidate.id,
      reservationId: `retire-${candidate.runtime.generation}`,
      referencedBuildIds: durableReferences,
    });
    if (result === "deleted") deleted++;
  }
  return { deleted, deferred: retained.size };
}
