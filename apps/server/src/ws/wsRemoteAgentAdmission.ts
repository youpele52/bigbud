import { Effect } from "effect";
import {
  ServerInstallRemoteAgentError,
  ServerGetRemoteAgentUpdateStatusError,
  type ServerConnectRemoteAgentInput,
  type ServerConnectRemoteAgentResult,
  type ServerGetRemoteAgentUpdateStatusInput,
  type ServerRemoteAgentUpdateStatus,
} from "@bigbud/contracts/server/server.ts";
import {
  remoteAgentAdmission,
  RemoteAgentAdmissionError,
} from "../remote-agent/remoteAgentAdmission.ts";
import { isRemoteAgentConfigured } from "../remote-agent/remoteAgentServerLayer.ts";
import { scheduleRemoteAgentCleanup } from "../remote-agent/remoteAgentInstall.maintenance.ts";
import { remoteAgentRuntimeSummary } from "../remote-agent/remoteAgentStatus.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "../remote-agent/remoteAgentUpdate.coordinator.ts";

export const connectRemoteAgentEffect = Effect.fn("connectRemoteAgentEffect")(function* (
  input: ServerConnectRemoteAgentInput,
  remoteAgentUpdateCoordinator?: RemoteAgentUpdateCoordinatorShape,
): Effect.fn.Return<ServerConnectRemoteAgentResult, ServerInstallRemoteAgentError> {
  if (!isRemoteAgentConfigured())
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent connections are disabled.",
    });
  const result = yield* Effect.tryPromise({
    try: () => remoteAgentAdmission.fresh(input.executionTargetId, input.requestId),
    catch: (cause) =>
      new ServerInstallRemoteAgentError({
        message:
          cause instanceof RemoteAgentAdmissionError
            ? cause.message
            : "Remote connection could not be verified. Existing work is unchanged.",
        cause,
      }),
  });
  remoteAgentUpdateCoordinator?.enqueue({
    target: input.executionTargetId,
    trigger: "authenticated",
    authenticated: true,
  });
  const owner = result.state.admissions.find((entry) => entry.id === result.connectionId)!;
  scheduleRemoteAgentCleanup(input.executionTargetId);
  return {
    ...remoteAgentRuntimeSummary({
      ...result.state,
      current: owner.buildId,
      currentConnectionId: result.connectionId,
    }),
    connectionId: result.connectionId,
    currentVersion: result.state.builds.find((entry) => entry.id === owner.buildId)!.runtime
      .version,
  };
});

export const getRemoteAgentUpdateStatusEffect = Effect.fn("getRemoteAgentUpdateStatusEffect")(
  function* (
    input: ServerGetRemoteAgentUpdateStatusInput,
    coordinator?: RemoteAgentUpdateCoordinatorShape,
  ): Effect.fn.Return<ServerRemoteAgentUpdateStatus, ServerGetRemoteAgentUpdateStatusError> {
    if (!coordinator)
      return yield* new ServerGetRemoteAgentUpdateStatusError({
        message: "Remote agent update status is unavailable in this server configuration.",
      });
    const result = yield* Effect.tryPromise({
      try: () => coordinator.getStatus(input.executionTargetId, input.reconnectRequestId),
      catch: (cause) =>
        new ServerGetRemoteAgentUpdateStatusError({
          message: "Remote agent update status could not be retrieved.",
          cause,
        }),
    });
    return {
      executionTargetId: result.executionTargetId,
      phase: result.phase === "ready-for-reconnect" ? "ready-for-next-reconnect" : result.phase,
      updateRequestId: result.requestId,
      reconnectRequestId: result.reconnectRequestId,
      reconnectOutcome: result.reconnectOutcome,
      currentVersion: result.currentVersion,
      pendingVersion: result.candidateVersion,
      predecessorVersion: result.predecessorVersion,
      reason: result.reason,
    };
  },
);
