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
import type { RemoteAgentInstallOperations } from "../remote-agent/remoteAgentInstall.operation.ts";

/**
 * Fresh admission from the app. With `replace` (the app's default) older builds are retired
 * through the shared install operations once the new build is active; a healthy fallback
 * activated nothing new, so it retires nothing. Retirement never affects the connection.
 */
export const connectRemoteAgentEffect = Effect.fn("connectRemoteAgentEffect")(function* (
  input: ServerConnectRemoteAgentInput,
  remoteAgentUpdateCoordinator?: RemoteAgentUpdateCoordinatorShape,
  operations?: Pick<RemoteAgentInstallOperations, "retireAfterActivation">,
): Effect.fn.Return<ServerConnectRemoteAgentResult, ServerInstallRemoteAgentError> {
  if (!isRemoteAgentConfigured())
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent connections are disabled.",
    });
  if (!isRemoteAgentExecutionTarget(input.executionTargetId))
    return yield* new ServerInstallRemoteAgentError({
      message: "This project uses Direct SSH. Select bigbud remote agent before connecting it.",
    });
  const connected = yield* Effect.tryPromise({
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
  if (!input.replace || !operations || connected.outcome === "fallback") return connected;
  const cleanup = yield* Effect.promise(() =>
    operations.retireAfterActivation(input.executionTargetId).catch(() => null),
  );
  if (!cleanup) return connected;
  return {
    ...connected,
    cleanupDeferred: cleanup.cleanupDeferred,
    ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
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
      ...(result.currentTargetTriple ? { currentTargetTriple: result.currentTargetTriple } : {}),
      ...(result.currentBuildDigestShort
        ? { currentBuildDigestShort: result.currentBuildDigestShort }
        : {}),
      ...(result.candidateTargetTriple
        ? { pendingTargetTriple: result.candidateTargetTriple }
        : {}),
      ...(result.candidateBuildDigestShort
        ? { pendingBuildDigestShort: result.candidateBuildDigestShort }
        : {}),
    };
  },
);
