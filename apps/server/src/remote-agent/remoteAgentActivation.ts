import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { scheduleRemoteAgentCleanup } from "./remoteAgentInstall.maintenance.ts";
import { remoteAgentRuntimeSummary } from "./remoteAgentStatus.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "./remoteAgentUpdate.coordinator.ts";

/**
 * Fresh admission activates the newest prepared build for new connections. Shared by the
 * WebSocket connect action and the install operation used by the CLI and agent tools.
 */
export async function activateRemoteAgentFresh(
  executionTargetId: string,
  requestId: string,
  coordinator?: RemoteAgentUpdateCoordinatorShape,
) {
  const result = await remoteAgentAdmission.fresh(
    executionTargetId,
    requestId,
    async () => (await coordinator?.prepareForAdmission(executionTargetId, requestId)) ?? {},
  );
  coordinator?.enqueue({
    target: executionTargetId,
    trigger: "authenticated",
    authenticated: true,
  });
  const owner = result.state.admissions.find((entry) => entry.id === result.connectionId)!;
  scheduleRemoteAgentCleanup(executionTargetId);
  return {
    ...remoteAgentRuntimeSummary({
      ...result.state,
      current: owner.buildId,
      currentConnectionId: result.connectionId,
    }),
    connectionId: result.connectionId,
    currentBuildId: owner.buildId,
    currentVersion: result.state.builds.find((entry) => entry.id === owner.buildId)!.runtime
      .version,
  };
}
