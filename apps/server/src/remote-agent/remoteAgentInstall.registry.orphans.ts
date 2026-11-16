import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { remoteAgentBuildIsReferenced } from "./remoteAgentInstall.registry.references.ts";

/** Metadata-only repair inside the caller's CAS; never infer absence from age or a missing socket. */
export function withoutCompletedRetirementClaims(
  state: RemoteAgentRegistry,
  buildId?: string,
): RemoteAgentRegistry["updates"] {
  let removed = 0;
  const updates = state.updates.filter((update) => {
    if (removed >= 8 || (buildId !== undefined && update.buildId !== buildId)) return true;
    if (update.phase !== "reserved" || update.outcome !== "capacity") return true;
    const build = state.builds.find((entry) => entry.id === update.buildId);
    if (!build || build.runtime.origin !== "managed" || build.binary !== "absent") return true;
    if (
      ![
        `retire-replace-${build.runtime.generation}`,
        `retire-update-${build.runtime.generation}`,
      ].includes(update.requestId)
    )
      return true;
    if (
      state.predecessor === build.id ||
      state.retirementReservations.some((entry) => entry.buildId === build.id) ||
      state.slotReservations.some(
        (entry) => entry.buildId === build.id && entry.phase !== "released",
      ) ||
      remoteAgentBuildIsReferenced(state, build.id, {
        retirementId: update.requestId,
        ignoreAcknowledgedStages: true,
      })
    )
      return true;
    removed++;
    return false;
  });
  return removed ? updates : state.updates;
}
