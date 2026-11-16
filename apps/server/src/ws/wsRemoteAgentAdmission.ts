import { Effect } from "effect";
import {
  ServerInstallRemoteAgentError,
  ServerGetRemoteAgentUpdateStatusError,
  type ServerConnectRemoteAgentInput,
  type ServerConnectRemoteAgentResult,
  type ServerGetRemoteAgentUpdateStatusInput,
  type ServerRemoteAgentUpdateStatus,
} from "@bigbud/contracts/server/server.ts";
import { activateRemoteAgentFresh } from "../remote-agent/remoteAgentActivation.ts";
import { isRemoteAgentConfigured } from "../remote-agent/remoteAgentServerLayer.ts";
import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "../remote-agent/remoteAgentUpdate.coordinator.ts";
import { remoteAgentFailureMessage } from "../remote-agent/remoteAgentFailure.ts";

export const connectRemoteAgentEffect = Effect.fn("connectRemoteAgentEffect")(function* (
  input: ServerConnectRemoteAgentInput,
  remoteAgentUpdateCoordinator?: RemoteAgentUpdateCoordinatorShape,
): Effect.fn.Return<ServerConnectRemoteAgentResult, ServerInstallRemoteAgentError> {
  if (!isRemoteAgentConfigured())
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent connections are disabled.",
    });
  if (!isRemoteAgentExecutionTarget(input.executionTargetId))
    return yield* new ServerInstallRemoteAgentError({
      message: "This project uses Direct SSH. Select bigbud remote agent before connecting it.",
    });
  return yield* Effect.tryPromise({
    try: () =>
      activateRemoteAgentFresh(
        input.executionTargetId,
        input.requestId,
        remoteAgentUpdateCoordinator,
      ),
    catch: (cause) =>
      new ServerInstallRemoteAgentError({
        message: remoteAgentFailureMessage(cause),
        cause,
      }),
  });
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
