import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { quarantineRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { markRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";

/** Quarantine and its diagnostic are one atomic registry transition. */
export function markRemoteAgentAdmissionFailure(
  current: RemoteAgentRegistry,
  buildId: string,
  requestId: string,
  cause: unknown,
): RemoteAgentRegistry {
  return markRemoteAgentUpdate(
    { ...quarantineRemoteAgentBuild(current, buildId), revision: current.revision },
    {
      requestId: current.updates.find((entry) => entry.buildId === buildId)?.requestId ?? requestId,
      buildId,
      phase: "failed",
      outcome: "failed",
      reason: remoteAgentFailureDetail(cause),
    },
  );
}
