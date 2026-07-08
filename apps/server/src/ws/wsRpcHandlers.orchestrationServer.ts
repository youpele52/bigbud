import { Effect, Schema, Stream } from "effect";
import {
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationReplayEventsError,
  ORCHESTRATION_WS_METHODS,
  ProjectDirectoryWatchError,
  WS_METHODS,
} from "@bigbud/contracts";
import { clamp } from "effect/Number";

import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";
import type { WsRpcContext } from "./wsRpcContext";
import {
  makeServerWsRpcHandlers,
  makeWorkspaceWsRpcHandlers,
} from "./wsRpcHandlers.orchestrationServer.helpers";
import {
  makeOrderedOrchestrationDomainEventStream,
  makeThinkingActivityDeltaStream,
} from "./wsStreams";

export function makeWsRpcOrchestrationServerHandlers(context: WsRpcContext) {
  const toProjectDirectoryWatchError = (
    cause: WorkspaceFileSystemError | WorkspacePathOutsideRootError,
  ) => {
    const message = Schema.is(WorkspacePathOutsideRootError)(cause)
      ? "Workspace directory path must stay within the project root."
      : `Failed to watch workspace directory: ${cause.detail}`;
    return new ProjectDirectoryWatchError({ message, cause });
  };

  return {
    [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input: unknown) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getSnapshot,
        context.projectionSnapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (
      command: Parameters<WsRpcContext["normalizeDispatchCommand"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        Effect.gen(function* () {
          const normalizedCommand = yield* context.normalizeDispatchCommand(command);
          if (normalizedCommand.type === "thread.shell.run") {
            return yield* context.dispatchShellCommand(normalizedCommand);
          }
          const result = yield* context.dispatchNormalizedCommand(normalizedCommand);
          if (normalizedCommand.type === "thread.archive") {
            yield* context.terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to close thread terminals after archive", {
                  threadId: normalizedCommand.threadId,
                  error: error.message,
                }),
              ),
            );
          }
          return result;
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getTurnDiff]: (
      input: Parameters<WsRpcContext["checkpointDiffQuery"]["getTurnDiff"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        context.checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (
      input: Parameters<WsRpcContext["checkpointDiffQuery"]["getFullThreadDiff"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        context.checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.replayEvents]: (input: { readonly fromSequenceExclusive: number }) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.replayEvents,
        Stream.runCollect(
          context.orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeOrchestrationDomainEvents,
        makeOrderedOrchestrationDomainEventStream({
          orchestrationEngine: context.orchestrationEngine,
        }),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.subscribeThinkingActivityDeltas]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeThinkingActivityDeltas,
        makeThinkingActivityDeltaStream({
          providerService: context.providerService,
          serverSettings: context.serverSettings,
        }),
        { "rpc.aggregate": "orchestration" },
      ),
    ...makeServerWsRpcHandlers(context),
    ...makeWorkspaceWsRpcHandlers(context, toProjectDirectoryWatchError),
  };
}
