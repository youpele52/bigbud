import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  OrchestrationGetMessageTextChunkError,
  OrchestrationGetProjectWorktreePathsError,
  OrchestrationGetTurnActivitiesError,
  type GetMessageTextChunkInput,
  type GetProjectWorktreePathsInput,
  type GetTurnActivitiesInput,
} from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { Effect, Option } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

/** Bounded on-demand reads behind the thread view and project editing; never whole tables. */
export function makeDetailPagingWsRpcHandlers(context: WsRpcContext) {
  return {
    [ORCHESTRATION_WS_METHODS.getTurnActivities]: (input: GetTurnActivitiesInput) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnActivities,
        context.projectionCatalogQuery.getTurnActivities(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnActivitiesError({
                message: "Failed to load turn activities",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getMessageTextChunk]: (input: GetMessageTextChunkInput) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getMessageTextChunk,
        context.projectionCatalogQuery.getMessageTextChunk(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetMessageTextChunkError({
                message: "Failed to load message text",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new OrchestrationGetMessageTextChunkError({ message: "Message was not found." }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getProjectWorktreePaths]: (input: GetProjectWorktreePathsInput) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getProjectWorktreePaths,
        context.projectionCatalogQuery.getProjectWorktreePaths(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetProjectWorktreePathsError({
                message: "Failed to load project worktree paths",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
  };
}
