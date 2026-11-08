import * as Rpc from "effect/unstable/rpc/Rpc";

import { ORCHESTRATION_WS_METHODS } from "../constants/websocket.constant";
import {
  GetMessageTextChunkInput,
  GetMessageTextChunkResult,
  GetProjectWorktreePathsInput,
  GetProjectWorktreePathsResult,
  GetTurnActivitiesInput,
  GetTurnActivitiesResult,
  OrchestrationGetMessageTextChunkError,
  OrchestrationGetProjectWorktreePathsError,
  OrchestrationGetTurnActivitiesError,
} from "../orchestration/orchestration.detail.paging";

export const WsOrchestrationGetTurnActivitiesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getTurnActivities,
  {
    payload: GetTurnActivitiesInput,
    success: GetTurnActivitiesResult,
    error: OrchestrationGetTurnActivitiesError,
  },
);

export const WsOrchestrationGetMessageTextChunkRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getMessageTextChunk,
  {
    payload: GetMessageTextChunkInput,
    success: GetMessageTextChunkResult,
    error: OrchestrationGetMessageTextChunkError,
  },
);

export const WsOrchestrationGetProjectWorktreePathsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getProjectWorktreePaths,
  {
    payload: GetProjectWorktreePathsInput,
    success: GetProjectWorktreePathsResult,
    error: OrchestrationGetProjectWorktreePathsError,
  },
);
